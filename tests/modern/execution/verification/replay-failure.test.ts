import { expect, it } from 'vitest';
import { observeReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { run } from '../../../../src/sandbox/process-runner.ts';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('retains actual runner assertion failures as failed evidence in scoped test-first review', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'agent296-red-'));
	const command = 'npx vitest run tests/unit/example.test.ts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Exact red suite reviewed',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Red suite inspected', commands: [command] }] };
	try {
		await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir');
		await writeFile(resolve(directory, 'example.test.ts'), "import { expect, it } from 'vitest';\nit('rejects duplicate decisions', () => expect([]).toEqual(['decision_selection_invalid']));\n");
		for (const [agentClass, activity] of [['reviewer', 'reviewing'], ['tester', 'acting']]) {
			const result = await observeReportedActivityCommands(report, [],
				(_executable, _args, options) => run(process.execPath,
					[resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--no-color'], { ...options, cwd: directory }),
				{ agentClass, effectiveProfile: { activity }, acceptanceCriteria: ['Tester commits failing-on-base SDK tests.'] });
			expect(result.report.reviewDisposition).toBe('approved');
			expect(result.report.verification[0]?.status).toBe('failed');
			expect(result.report.verification[0]?.commands).toEqual([command]);
			expect(result.report.verification[0]?.summary).toContain('rejects duplicate decisions');
			expect(result.report.verification[0]?.summary).toContain('AssertionError');
			expect(result.verification).toEqual([expect.objectContaining({ command, status: 'failed', exitCode: 1,
				outputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })]);
			expect(result.report.summary).toContain('Runner-observed test-first red');
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps unscoped non-test setup and resource runner failures fail-closed', async () => {
	const criteria = ['Tester commits failing-on-base SDK tests.'];
	for (const [agentClass, activity, acceptanceCriteria, command, exitCode, output] of [
		['engineer', 'acting', criteria, 'npx vitest run tests/unit/example.test.ts', 1, 'FAIL example.test.ts > case\nAssertionError: expected false to be true'],
		['reviewer', 'reviewing', ['Implementation tests must pass'], 'npx vitest run tests/unit/example.test.ts', 1, 'FAIL example.test.ts > case\nAssertionError: expected false to be true'],
		['reviewer', 'reviewing', criteria, 'node -e "process.exit(1)"', 1, 'FAIL example.test.ts > case\nAssertionError: expected false to be true'],
		['reviewer', 'reviewing', criteria, 'npx vitest run tests/unit/example.test.ts', 1, 'FAIL example.test.ts [ example.test.ts ]\nCannot find module missing-dependency'],
		['reviewer', 'reviewing', criteria, 'npx vitest run tests/unit/example.test.ts', 137, 'FAIL example.test.ts > case\nAssertionError: expected false to be true'],
		['reviewer', 'reviewing', criteria, 'npx vitest run tests/unit/example.test.ts', 1, 'FAIL example.test.ts > case\nAssertionError: expected false to be true\nUnhandled Error: Cannot find module missing-dependency'],
	] as const) {
		const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Claimed pass', contentOutput: null,
			reviewDisposition: 'approved' as const, verification: [{ status: 'passed' as const, summary: 'Check', commands: [command] }] };
		await expect(observeReportedActivityCommands(report, [],
			(_executable, _args, options) => run(process.execPath,
				['-e', `console.error(${JSON.stringify(output)});process.exit(${exitCode})`], { ...options, cwd: import.meta.dirname }),
			{ agentClass, effectiveProfile: { activity }, acceptanceCriteria })).rejects.toThrow('Runner-observed verification failed');
	}
});

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
