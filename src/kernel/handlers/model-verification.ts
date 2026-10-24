import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assignmentProposalSource, type ActivityCompletionReport } from '../../activity-completion.ts';
import { correctObservedTestFirstRedVerification, isTestFirstVerification, isReleaseReview, reportedVerificationCommands, record, text } from './model-workload-contract.ts';
import { run } from '../../sandbox/process-runner.ts';
import { redactProviderDiagnostic } from '../../sandbox/provider-failure.ts';
import type { VerificationResult } from '../contracts.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
export const objectDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

/** Convert model-reported passing checks into runner-observed evidence. */
export async function verifyReportedActivityCommands(report: ActivityCompletionReport,
	execute: (command: string) => Promise<void> = async (command) => {
		await run('/bin/sh', ['-c', command], { cwd: '/workspace/project', timeoutMs: 120_000 });
	}) {
	for (const command of reportedVerificationCommands(report)) {
		try { await execute(command); }
		catch { throw new Error(`Runner-observed verification failed: ${command}`); }
	}
	return report;
}

export async function observeReportedActivityCommands(report: ActivityCompletionReport, secrets: string[] = [],
	execute: typeof run = run, assignment: Record<string, unknown> = {}) {
	const commands = reportedVerificationCommands(report, true);
	if (commands.some(requiresNodeDependencyRestore)
		&& await stat('/workspace/project/package-lock.json').then(() => true, () => false)
		&& !await stat('/workspace/project/node_modules/.bin/vitest').then(() => true, () => false)) {
		try { await execute('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
			{ cwd: '/workspace/project', timeoutMs: 120_000 }); }
		catch (error) {
			const exit = /exited (\d+)/u.exec(error instanceof Error ? error.message : String(error))?.[1] ?? 'unknown';
			throw new Error(`Runner verification dependency restore failed (exit ${exit}).`);
		}
	}
	const verification: VerificationResult[] = [];
	const observations: Array<VerificationResult & { stdout: string; stderr: string }> = [];
	for (const command of commands) {
		const claims = report.verification.filter(entry => entry.commands.some(candidate => candidate.trim() === command.trim()));
		const authoredFailure = claims.length > 0 && claims.every(entry => entry.status === 'failed');
		const started = process.hrtime.bigint(); let failedOutput = '';
		try {
			const output = await execute('/bin/sh', ['-c', command], { cwd: '/workspace/project', captureStdout: true,
				maxStdoutBytes: 8_388_608, timeoutMs: 120_000,
				onLine: line => { failedOutput = `${failedOutput}\n${redactProviderDiagnostic(line, secrets)}`.slice(-1_024); } });
			if (authoredFailure) throw Object.assign(new Error('Reported failed verification exited 0'), { exitCode: 0, ...output });
			const receipt: VerificationResult = { command, status: 'passed', exitCode: 0,
				outputDigest: objectDigest({ stdout: output.stdout, stderr: output.stderr }),
				durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) };
			verification.push(receipt); observations.push({ ...receipt, stdout: output.stdout, stderr: output.stderr });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const exit = /exited (\d+)/u.exec(message)?.[1] ?? 'unknown';
			const diagnostics = `${redactProviderDiagnostic(error, secrets)}; ${failedOutput}`;
			const observed = record(error);
			// A declared failed check is factual command evidence, not an inferred
			// assertion-only test or a passing product gate. The process boundary
			// distinguishes a completed nonzero exit from timeout/signal/cleanup.
			if (authoredFailure && observed.code === 'subprocess_nonzero_exit'
				&& Number.isInteger(observed.exitCode) && Number(observed.exitCode) > 0 && Number(observed.exitCode) <= 255
				&& typeof observed.stdout === 'string' && typeof observed.stderr === 'string') {
				const receipt: VerificationResult = { command, status: 'failed', exitCode: Number(observed.exitCode),
					outputDigest: objectDigest({ stdout: observed.stdout, stderr: observed.stderr }),
					durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) };
				verification.push(receipt); observations.push({ ...receipt, stdout: observed.stdout, stderr: observed.stderr });
				continue;
			}
			const output = `${text(observed.stdout)}\n${text(observed.stderr)}`.replace(/\u001b\[[0-9;]*m/gu, '');
			// Only actual assertion failures are test-first red evidence. Setup failures,
			// killed processes and unknown exits remain fatal even in a test-first scope.
			if (!authoredFailure && isTestFirstVerification(text(record(assignment.effectiveProfile).activity), assignment.acceptanceCriteria, command) && observed.exitCode === 1 && typeof observed.stdout === 'string' && typeof observed.stderr === 'string'
				&& /\bFAIL\s+\S+\.test\.tsx?\s+>/u.test(output) && /\bAssertionError\b/u.test(output)
				&& !/Cannot find module|Failed to load|heap out of memory|Unhandled Error|SyntaxError|TypeError|ReferenceError|timed?\s*out|timeout|\bskipped\b|\btodo\b/iu.test(output)) {
				const corrected = correctObservedTestFirstRedVerification(report,
					[{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 1 } }],
					text(assignment.agentClass), text(record(assignment.effectiveProfile).activity), assignment.acceptanceCriteria);
				if (corrected.verification.some(entry => entry.status === 'failed' && entry.commands.length === 1 && entry.commands[0]!.trim() === command.trim())) {
					report = { ...corrected, summary: `${corrected.summary}\nRunner-observed test-first red: ${redactProviderDiagnostic(command, secrets)} (exit 1); ${diagnostics}`,
						verification: corrected.verification.map(entry => entry.status === 'failed'
						&& entry.commands.length === 1 && entry.commands[0]!.trim() === command.trim() ? { ...entry, summary: `${entry.summary} ${diagnostics}` } : entry) };
					const receipt: VerificationResult = { command, status: 'failed', exitCode: 1,
						outputDigest: objectDigest({ stdout: observed.stdout, stderr: observed.stderr }),
						durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) };
					verification.push(receipt); observations.push({ ...receipt, stdout: observed.stdout, stderr: observed.stderr });
					continue;
				}
			}
			throw new Error(`Runner-observed verification failed (exit ${exit}): ${redactProviderDiagnostic(command, secrets)}; ${diagnostics}`);
		}
	}
	return { report, verification, observations };
}

export function requiresNodeDependencyRestore(command: string) {
	return /^(?:npm\s+(?:run|exec|test)(?:\s|$)|npx(?:\s|$))/u.test(command.trim());
}

export async function prepareNodeWorkspace(
	root = '/workspace/project',
	proxyUrl?: string,
	execute: (executable: string, args: string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<unknown>
		= (executable, args, options) => run(executable, args, options),
) {
	const hasLock = await stat(resolve(root, 'package-lock.json')).then(() => true, () => false);
	const hasManifest = await stat(resolve(root, 'package.json')).then(() => true, () => false);
	const hasModules = await stat(resolve(root, 'node_modules')).then(() => true, () => false);
	if (!hasLock || !hasManifest || hasModules) return false;
	await execute('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
		cwd: root, timeoutMs: 120_000,
		env: { ...process.env, TREESEED_SKIP_PACKAGE_PREPARE: '1',
			...(proxyUrl ? { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl,
			GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
			GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
			} : {}),
		},
	});
	return true;
}

/** Fresh Reviewer execution, not a cache of the predecessor's passing receipts. */
export async function prepareReleaseReview(context: Record<string, unknown>, secrets: string[] = [], execute: typeof run = run) {
	const canonicalContext = record(context.canonicalAssignmentContext), assignment = record(canonicalContext.assignment);
	const workItems = text(record(assignment.sourceRef).model) === 'proposal' && text(assignment.workItemId)
		? record(assignmentProposalSource(canonicalContext).executionPlan).workItems : undefined;
	const workItem = Array.isArray(workItems) ? workItems.map(record).find(item => item.id === assignment.workItemId) : undefined;
	if (!isReleaseReview(assignment, workItem)) return null;
	const source = record(record(context.projectManifest).source), commit = text(source.commit), repository = text(source.repositoryId);
	if (!repository || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error('release_review_candidate_missing');
	const ids = Array.isArray(assignment.predecessorResultIds) ? assignment.predecessorResultIds : [];
	const candidates = (Array.isArray(canonicalContext.predecessorResults) ? canonicalContext.predecessorResults : []).map(record)
		.filter(result => ids.includes(result.id) && result.status === 'completed'
			&& Array.isArray(result.references) && result.references.map(record).some(ref =>
				ref.kind === 'git' && ref.repository === repository && ref.commit === commit));
	if (candidates.length !== 1) throw new Error('release_review_actor_candidate_mismatch');
	const inventory = Array.isArray(candidates[0]!.verification) ? candidates[0]!.verification.map(record) : [];
	if (!inventory.length || inventory.some(entry => entry.status !== 'passed' || entry.exitCode !== 0)) {
		throw new Error('release_review_passing_command_inventory_missing');
	}
	const report: ActivityCompletionReport = { schemaVersion: 'treeseed.activity-completion/v1',
		summary: 'Independent release verification in the current Reviewer guest.', reviewDisposition: null, contentOutput: null,
		verification: inventory.map(entry => ({ status: 'passed', summary: 'Command inventory only; execute independently.', commands: [text(entry.command)] })) };
	const commands = reportedVerificationCommands(report);
	if (commands.some(command => /\bnpm\s+pack\b/u.test(command) && command !== 'npm pack')) {
		throw new Error('release_review_pack_must_use_current_directory');
	}
	await assertReviewCandidate(commit, execute);
	const observed = await observeReportedActivityCommands(report, secrets, execute, assignment);
	await assertReviewCandidate(commit, execute);
	// This closure owns ONLY receipts measured in this guest on this candidate.
	// It is never populated from model input or a previous attempt's output.
	return { verification: observed.verification,
		async complete(completion: ActivityCompletionReport) {
			await assertReviewCandidate(commit, execute);
			reportedVerificationCommands(completion); // Validate even commands already observed here.
			if (completion.verification.some(entry => entry.status === 'failed' && entry.commands.some(command => commands.includes(command)))) {
				throw new Error('release_review_verification_changed');
			}
			const additional = await observeReportedActivityCommands({ ...completion, verification: completion.verification.map(entry =>
				({ ...entry, commands: entry.commands.filter(command => !commands.includes(command)) })) }, secrets, execute, assignment);
			await assertReviewCandidate(commit, execute);
			return { report: completion, verification: [...observed.verification, ...additional.verification],
				observations: [...observed.observations, ...additional.observations] };
		} };
}

async function assertReviewCandidate(commit: string, execute: typeof run) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-review-index-'));
	const env = { PATH: '/usr/bin:/bin', GIT_INDEX_FILE: join(root, 'index'), GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
	const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
	const options = { cwd: '/workspace/project', env, timeoutMs: 10_000, captureStdout: true, maxStdoutBytes: 1_048_576 };
	try {
		const head = await execute('/usr/bin/git', [...args, 'rev-parse', '--verify', 'HEAD^{commit}'], options);
		if (head.stdout.trim() !== commit) throw new Error('release_review_candidate_head_changed');
		await execute('/usr/bin/git', [...args, 'read-tree', commit], options);
		const status = await execute('/usr/bin/git', [...args, 'status', '--porcelain', '--untracked-files=all'], options);
		if (status.stdout.trim()) throw new Error('release_review_candidate_source_changed');
	} finally { await rm(root, { recursive: true, force: true }); }
}
