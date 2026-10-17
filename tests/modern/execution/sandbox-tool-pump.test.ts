import { describe, expect, it, vi } from 'vitest';
import { startSandboxToolPump } from '../../../src/provider/execution/microvm-executor.ts';
import { request } from '../kernel/provider-kernel-fixture.ts';

const prepared = { sandboxId: 'sandbox', operationToken: 'test-operation' };
const time = { startedAt: '2026-09-17T00:00:00.000Z', deadlineAt: '2026-09-18T00:00:00.000Z' };
function waitForAbort(_sandbox: string, _token: string, signal?: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(new Error('aborted'));
		else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	});
}

describe('sandbox tool pump lifecycle', () => {
	it('observes original broker lifecycle before tool polling and drains an interrupted observation without any late work or fabricated failure', async () => {
		const client={nextToolRequest:vi.fn(waitForAbort),completeToolRequest:vi.fn()},cancel=vi.fn(),input=request(),held=structuredClone(input.assignment);let observed:AbortSignal|undefined;
		const observe=vi.fn(async(signal:AbortSignal)=>{observed=signal;await waitForAbort(prepared.sandboxId,prepared.operationToken,signal);});
		const stop=startSandboxToolPump(client,prepared,input,time,cancel,observe);
		try{expect(observe).toHaveBeenCalledOnce();expect(observed?.aborted).toBe(false);expect(client.nextToolRequest).not.toHaveBeenCalled();}
		finally{expect(await stop()).toBeUndefined();}
		expect(observed?.aborted).toBe(true);expect(client.nextToolRequest).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();expect(input.assignment).toEqual(held);
	});
	it('cancels the exact original execution once on a missing broker lifecycle snapshot before tool work and retains the original observer failure',async()=>{
		const failure=new Error('Original native broker snapshot missing'),client={nextToolRequest:vi.fn(waitForAbort),completeToolRequest:vi.fn()},cancel=vi.fn(),input=request(),held=structuredClone(input.assignment),observe=vi.fn(async()=>{throw failure;});
		const stop=startSandboxToolPump(client,prepared,input,time,cancel,observe);let closed:unknown;
		try{await new Promise<void>(accept=>setImmediate(accept));expect(cancel).toHaveBeenCalledOnce();expect(client.nextToolRequest).not.toHaveBeenCalled();}
		finally{closed=await stop();}
		expect(closed).toBe(failure);expect(await stop()).toBe(failure);expect(observe).toHaveBeenCalledOnce();expect(client.completeToolRequest).not.toHaveBeenCalled();expect(input.assignment).toEqual(held);
	});

	it('stopped tool polling cannot execute or deliver a late granted reply after its owning closeout', async () => {
		const input: Parameters<typeof startSandboxToolPump>[2] = request(), original = structuredClone(input.assignment), invoke = vi.fn(async () => ({}));
		input.treeDx = { ...input.treeDx, repositoryId: 'sdk-library', baseRef: 'a'.repeat(40), invoke };
		let resolvePoll: ((value: { request: { id: string; tool: string; arguments: Record<string, unknown> } }) => void) | undefined;
		let observedSignal: AbortSignal | undefined;
		const pending = new Promise<{ request: { id: string; tool: string; arguments: Record<string, unknown> } }>(resolve => { resolvePoll = resolve; });
		const client = { nextToolRequest: vi.fn((_id: string, _token: string, signal?: AbortSignal) => { observedSignal = signal; return pending; }),
			completeToolRequest: vi.fn(async () => ({})) }, cancel = vi.fn();
		const stop = startSandboxToolPump(client, prepared, input, time, cancel), stopped = stop();
		expect(observedSignal?.aborted).toBe(true);
		if (!resolvePoll) throw new Error('Original owned poll must be pending');
		resolvePoll({ request: { id: 'late-owned-tool', tool: 'treedx_read_files', arguments: { paths: ['proposals/sdk.mdx'] } } });
		expect(await stopped).toBeUndefined(); expect(await stop()).toBeUndefined();
		expect(invoke).not.toHaveBeenCalled(); expect(client.completeToolRequest).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
		expect(client.nextToolRequest).toHaveBeenCalledOnce(); expect(input.assignment).toEqual(original);
	});
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
