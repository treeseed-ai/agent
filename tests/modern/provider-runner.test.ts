import { describe, expect, it, vi } from 'vitest';
import { runProviderAssignment } from '../../src/provider/operations/runner.ts';
import type { AgentExecutor } from '../../src/provider/execution/contracts.ts';

function client() {
	return {
		startAssignmentExecution: vi.fn().mockResolvedValue({ ok: true }),
		renewAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }),
		startAssignmentCloseout: vi.fn().mockResolvedValue({ ok: true }),
		preflightAssignmentCompletion: vi.fn().mockResolvedValue({ ok: true }),
		completeAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'completed' } }),
		returnAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'returned' } }),
		failAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'failed' } }),
		reportAssignmentUsage: vi.fn().mockResolvedValue({ ok: true }),
		respondToAssignmentDiscussion: vi.fn().mockResolvedValue({ status: 'responded' }),
		settleAssignment: vi.fn().mockResolvedValue({ replayed: false }),
	};
}

const treeDx = { projectId: 'project-1', repositoryId: null, workspaceId: null, invoke: vi.fn() };

describe('catalog-driven provider assignment runner', () => {
	it('records start, usage, closeout, preflight, and completion in order', async () => {
		const api = client();
		const executor: AgentExecutor = {
			id: 'fake',
			observe: async () => ({ available: true }),
			execute: async () => ({
				status: 'completed',
				summary: 'done',
				outputs: { commit: 'abc' },
				usage: [{ unit: 'agent_second', amount: 2 }],
			}),
		};
		await runProviderAssignment({
			client: api,
			executor,
			assignment: { id: 'assignment-1' },
			treeDx,
			leaseToken: 'lease',
			runnerId: 'runner',
		});
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ executorId: 'fake' }));
		expect(api.reportAssignmentUsage).toHaveBeenCalledOnce();
		expect(api.startAssignmentCloseout).toHaveBeenCalledOnce();
		expect(api.preflightAssignmentCompletion).toHaveBeenCalledOnce();
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			summary: { text: 'done' },
			output: { commit: 'abc', artifacts: [] },
		}));
	});

	it('renews long-running assignment leases and persists the new expiry', async () => {
		const api = client();
		const renewed: string[] = [];
		const executor: AgentExecutor = {
			id: 'fake',
			observe: async () => ({ available: true }),
			execute: async () => new Promise((resolve) => setTimeout(() => resolve({
				status: 'returned',
				summary: 'paused',
			}), 20)),
		};
		await runProviderAssignment({
			client: api,
			executor,
			assignment: { id: 'assignment-renew' },
			treeDx,
			leaseToken: 'lease',
			runnerId: 'runner',
			renewalIntervalMs: 5,
			onLeaseRenewed: async (value) => { renewed.push(value); },
		});
		expect(api.renewAssignment).toHaveBeenCalled();
		expect(renewed.length).toBeGreaterThan(0);
		expect(api.returnAssignment).toHaveBeenCalledOnce();
	});

	it('commits, settles, and closes a communication response without the completion path', async () => {
		const api = client();
		await runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: { id: 'assignment-chat', executionKind: 'conversation' },
			executor: { id: 'chat', observe: async () => ({ available: true }), execute: async () => ({ status: 'responded', summary: 'Answered.', responseMarkdown: '## Answer\n\nReady.', usage: [{ activeSeconds: 3, elapsedSeconds: 4 }] }) } });
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledWith('assignment-chat', expect.objectContaining({ leaseToken: 'lease', markdown: '## Answer\n\nReady.' }), expect.any(String));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.returnAssignment);
		expect(api.completeAssignment).not.toHaveBeenCalled();
	});

	it('turns executor exceptions into an exact retryable failure receipt', async () => {
		const api = client();
		const executor: AgentExecutor = {
			id: 'fake',
			observe: async () => ({ available: true }),
			execute: async () => { throw new Error('provider unavailable'); },
		};
		await runProviderAssignment({
			client: api,
			executor,
			assignment: { id: 'assignment-2' },
			treeDx,
			leaseToken: 'lease',
			runnerId: 'runner',
		});
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-2', expect.objectContaining({
			code: 'agent_executor_failed',
			retryable: true,
		}));
		expect(api.completeAssignment).not.toHaveBeenCalled();
	});

	it('cancels executor and TreeDX proxy work when lease renewal fails', async () => {
		const api = client();
		api.renewAssignment.mockRejectedValueOnce(new Error('lease expired'));
		let executorSignal: AbortSignal | undefined;
		let proxySignal: AbortSignal | undefined;
		const scopedTreeDx = { ...treeDx, invoke: vi.fn(async (_operationId, _input, options) => { proxySignal = options?.signal; return {}; }) };
		const executor: AgentExecutor = {
			id: 'fake', observe: async () => ({ available: true }),
			execute: async (request) => {
				executorSignal = request.signal;
				await request.treeDx.invoke('treedx.health.show', {});
				await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
				return { status: 'returned', summary: 'cancelled' };
			},
		};
		await runProviderAssignment({ client: api, executor, treeDx: scopedTreeDx, assignment: { id: 'assignment-expired' },
			leaseToken: 'lease', runnerId: 'runner', renewalIntervalMs: 1 });
		expect(executorSignal?.aborted).toBe(true);
		expect(proxySignal).toBe(executorSignal);
		expect(api.returnAssignment).toHaveBeenCalledWith('assignment-expired', expect.objectContaining({ code: 'assignment_lease_renewal_failed' }));
	});

	it('keeps proxy-handle credentials out of executor-visible assignment data', async () => {
		const api = client();
		let visibleAssignment: Record<string, unknown> | undefined;
		const executor: AgentExecutor = {
			id: 'fake', observe: async () => ({ available: true }),
			execute: async (request) => {
				visibleAssignment = request.assignment;
				return { status: 'completed', summary: 'done' };
			},
		};
		await runProviderAssignment({ client: api, executor, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: {
			id: 'assignment-private-handle', treedxProxyHandle: { id: 'handle-1', token: 'secret' },
			workspaceContext: { label: 'workspace', treedxProxyHandle: { id: 'handle-2', token: 'nested-secret' } },
		} });
		expect(visibleAssignment).toEqual({ id: 'assignment-private-handle', workspaceContext: { label: 'workspace' } });
	});
});
