import { describe, expect, it } from 'vitest';
import { codexIdleTimeoutMs, codexToolInFlight } from '../../../src/sandbox/guest.ts';
import { run } from '../../../src/sandbox/process-runner.ts';

describe('bounded Codex idle recovery', () => {
	it('leaves time in the same assignment for a single continuation', () => {
		expect(codexIdleTimeoutMs(180)).toBe(90_000);
		expect(codexIdleTimeoutMs(900)).toBe(90_000);
		expect(codexIdleTimeoutMs(60)).toBeUndefined();
	});
	it('interrupts a silent completed-tool turn before the hard deadline', async () => {
		await expect(run(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
			timeoutMs: 1_000, idleTimeoutMs: 100, canInterruptIdle: () => true,
		})).rejects.toThrow('codex_idle_interrupted');
	});
	it('never interrupts a tool still in flight, and retains the hard deadline', async () => {
		const events: Record<string, unknown>[] = [{ type: 'item.started', item: { id: 'tool-a', type: 'command_execution' } }];
		expect(codexToolInFlight(events)).toBe(true);
		await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 200, idleTimeoutMs: 50, canInterruptIdle: () => !codexToolInFlight(events),
		})).rejects.toThrow('exceeded its interactive execution deadline');
		events.push({ type: 'item.completed', item: { id: 'tool-a', type: 'command_execution' } });
		expect(codexToolInFlight(events)).toBe(false);
	});
	it('cannot interrupt a silent turn without a resumable session', async () => {
		await expect(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 200, idleTimeoutMs: 50, canInterruptIdle: () => false,
		})).rejects.toThrow('exceeded its interactive execution deadline');
	});
});
