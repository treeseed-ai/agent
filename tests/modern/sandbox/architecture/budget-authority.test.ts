import { describe, expect, it, vi } from 'vitest';
import { remainingExecutionMs, run, withinAssignmentBudget, ownedProcessGroupExists } from '../../../../src/sandbox/process-runner.ts';

describe('original execution budget and subprocess limit authority', () => {
	it('requires native ESRCH for owned process group absence and preserves permission and unknown observation failures', () => {
		const kill = vi.spyOn(process, 'kill');
		try {
			kill.mockReturnValue(true);
			expect(ownedProcessGroupExists(12345, true)).toBe(true); expect(kill).toHaveBeenLastCalledWith(-12345, 0);
			expect(ownedProcessGroupExists(12345, false)).toBe(true); expect(kill).toHaveBeenLastCalledWith(12345, 0);
			const absent = Object.assign(new Error('Native absence input'), { code: 'ESRCH' });
			kill.mockImplementation(() => { throw absent; }); expect(ownedProcessGroupExists(12345, true)).toBe(false);
			for (const error of [Object.assign(new Error('Permission denied input'), { code: 'EPERM' }), new Error('Unknown native observation input')]) {
				kill.mockImplementation(() => { throw error; }); expect(() => ownedProcessGroupExists(12345, true)).toThrow(error);
			}
			kill.mockReturnValue(true); kill.mockClear();
			for (const value of [0, 1, -1, process.pid, 1.5, NaN, Infinity, null, undefined, '', '12345', true, [], {}]) {
				const input = Object.assign({ pid: 12345, group: true }, { pid: value }), before = structuredClone(input);
				expect(() => ownedProcessGroupExists(input.pid, input.group)).toThrow('assignment_subprocess_identity_invalid');
				expect(input).toEqual(before);
			}
			for (const value of [null, undefined, '', 1, [], {}]) {
				const input = Object.assign({ pid: 12345, group: true }, { group: value });
				expect(() => ownedProcessGroupExists(input.pid, input.group)).toThrow('assignment_subprocess_identity_invalid');
			}
			expect(kill).not.toHaveBeenCalled();
		} finally { kill.mockRestore(); }
	});
	it('retains each original timeout interruption and failing command cause through bounded execution without a successful retry or widened remaining authority', async () => {
		const failures = [Object.assign(new Error('original interactive execution deadline'), { exitCode: null, stdout: 'original timed output', stderr: '' }),
			new Error('codex_closeout_interrupted'), Object.assign(new Error('original command exit 23'), { exitCode: 23, stdout: 'original failed output', stderr: 'original failed cause' })];
		const original = failures.map(error => ({ message: error.message, entries: Object.entries(error) }));
		for (const failure of failures) {
			const calls: Array<{ executable: string; args: string[]; options: Parameters<typeof run>[2] }> = [];
			const execute: typeof run = async (executable, args, options) => { calls.push({ executable, args, options }); throw failure; };
			const options = { timeoutMs: 5_000, captureStdout: true }, args = ['original-command'], before = structuredClone({ options, args });
			let remaining = 5_000;
			const bounded = withinAssignmentBudget(execute, () => remaining);
			await expect(bounded('original-executable', args, options)).rejects.toBe(failure);
			remaining = 0;
			await expect(bounded('original-executable', args, options)).rejects.toThrow('assignment_execution_budget_exhausted');
			expect(calls).toEqual([{ executable: 'original-executable', args, options }]); expect({ options, args }).toEqual(before);
		}
		expect(failures.map(error => ({ message: error.message, entries: Object.entries(error) }))).toEqual(original);
	});
	it('denies malformed signed duration elapsed and wall clock numbers without enlarging the original window', () => {
		const now = Date.parse('2026-10-03T10:00:00.000Z'), deadline = new Date(now + 30_000).toISOString();
		expect(remainingExecutionMs(30, 2_000, deadline, now)).toBe(23_000);
		const inputs = [
			...[0, -1, NaN, Infinity, -Infinity].map(duration => [duration, 2_000, now]),
			...[-1, NaN, Infinity, -Infinity].map(elapsed => [30, elapsed, now]),
			...[NaN, Infinity, -Infinity].map(wall => [30, 2_000, wall]),
		];
		const denied = inputs.map(([duration, elapsed, wall]) => {
			try { remainingExecutionMs(duration!, elapsed!, deadline, wall!); return false; } catch { return true; }
		});
		expect(denied).toEqual(inputs.map(() => true));
		for (const field of ['duration', 'elapsed', 'wall'] as const) {
			for (const value of [...(field === 'wall' ? [] : [undefined]), null, '', '30', true, false, [], {}]) {
				const supplied = Object.assign({ duration: 30, elapsed: 2_000, wall: now }, { [field]: value });
				const before = structuredClone(supplied);
				expect(() => remainingExecutionMs(supplied.duration, supplied.elapsed, deadline, supplied.wall)).toThrow();
				expect(supplied).toEqual(before);
			}
		}
		// The ORIGINAL optional now argument may be omitted; do not retire its
		// real Date.now default while denying malformed explicitly supplied clocks.
		for (const value of [undefined, 0, 30, true, false, [], {}]) {
			const supplied = Object.assign({ deadline }, { deadline: value }), before = structuredClone(supplied);
			// Null is the ORIGINAL intentionally absent wall deadline, not a
			// malformed provided clock; the signed monotonic bound still applies.
			expect(() => remainingExecutionMs(30, 2_000, supplied.deadline, now)).toThrow(); expect(supplied).toEqual(before);
		}
		expect(remainingExecutionMs(30, 2_000, null, now)).toBe(23_000);
		// Normal productive expiration remains an exhausted window, not a new one.
		expect(remainingExecutionMs(30, 31_000, deadline, now + 31_000)).toBe(-6_000);
	});
	it('denies invalid explicit hard idle and closeout limits before delegating any subprocess', async () => {
		let calls = 0;
		const execute: typeof run = async () => { calls += 1; return { stdout: '', stderr: '' }; };
		const denied: boolean[] = [];
		for (const field of ['timeoutMs', 'idleTimeoutMs', 'closeoutTimeoutMs'] as const) {
			for (const value of [0, -1, NaN, Infinity, -Infinity, null, '', '20000', true, false, [], {}]) {
				const options = Object.assign({ timeoutMs: 20_000 }, { [field]: value }), before = structuredClone(options);
				try { await withinAssignmentBudget(execute, () => 10_000)('controlled-command', [], options); denied.push(false); }
				catch { denied.push(true); }
				expect(options).toEqual(before);
			}
		}
		expect(denied).toEqual(Array(36).fill(true)); expect(calls).toBe(0);
		for (const value of [undefined, null, '', '10000', true, false, [], {}, NaN, Infinity, -Infinity, 0, -1]) {
			const supplied = Object.assign({ remainingMs: 10_000 }, { remainingMs: value }), before = structuredClone(supplied);
			await expect(withinAssignmentBudget(execute, () => supplied.remainingMs)('controlled-command', [], { timeoutMs: 5_000 }))
				.rejects.toThrow('assignment_execution_budget_exhausted');
			expect(supplied).toEqual(before);
		}
		expect(calls).toBe(0);
	});
	it('retains the same exact closeout boundary through retries and denies the consumed reserve without rewriting options', async () => {
		const delegated: Array<Parameters<typeof run>[2]> = [];
		const execute: typeof run = async (_path, _args, options) => { delegated.push(options); return { stdout: 'observed', stderr: '' }; };
		let remaining = 9_000;
		const options = { timeoutMs: 14_000, closeoutTimeoutMs: 10_000, idleTimeoutMs: 1_000 }, before = { ...options };
		const bounded = withinAssignmentBudget(execute, () => remaining);
		await bounded('controlled-command', [], options);
		remaining = 4_000;
		await expect(bounded('controlled-command', [], options)).rejects.toThrow('assignment_closeout_budget_exhausted');
		expect(delegated).toEqual([{ timeoutMs: 9_000, closeoutTimeoutMs: 5_000, idleTimeoutMs: 1_000 }]);
		expect(options).toEqual(before);
	});
});
