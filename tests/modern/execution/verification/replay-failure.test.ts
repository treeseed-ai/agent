import { expect, it } from 'vitest';
import { observeReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { objectDigest } from '../../../../src/sandbox/verification.ts';
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
		for (const [agentClass, activity] of [['reviewer', 'reviewing'], ['tester', 'acting'],
			['contract-author', 'acting'], ['independent-inspector', 'reviewing']]) {
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
		['engineer', 'acting', ['Implementation tests must pass'], 'npx vitest run tests/unit/example.test.ts', 1, 'FAIL example.test.ts > case\nAssertionError: expected false to be true'],
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

it('retains exact assertion-only test-first output digests without mutating the supplied report or assignment', async () => {
	const command = 'npm run test:contracts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Review the observed red suite',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Observe the exact test candidate', commands: [command] }] };
	const assignment = { agentClass: 'arbitrary-contract-author', effectiveProfile: { activity: 'acting' },
		acceptanceCriteria: ['Commit failing-on-base SDK tests for the accepted contract.'] };
	const evidence = { exitCode: 1, stdout: 'FAIL tests/contract/selection.test.ts > trims decisions\nAssertionError: expected trimmed input\n', stderr: '' };
	const before = structuredClone({ report, assignment, evidence });
	const failure = Object.assign(new Error('process exited 1'), evidence);
	const observed = await observeReportedActivityCommands(report, [], async () => { throw failure; }, assignment);
	expect(observed.report.reviewDisposition).toBe('approved');
	expect(observed.report.verification[0]?.status).toBe('failed');
	expect(observed.report.verification[0]?.commands).toEqual([command]);
	expect(observed.verification).toEqual([{ command, status: 'failed', exitCode: 1,
		outputDigest: objectDigest({ stdout: evidence.stdout, stderr: evidence.stderr }), durationSeconds: expect.any(Number) }]);
	expect(Number.isInteger(observed.verification[0]!.durationSeconds)).toBe(true);
	expect(observed.verification[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
	expect({ report, assignment, evidence }).toEqual(before);
});

it('denies mixed assertion and nonbehavioral suite failures or incomplete coverage instead of laundering them as test-first red', async () => {
	const command = 'npm run test:contracts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Claimed complete red suite',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Observe all failures', commands: [command] }] };
	const assignment = { agentClass: 'renamed-independent-inspector', effectiveProfile: { activity: 'reviewing' },
		acceptanceCriteria: ['Commit failing-on-base SDK tests for the accepted contract.'] };
	for (const extra of [
		'FAIL tests/contract/setup.test.ts [ tests/contract/setup.test.ts ]\nSyntaxError: Unexpected token',
		'FAIL tests/contract/runtime.test.ts > native setup\nTypeError: configuration is not a function',
		'FAIL tests/contract/runtime.test.ts > native setup\nReferenceError: fixture is not defined',
		'FAIL tests/contract/runtime.test.ts > native setup\nError: Test timed out in 15000ms',
		'Test Files  1 failed (1)\nTests  1 failed | 1 skipped (2)',
		'Test Files  1 failed (1)\nTests  1 failed | 1 todo (2)',
	]) {
		const evidence = { exitCode: 1, stdout: 'FAIL tests/contract/selection.test.ts > trims decisions\nAssertionError: expected trimmed input\n', stderr: `${extra}\n` };
		const before = structuredClone({ report, assignment, evidence });
		const failure = Object.assign(new Error('process exited 1'), evidence);
		await expect(observeReportedActivityCommands(report, [], async () => { throw failure; }, assignment))
			.rejects.toThrow('Runner-observed verification failed');
		expect({ report, assignment, evidence }).toEqual(before);
	}
});

it('real Vitest mixed assertion setup runtime skipped and todo outcomes remain fatal through the owning command observer', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'treeseed-mixed-red-'));
	const command = 'npm run test:contracts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Complete contract suite required',
		contentOutput: null, reviewDisposition: 'approved' as const,
		verification: [{ status: 'passed' as const, summary: 'Observe actual suite', commands: [command] }] };
	const assignment = { agentClass: 'renamed-test-author', effectiveProfile: { activity: 'acting' },
		acceptanceCriteria: ['Commit failing-on-base SDK tests for the accepted contract.'] };
	const outcomes: { value: unknown; error: unknown }[] = [];
	try {
		await symlink(resolve('node_modules'), resolve(root, 'node_modules'), 'dir');
		const executions = await Promise.allSettled([
			"import { it } from 'vitest';\nthrow new SyntaxError('native setup syntax failure');\nit('unreachable setup', () => {});\n",
			"import { it } from 'vitest';\nit('native runtime setup', () => { throw new TypeError('native fixture runtime failure'); });\n",
			"import { it } from 'vitest';\nit.skip('unproven contract', () => {});\n",
			"import { it } from 'vitest';\nit.todo('unproven contract');\n",
		].map(async (source, index) => {
			const directory = await mkdtemp(resolve(root, `case-${index}-`));
			await writeFile(resolve(directory, 'assertion.test.ts'), "import { expect, it } from 'vitest';\nit('trims decisions', () => expect(' decision ').toBe('decision'));\n");
			await writeFile(resolve(directory, 'other.test.ts'), source);
			const before = structuredClone({ report, assignment });
			let actualFailure: unknown;
			const outcome = await observeReportedActivityCommands(report, [], async (_executable, _args, options) => {
				try {
					return await run(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--no-color', '--maxWorkers=1'],
						{ ...options, cwd: directory });
				} catch (error) { actualFailure = error; throw error; }
			}, assignment).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
			expect(actualFailure).toBeInstanceOf(Error);
			expect(actualFailure).toMatchObject({ exitCode: 1 });
			const raw = Object.assign({ stdout: '', stderr: '' }, actualFailure);
			expect(`${raw.stdout}\n${raw.stderr}`).toContain('AssertionError');
			outcomes.push(outcome);
			expect({ report, assignment }).toEqual(before);
		}));
		for (const execution of executions) if (execution.status === 'rejected') throw execution.reason;
		expect(outcomes).toHaveLength(4);
		// Preserve each actual observation before checking the aggregate denial.
		for (const outcome of outcomes) {
			expect(outcome.value).toBeUndefined();
			expect(outcome.error).toBeInstanceOf(Error);
			expect(String(outcome.error)).toContain('Runner-observed verification failed');
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
