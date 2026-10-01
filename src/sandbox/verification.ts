import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { ActivityCompletionReport } from '../activity-completion.ts';
import { correctObservedTestFirstRedVerification, reportedVerificationCommands, record, text } from './guest-contract.ts';
import { run } from './process-runner.ts';
import { redactProviderDiagnostic } from './provider-failure.ts';
import type { VerificationResult } from '../kernel/contracts.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
export const objectDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

/** Convert model-reported passing checks into runner-observed evidence. */
export async function verifyReportedActivityCommands(report: ActivityCompletionReport,
	execute: (command: string) => Promise<void> = async (command) => {
		await run('/bin/sh', ['-lc', command], { cwd: '/workspace/project', timeoutMs: 120_000 });
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
			const output = await execute('/bin/sh', ['-lc', command], { cwd: '/workspace/project', captureStdout: true,
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
				&& !/Cannot find module|Failed to load|heap out of memory|Unhandled Error/iu.test(output)) {
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
