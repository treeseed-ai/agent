import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityCompletionReport } from '../activity-completion.ts';
import { correctObservedTestFirstRedVerification, isReleaseReview, reportedVerificationCommands, record, text } from './guest-contract.ts';
import { run } from './process-runner.ts';
import { redactProviderDiagnostic } from './provider-failure.ts';
import type { VerificationResult } from '../kernel/contracts.ts';

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
	const commands = reportedVerificationCommands(report);
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
	for (const command of commands) {
		const started = process.hrtime.bigint(); let failedOutput = '';
		try {
			const output = await execute('/bin/sh', ['-c', command], { cwd: '/workspace/project', captureStdout: true,
				maxStdoutBytes: 8_388_608, timeoutMs: 120_000,
				onLine: line => { failedOutput = `${failedOutput}\n${redactProviderDiagnostic(line, secrets)}`.slice(-1_024); } });
			verification.push({ command, status: 'passed' as const, exitCode: 0,
				outputDigest: objectDigest({ stdout: output.stdout, stderr: output.stderr }),
				durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const exit = /exited (\d+)/u.exec(message)?.[1] ?? 'unknown';
			const diagnostics = `${redactProviderDiagnostic(error, secrets)}; ${failedOutput}`;
			const observed = record(error);
			const output = `${text(observed.stdout)}\n${text(observed.stderr)}`.replace(/\u001b\[[0-9;]*m/gu, '');
			// Only actual assertion failures are test-first red evidence. Setup failures,
			// killed processes and unknown exits remain fatal even in a test-first scope.
			if (observed.exitCode === 1 && /\bFAIL\s+\S+\.test\.tsx?\s+>/u.test(output) && /\bAssertionError\b/u.test(output)
				&& !/Cannot find module|Failed to load|heap out of memory|Unhandled Error|SyntaxError|TypeError|ReferenceError|timed?\s*out|timeout|\bskipped\b|\btodo\b/iu.test(output)) {
				const corrected = correctObservedTestFirstRedVerification(report,
					[{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 1 } }],
					text(assignment.agentClass), text(record(assignment.effectiveProfile).activity), assignment.acceptanceCriteria);
				if (corrected.verification.some((entry, index) => entry.status === 'failed' && report.verification[index]?.status === 'passed')) {
					report = { ...corrected, summary: `${corrected.summary}\nRunner-observed test-first red: ${redactProviderDiagnostic(command, secrets)} (exit 1); ${diagnostics}`,
						verification: corrected.verification.map((entry, index) => entry.status === 'failed'
						&& report.verification[index]?.status === 'passed' ? { ...entry, summary: `${entry.summary} ${diagnostics}` } : entry) };
					verification.push({ command, status: 'failed', exitCode: 1,
						outputDigest: objectDigest({ stdout: observed.stdout, stderr: observed.stderr }),
						durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) });
					continue;
				}
			}
			throw new Error(`Runner-observed verification failed (exit ${exit}): ${redactProviderDiagnostic(command, secrets)}; ${diagnostics}`);
		}
	}
	return { report, verification };
}

export function requiresNodeDependencyRestore(command: string) {
	return /^(?:npm\s+(?:run|exec|test)(?:\s|$)|npx(?:\s|$))/u.test(command.trim());
}

/** Fresh Reviewer execution, not a cache of the predecessor's passing receipts. */
export async function prepareReleaseReview(context: Record<string, unknown>, secrets: string[] = [], execute: typeof run = run) {
	const canonicalContext = record(context.canonicalAssignmentContext), assignment = record(canonicalContext.assignment);
	if (!isReleaseReview(assignment)) return null;
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
			return { report: completion, verification: [...observed.verification, ...additional.verification] };
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
