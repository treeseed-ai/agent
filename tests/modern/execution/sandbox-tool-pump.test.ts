import { describe, expect, it, vi } from 'vitest';
import { startSandboxToolPump } from '../../../src/provider/execution/microvm-executor.ts';

const prepared = { sandboxId: 'sandbox', operationToken: 'test-operation' };
const time = { startedAt: '2026-09-17T00:00:00.000Z', deadlineAt: '2026-09-18T00:00:00.000Z' };
function waitForAbort(_sandbox: string, _token: string, signal?: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(new Error('aborted'));
		else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	});
}

describe('sandbox tool pump lifecycle', () => {
	it('observes failed delivery immediately, cancels once, and never sends a second response', async () => {
		const error = new Error('TreeDX tool request is not pending.');
		const client = {
			nextToolRequest: vi.fn().mockResolvedValue({ request: { id: 'tool', tool: 'treeseed_time_status', arguments: {} } }),
			completeToolRequest: vi.fn().mockRejectedValue(error),
		};
		const cancel = vi.fn();
		const stop = startSandboxToolPump(client, prepared, { assignment: {} } as never, time, cancel);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
		expect(await stop()).toBe(error);
		expect(client.completeToolRequest).toHaveBeenCalledOnce();
	});
	it('contains a polling transport failure before execution is awaited', async () => {
		const error = new Error('broker unavailable');
		const client = { nextToolRequest: vi.fn().mockRejectedValue(error), completeToolRequest: vi.fn() };
		const cancel = vi.fn();
		const stop = startSandboxToolPump(client, prepared, { assignment: {} } as never, time, cancel);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
		expect(await stop()).toBe(error);
		expect(client.completeToolRequest).not.toHaveBeenCalled();
	});
	it('returns an ordinary denied tool error once without failing the transport', async () => {
		const client = {
			nextToolRequest: vi.fn().mockResolvedValueOnce({ request: { id: 'tool', tool: 'unauthorized', arguments: {} } }).mockImplementation(waitForAbort),
			completeToolRequest: vi.fn().mockResolvedValue({}),
		};
		const cancel = vi.fn();
		const stop = startSandboxToolPump(client, prepared, { assignment: {} } as never, time, cancel);
		await vi.waitFor(() => expect(client.completeToolRequest).toHaveBeenCalledOnce());
		expect(client.completeToolRequest.mock.calls[0]?.[3]).toEqual({ error: 'Activity profile does not authorize unauthorized.' });
		expect(await stop()).toBeUndefined();
		expect(cancel).not.toHaveBeenCalled();
	});
	it('aborts pending polling during teardown without manufacturing a proxy failure', async () => {
		const client = { nextToolRequest: vi.fn(waitForAbort), completeToolRequest: vi.fn() };
		const cancel = vi.fn();
		const stop = startSandboxToolPump(client, prepared, {} as never, time, cancel);
		expect(await stop()).toBeUndefined();
		expect(cancel).not.toHaveBeenCalled();
	});
});
