import { expect, it, vi } from 'vitest';
import { withinAssignmentBudget, remainingExecutionMs, run } from '../../../../src/sandbox/process-runner.ts';
import { observeReportedActivityCommands } from '../../../../src/sandbox/verification.ts';
import { stat } from 'node:fs/promises';

vi.mock('node:fs/promises', async importOriginal => ({
	...await importOriginal<typeof import('node:fs/promises')>(), stat: vi.fn(),
}));
vi.mock('../../../../src/sandbox/process-runner.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../../src/sandbox/process-runner.ts')>(),
	run: vi.fn(() => Promise.reject(new Error('unguarded dependency restore'))),
}));

const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Required replay',
	contentOutput: null, reviewDisposition: 'approved' as const,
	verification: [{ status: 'passed' as const, summary: 'Required checks', commands: ['npm run build'] }] };

it('clamps the signed guest budget to the exact earlier API execution deadline', () => {
	const now = Date.parse('2026-10-01T21:32:00Z');
	expect(remainingExecutionMs(180, 20_000, '2026-10-01T21:32:30Z', now)).toBe(25_000);
	expect(remainingExecutionMs(180, 20_000, '2026-10-01T21:40:00Z', now)).toBe(155_000);
	expect(remainingExecutionMs(180, 179_000, '2026-10-01T21:40:00Z', now)).toBe(-4_000);
});

it('fails closed on missing or malformed API execution clock authority', () => {
	for (const deadline of ['', 'not-a-deadline']) expect(() => remainingExecutionMs(180, 0, deadline)).toThrow('assignment_execution_clock_invalid');
});

it('remeasures the original API deadline as time passes without resetting the guest budget', () => {
	const now = Date.parse('2026-10-01T21:32:00Z'), deadline = '2026-10-01T21:32:30Z';
	expect(remainingExecutionMs(180, 20_000, deadline, now + 10_000)).toBe(15_000);
	expect(remainingExecutionMs(180, 45_000, deadline, now + 30_000)).toBe(-5_000);
});

it('remeasures the original remaining budget before every required replay command', async () => {
	vi.mocked(stat).mockRejectedValue(new Error('absent'));
	let remaining = 35_000;
	const execute = vi.fn<typeof run>(async () => { remaining -= 20_000; return { stdout: 'pass', stderr: '' }; });
	const bounded = withinAssignmentBudget(execute, () => remaining);
	const result = await observeReportedActivityCommands({ ...report, verification: [
		report.verification[0]!, { status: 'passed', summary: 'Archive', commands: ['npm pack'] },
	] }, [], bounded);
	expect(execute.mock.calls.map(call => call[2]?.timeoutMs)).toEqual([35_000, 15_000]);
	expect(result.verification.map(entry => entry.command)).toEqual(['npm run build', 'npm pack']);
	expect(result.verification.every(entry => entry.status === 'passed')).toBe(true);
});

it('refuses exhausted and invalid budgets before starting any subprocess', async () => {
	const execute = vi.fn<typeof run>(async () => ({ stdout: '', stderr: '' }));
	for (const remaining of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		await expect(withinAssignmentBudget(execute, () => remaining)('node', [], { timeoutMs: 120_000 }))
			.rejects.toThrow('assignment_execution_budget_exhausted');
	}
	expect(execute).not.toHaveBeenCalled();
});

it('fails rather than skipping a later mandatory command when the budget is exhausted', async () => {
	vi.mocked(stat).mockRejectedValue(new Error('absent'));
	let remaining = 10_000;
	const execute = vi.fn<typeof run>(async () => { remaining = 0; return { stdout: 'pass', stderr: '' }; });
	await expect(observeReportedActivityCommands({ ...report, verification: [report.verification[0]!,
		{ status: 'passed', summary: 'Archive', commands: ['npm pack'] },
	] }, [], withinAssignmentBudget(execute, () => remaining)))
		.rejects.toThrow('assignment_execution_budget_exhausted');
	expect(execute).toHaveBeenCalledTimes(1);
});

it('retains stricter command limits and short positive productive windows', async () => {
	const execute = vi.fn<typeof run>(async () => ({ stdout: 'ok', stderr: '' }));
	await withinAssignmentBudget(execute, () => 30_000)('git', [], { timeoutMs: 10_000 });
	await withinAssignmentBudget(execute, () => 370.9)('git', [], { timeoutMs: 10_000 });
	expect(execute.mock.calls.map(call => call[2]?.timeoutMs)).toEqual([10_000, 370]);
});

it('preserves the original safe closeout reserve when setup has consumed execution time', async () => {
	const execute = vi.fn<typeof run>(async () => ({ stdout: '', stderr: '' }));
	await withinAssignmentBudget(execute, () => 155_000)('codex', [],
		{ timeoutMs: 175_000, closeoutTimeoutMs: 135_000, idleTimeoutMs: 45_000 });
	expect(execute).toHaveBeenCalledWith('codex', [], expect.objectContaining({
		timeoutMs: 155_000, closeoutTimeoutMs: 115_000, idleTimeoutMs: 45_000,
	}));
});

it('does not start another model turn after its existing closeout reserve is consumed', async () => {
	const execute = vi.fn<typeof run>(async () => ({ stdout: '', stderr: '' }));
	await expect(withinAssignmentBudget(execute, () => 40_000)('codex', [],
		{ timeoutMs: 175_000, closeoutTimeoutMs: 135_000 }))
		.rejects.toThrow('assignment_closeout_budget_exhausted');
	expect(execute).not.toHaveBeenCalled();
});

it('restores replay dependencies through the same bounded executor', async () => {
	vi.mocked(stat).mockImplementation(async path => {
		if (String(path).endsWith('package-lock.json')) return {} as Awaited<ReturnType<typeof stat>>;
		throw new Error('dependency absent');
	});
	let remaining = 25_000;
	const execute = vi.fn<typeof run>(async () => { remaining -= 10_000; return { stdout: '', stderr: '' }; });
	const result = await observeReportedActivityCommands(report, [], withinAssignmentBudget(execute, () => remaining));
	expect(execute.mock.calls.map(call => [call[0], call[2]?.timeoutMs])).toEqual([
		['npm', 25_000], ['/bin/sh', 15_000],
	]);
	expect(run).not.toHaveBeenCalled();
	expect(result.verification[0]?.status).toBe('passed');
});

it('does not convert a mandatory replay overrun into a passing receipt', async () => {
	vi.mocked(stat).mockRejectedValue(new Error('absent'));
	const actual = await vi.importActual<typeof import('../../../../src/sandbox/process-runner.ts')>('../../../../src/sandbox/process-runner.ts');
	const bounded = withinAssignmentBudget(actual.run, () => 100);
	await expect(observeReportedActivityCommands(report, [], (executable, args, options) => bounded(process.execPath,
		['-e', 'setTimeout(() => process.exit(0), 300)'], { ...options, cwd: import.meta.dirname })))
		.rejects.toThrow('interactive execution deadline');
}, 2_000);
