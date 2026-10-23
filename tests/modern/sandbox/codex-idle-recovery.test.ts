import { describe, expect, it, vi } from 'vitest';
import { codexCloseoutTimeoutMs, codexIdleTimeoutMs, codexInvocationTimerOptions, codexResumeIdleTimeoutMs, codexToolInFlight } from '../../../src/kernel/handlers/model-workload-contract.ts';
import { run, withinAssignmentBudget } from '../../../src/sandbox/process-runner.ts';

describe('bounded Codex idle recovery', () => {
	it('derives invocation timers from one productive remainder snapshot without subtracting startup twice', async () => {
		const timers = codexInvocationTimerOptions(35_000, 'reviewing');
		expect(timers).toEqual({ timeoutMs: 30_000, closeoutTimeoutMs: 5_000 });
		const execute = vi.fn(async (_executable: string, _args: string[], options: { timeoutMs?: number; closeoutTimeoutMs?: number } = {}) => ({
			stdout: JSON.stringify(options), stderr: '',
		}));
		const response = await withinAssignmentBudget(execute, () => 35_000)('codex', [], timers);
		expect(JSON.parse(response.stdout)).toEqual(timers);
		expect(execute).toHaveBeenCalledOnce();
	});
	it('rejects invalid and exhausted invocation remainders before a child can start', () => {
		expect(() => codexInvocationTimerOptions(Number.NaN, 'reviewing')).toThrow('assignment_execution_clock_invalid');
		expect(() => codexInvocationTimerOptions(0, 'reviewing')).toThrow('assignment_execution_budget_exhausted');
	});
	it('reserves safe closeout for planning acting reviewing and reporting without extending their budgets', () => {
		for (const activity of ['planning', 'acting', 'reviewing', 'reporting']) {
			expect(codexCloseoutTimeoutMs(180, activity)).toBe(135_000);
			expect(codexCloseoutTimeoutMs(90, activity)).toBe(45_000);
			expect(codexCloseoutTimeoutMs(60, activity)).toBe(30_000);
		}
		expect(codexCloseoutTimeoutMs(180, 'unsupported')).toBeUndefined();
	});
	it('protects original short review windows while retaining enough time for safe same-session closeout', () => {
		for (const activity of ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat']) {
			expect(codexCloseoutTimeoutMs(39, activity)).toBe(9_000);
			expect(codexCloseoutTimeoutMs(43, activity)).toBe(13_000);
			expect(codexCloseoutTimeoutMs(35, activity)).toBe(5_000);
			expect(codexCloseoutTimeoutMs(89, activity)).toBe(44_500);
			// Below this window, the existing 20s resume guard plus hard-stop
			// margin and process drainage cannot safely fit an initial turn.
			expect(codexCloseoutTimeoutMs(34, activity)).toBeUndefined();
		}
	});
	it('leaves time in the same assignment for a single continuation', () => {
		expect(codexIdleTimeoutMs(120)).toBe(30_000);
		expect(codexIdleTimeoutMs(180)).toBe(45_000);
		expect(codexIdleTimeoutMs(180)!).toBeLessThan(codexCloseoutTimeoutMs(180, 'estimating')!);
		expect(codexIdleTimeoutMs(900)).toBe(90_000);
		expect(codexIdleTimeoutMs(60)).toBeUndefined();
	});
	it('interrupts a silent completed-tool turn before the hard deadline', async () => {
		await expect(run(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
			timeoutMs: 1_000, idleTimeoutMs: 100, canInterrupt: () => true,
		})).rejects.toThrow('codex_closeout_interrupted');
	});
	it('never interrupts a tool still in flight, and retains the hard deadline', async () => {
		const events: Record<string, unknown>[] = [{ type: 'item.started', item: { id: 'tool-a', type: 'command_execution' } }];
		expect(codexToolInFlight(events)).toBe(true);
		await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 200, idleTimeoutMs: 50, canInterrupt: () => !codexToolInFlight(events),
		})).rejects.toThrow('exceeded its interactive execution deadline');
		events.push({ type: 'item.completed', item: { id: 'tool-a', type: 'command_execution' } });
		expect(codexToolInFlight(events)).toBe(false);
	});
	it('cannot interrupt a silent turn without a resumable session', async () => {
		await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 200, idleTimeoutMs: 50, canInterrupt: () => false,
		})).rejects.toThrow('exceeded its interactive execution deadline');
	});
	it('reserves closeout inside the original active-time budget for chat and estimating', () => {
		expect(codexCloseoutTimeoutMs(107, 'estimating')).toBe(62_000);
		expect(codexCloseoutTimeoutMs(180, 'estimating')).toBe(90_000);
		expect(codexCloseoutTimeoutMs(150, 'estimating')).toBe(90_000);
		expect(codexCloseoutTimeoutMs(180, 'chat')).toBe(135_000);
		expect(codexCloseoutTimeoutMs(60, 'estimating')).toBe(30_000);
	});
	it('bounds one final estimating continuation inside the unchanged deadline', () => {
		expect(codexResumeIdleTimeoutMs(130_000)).toBe(40_000);
		expect(codexResumeIdleTimeoutMs(75_000)).toBe(40_000);
		expect(codexResumeIdleTimeoutMs(69_999)).toBeUndefined();
	});
	it('recovers two silent turns and completes within one original deadline', async () => {
		const deadline = Date.now() + 2_000;
		for (let turn = 0; turn < 2; turn++) {
			await expect(run(process.execPath, ['-e', 'process.stdout.write("clock\\n"); setInterval(() => {}, 1000)'], {
				timeoutMs: deadline - Date.now(), idleTimeoutMs: 90, canInterrupt: () => true,
			})).rejects.toThrow('codex_closeout_interrupted');
		}
		const response = await run(process.execPath, ['-e', 'process.stdout.write("estimate\\n")'], {
			timeoutMs: deadline - Date.now(), captureStdout: true,
		});
		expect(response.stdout).toContain('estimate');
		expect(Date.now()).toBeLessThan(deadline);
	});
	it('interrupts a still-active read-only turn at its closeout boundary even while events continue', async () => {
		await expect(run(process.execPath, ['-e', 'setInterval(() => process.stdout.write("event\\n"), 20)'], {
			timeoutMs: 1_000, closeoutTimeoutMs: 120, canInterrupt: () => true,
		})).rejects.toThrow('codex_closeout_interrupted');
	});
	it('waits for an in-flight tool to finish before closeout interruption', async () => {
		let inFlight = true;
		const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 2_000, closeoutTimeoutMs: 50, canInterrupt: () => !inFlight,
		});
		setTimeout(() => { inFlight = false; }, 120);
		await expect(pending).rejects.toThrow('codex_closeout_interrupted');
	});
	it('never extends the hard deadline when no safe closeout exists', async () => {
		await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 180, closeoutTimeoutMs: 50, canInterrupt: () => false,
		})).rejects.toThrow('exceeded its interactive execution deadline');
	});
});
