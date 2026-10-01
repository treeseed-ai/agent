import { expect, it } from 'vitest';
import { observeReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { run } from '../../../../src/sandbox/process-runner.ts';

it('retains bounded redacted stdout and stderr from a real failed runner replay', async () => {
	const secret = 'assignment-private-value';
	const program = `console.log('noise'.repeat(1000)); console.log('FAIL tests/contract/example.test.ts > exact assertion ${secret} https://private.example/path Bearer hidden-token'); console.error('AssertionError: expected stable order ${secret}'); process.exit(1);`;
	const command = 'node -e "process.exit(1)"';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Claimed pass',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Contract replay', commands: [command] }] };
	const failure = await observeReportedActivityCommands(report, [secret],
		(_executable, _args, options) => run(process.execPath, ['-e', program], { ...options, cwd: import.meta.dirname }))
		.catch((error: unknown) => error instanceof Error ? error.message : String(error));
	expect(typeof failure).toBe('string');
	expect(failure).toContain('Runner-observed verification failed (exit 1)');
	expect(failure).toContain('FAIL tests/contract/example.test.ts > exact assertion [redacted]');
	expect(failure).toContain('AssertionError: expected stable order [redacted]');
	expect(failure).not.toContain(secret);
	expect(failure).not.toContain('https://private.example');
	expect(failure).not.toContain('Bearer hidden-token');
	expect(String(failure).length).toBeLessThan(2500);
});

it('keeps successful observations and digests unchanged', async () => {
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Pass',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Check', commands: ['node -e "console.log(42)"'] }] };
	const result = await observeReportedActivityCommands(report, [],
		(_executable, _args, options) => run(process.execPath, ['-e', 'console.log(42)'], { ...options, cwd: import.meta.dirname }));
	expect(result.report).toEqual(report);
	expect(result.verification).toEqual([expect.objectContaining({ command: report.verification[0]!.commands[0],
		status: 'passed', exitCode: 0, outputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })]);
});
