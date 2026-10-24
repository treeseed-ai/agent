import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { observeReportedActivityCommands, objectDigest } from '../../../../src/kernel/handlers/model-verification.ts';
import { run } from '../../../../src/sandbox/process-runner.ts';
import { verifyMeasuredVerification } from '../../../acceptance/workday/support/assignment-authority.ts';

it('retains authored nonzero command facts without interpreting framework names or diagnostic prose', async () => {
	for (const [command, exitCode, stdout, stderr] of [
		['npx vitest run tests/current-profile.test.ts -t "current profile"', 1,
			'FAIL tests/current-profile.test.ts > current profile\nAssertionError: stale fingerprint\nTests 1 failed | 1 skipped (2)', ''],
		['npm run test:contracts', 1, 'Tests 1 failed | 1 todo (2)', 'TypeError: setup failed'],
		['cargo test current_profile', 101, 'test result: FAILED', 'profile fingerprint mismatch'],
		['mix test test/current_profile_test.exs', 2, '1 test, 1 failure', ''],
	] as const) {
		const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Actual failed check; semantic acceptance requires review.',
			contentOutput: null, reviewDisposition: null, verification: [{ status: 'failed' as const, summary: 'Observed nonzero exit.', commands: [command] }] };
		const assignment = { agentClass: 'configured-contributor', effectiveProfile: { activity: 'acting' }, acceptanceCriteria: ['Implement the accepted interface.'] };
		const before = structuredClone({ report, assignment });
		const execute = vi.fn(async () => { throw Object.assign(new Error(`process exited ${exitCode}`), { code: 'subprocess_nonzero_exit', exitCode, stdout, stderr }); });
		const observed = await observeReportedActivityCommands(report, [], execute, assignment);
		expect(execute).toHaveBeenCalledOnce(); expect(observed.report).toBe(report);
		expect(observed.verification).toEqual([{ command, status: 'failed', exitCode,
			outputDigest: objectDigest({ stdout, stderr }), durationSeconds: expect.any(Number) }]);
		expect(observed.observations).toEqual([{ ...observed.verification[0], stdout, stderr }]);
		expect({ report, assignment }).toEqual(before);
		// A failed receipt is not a passing check or a claim of assertion-only RED.
		expect(observed.verification.every(entry => entry.status !== 'passed')).toBe(true);
		expect(() => verifyMeasuredVerification(observed)).not.toThrow();
	}
});

it('real filtered Vitest assertion retains failed evidence and unselected test output through the command observer', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'treeseed-current-profile-filter-'));
	const command = 'npx vitest run current-profile.test.ts -t "current profile fingerprint" --no-color --maxWorkers=1';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Focused pre-fix profile regression; not complete suite evidence.',
		contentOutput: null, reviewDisposition: null,
		verification: [{ status: 'failed' as const, summary: 'Current profile assertion fails before implementation.', commands: [command] }] };
	const held = structuredClone(report);
	try {
		await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir');
		await writeFile(resolve(directory, 'current-profile.test.ts'), "import { expect, it } from 'vitest';\nit('current profile fingerprint', () => expect({store:'treedx'}).toEqual({store:'postgresql'}));\nit('estimate provenance remains unchanged', () => expect('original').toBe('original'));\n");
		const observed = await observeReportedActivityCommands(report, [], (executable, args, options) => run(executable, args, { ...options, cwd: directory }),
			{ effectiveProfile: { activity: 'acting' }, acceptanceCriteria: ['Add the accepted current-profile regression.'] });
		expect(observed.report).toBe(report); expect(report).toEqual(held);
		expect(observed.verification).toEqual([expect.objectContaining({ command, status: 'failed', exitCode: 1 })]);
		const actual = observed.observations[0]!;
		expect(`${actual.stdout}\n${actual.stderr}`).toContain('AssertionError');
		expect(`${actual.stdout}\n${actual.stderr}`).toMatch(/1 skipped/u);
		expect(actual.outputDigest).toBe(objectDigest({ stdout: actual.stdout, stderr: actual.stderr }));
		expect(() => verifyMeasuredVerification(observed)).not.toThrow();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

it('denies untyped abnormal incomplete and unexpectedly successful failed-check observations', async () => {
	const command = 'npx vitest run current-profile.test.ts -t "current profile"';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Declared failure, not permission to fabricate observation.',
		contentOutput: null, reviewDisposition: null, verification: [{ status: 'failed' as const, summary: 'Failed check.', commands: [command] }] };
	const assignment = { effectiveProfile: { activity: 'acting' }, acceptanceCriteria: ['Report failing test names and paths.'] };
	const full = { code: 'subprocess_nonzero_exit', exitCode: 1, stdout: 'FAIL current-profile.test.ts > current profile\nAssertionError: stale fingerprint', stderr: '' };
	for (const evidence of [{ ...full, code: undefined }, { ...full, exitCode: null }, { ...full, exitCode: 0 },
		{ ...full, exitCode: 256 }, { ...full, stdout: undefined }, { ...full, stderr: undefined }]) {
		await expect(observeReportedActivityCommands(report, [], async () => { throw Object.assign(new Error('native subprocess failed'), evidence); }, assignment))
			.rejects.toThrow('Runner-observed verification failed');
	}
	await expect(observeReportedActivityCommands(report, [], async () => ({ stdout: 'now passed', stderr: '' }), assignment))
		.rejects.toThrow('Runner-observed verification failed');
	expect(report.verification).toEqual([{ status: 'failed', summary: 'Failed check.', commands: [command] }]);
});
