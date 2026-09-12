import { describe, expect, it, vi } from 'vitest';
import { assertAgentModeRun } from '@treeseed/sdk/agent-capacity';
import { runProviderAssignment } from '../../src/provider/operations/runner.ts';
import type { AgentExecutor } from '../../src/provider/execution/contracts.ts';

function client() {
	return {
		assignment: vi.fn().mockResolvedValue({ id: 'assignment-1', stateVersion: 7 }),
		createAssignmentEvent: vi.fn().mockResolvedValue({ ok: true }),
		createAssignmentModeRun: vi.fn().mockResolvedValue({ id: 'mode-run' }),
		authorizeAssignmentSource: vi.fn(),
		readAssignmentSourceChunk: vi.fn(), publishAssignmentSourceCandidate: vi.fn(),
		createCommunicationTraceEvent: vi.fn().mockResolvedValue({ ok: true }),
		startAssignmentExecution: vi.fn().mockResolvedValue({}),
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
	it.each(['workday', 'conversation'])('routes %s traces and executes the authoritative started window', async executionKind => {
		const api = client();
		api.startAssignmentExecution.mockResolvedValue({ id: 'assignment-1', stateVersion: 3,
			capacityEnvelope: { budget: { time: { executionStartedAt: '2026-09-11T12:00:00Z' } } } });
		let received: Record<string, unknown> | undefined;
		const event = { type: 'execution.started', occurredAt: '2026-09-11T12:00:00Z', summary: 'Started',
			payload: { model: 'test' }, protectedPayload: { transcript: 'private trace' } };
		await runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner',
			assignment: { id: 'assignment-1', executionKind, stateVersion: 2 }, executor: {
				id: 'fake', observe: async () => ({ available: true }), execute: async request => {
					received = request.assignment; await request.emit?.(event);
					return { status: 'completed', summary: 'done' };
				},
			} });
		expect(received).toMatchObject({ stateVersion: 3, executionKind,
			capacityEnvelope: { budget: { time: { executionStartedAt: event.occurredAt } } } });
		if (executionKind === 'conversation') {
			expect(api.createCommunicationTraceEvent).toHaveBeenCalledWith('assignment-1', expect.objectContaining(event));
			expect(api.createAssignmentEvent).not.toHaveBeenCalled();
		} else {
			expect(api.createCommunicationTraceEvent).not.toHaveBeenCalled();
			expect(api.createAssignmentEvent).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
				eventType: 'provider.execution.started', context: { model: 'test' }, message: 'Started',
			}));
			expect(JSON.stringify(api.createAssignmentEvent.mock.calls)).not.toContain('private trace');
		}
	});
	it.each(['provider_context_measurement_mismatch','provider_context_capacity_overflow'])('does not retry unchanged invalid context: %s', async code => {
		const api=client();
		const executor:AgentExecutor={id:'fake',observe:async()=>({available:true}),execute:async()=>{throw Object.assign(new Error('Invalid context contract'),{code});}};
		await runProviderAssignment({client:api,executor,assignment:{id:'assignment-1',stateVersion:2},treeDx,leaseToken:'lease',runnerId:'runner'});
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-1',expect.objectContaining({code,retryable:false}));
		expect(api.returnAssignment).not.toHaveBeenCalled();
	});
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
			assignment: { id: 'assignment-1', stateVersion: 2, metadata: { contentRoot: '.' } },
			treeDx,
			leaseToken: 'lease',
			runnerId: 'runner',
		});
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			executorId: 'fake', expectedStateVersion: 2,
			idempotencyKey: 'execution-start:assignment-1',
			planRef: { id: 'assignment-plan:assignment-1', path: './assignment-plans/assignment-1.mdx' },
		}));
		expect(api.reportAssignmentUsage).not.toHaveBeenCalled();
		expect(api.startAssignmentCloseout).toHaveBeenCalledWith('assignment-1', {
			leaseToken: 'lease', runnerId: 'runner', expectedStateVersion: 7,
			idempotencyKey: 'closeout-start:assignment-1:runner',
		});
		expect(api.preflightAssignmentCompletion).not.toHaveBeenCalled();
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			summary: { text: 'done' },
			output: { commit: 'abc', artifacts: [] },
		}));
	});

	it('preflights real artifacts, records the mode run, settles once, and attaches the receipt to completion', async () => {
		const api = client(), receiptDigest = 'a'.repeat(64), artifactManifest = { schemaVersion: 1, modeRunId: 'mode-run', assignmentId: 'assignment-1' };
		api.preflightAssignmentCompletion.mockResolvedValue({ receiptDigest });
		api.createAssignmentModeRun.mockImplementation(async (_id, body) => {
			const now = new Date().toISOString();
			return assertAgentModeRun({ teamId: 'team', projectId: 'project', providerAssignmentId: 'assignment-1',
				capacityProviderId: 'provider', projectAgentClassId: 'reviewer', selectedInput: {},
				capacityEnvelope: { teamId: 'team', projectId: 'project', mode: 'planning' }, traceRefs: {}, metadata: {},
				createdAt: now, updatedAt: now, ...body });
		});
		await runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: { id: 'assignment-1', mode: 'planning' },
			executor: { id: 'fake', observe: async () => ({ available: true }), execute: async () => ({ status: 'completed', summary: 'Reviewed',
				outputs: { artifactManifest }, usage: [{ activeSeconds: 4.1, elapsedSeconds: 5.2 }] }) } });
		expect(api.preflightAssignmentCompletion).toHaveBeenCalledWith('assignment-1', { leaseToken: 'lease', runnerId: 'runner',
			idempotencyKey: 'assignment:assignment-1:semantic-completion-preflight', artifactManifest });
		expect(api.preflightAssignmentCompletion).toHaveBeenCalledBefore(api.createAssignmentModeRun);
		expect(api.createAssignmentModeRun).toHaveBeenCalledBefore(api.settleAssignment);
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ activeSeconds: 5, elapsedSeconds: 6, modeRunId: 'mode-run' }), expect.any(String));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ metadata: { semanticCompletionPreflightReceiptDigest: receiptDigest } }));
	});
	it('does not settle or complete when semantic preflight fails', async () => {
		const api = client(); api.preflightAssignmentCompletion.mockRejectedValue(new Error('Invalid artifact'));
		await expect(runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: { id: 'assignment-1' },
			executor: { id: 'fake', observe: async () => ({ available: true }), execute: async () => ({ status: 'completed', summary: 'Review', outputs: { artifactManifest: { schemaVersion: 1 } } }) } })).rejects.toThrow('Invalid artifact');
		expect(api.settleAssignment).not.toHaveBeenCalled(); expect(api.completeAssignment).not.toHaveBeenCalled();
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
		expect(api.reportAssignmentUsage).not.toHaveBeenCalled();
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-chat', expect.objectContaining({
			activeSeconds: 3, elapsedSeconds: 4, usageDimension: 'aggregate',
		}), expect.any(String));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.returnAssignment);
		expect(api.completeAssignment).not.toHaveBeenCalled();
	});

	it.each(['responded', 'abstained'] as const)('completes a workday %s result without publishing a Discussion response', async status => {
		const api = client();
		await runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: { id: 'assignment-workday', executionKind: 'workday' },
			executor: { id: 'workday', observe: async () => ({ available: true }), execute: async () => ({ status, summary: 'Harness completed.',
				responseMarkdown: status === 'responded' ? 'Evidence-backed workday result.' : '<!-- treeseed:abstain -->', usage: [{ activeSeconds: 3, elapsedSeconds: 4 }] }) } });
		expect(api.respondToAssignmentDiscussion).not.toHaveBeenCalled();
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-workday', expect.objectContaining({
			summary: { text: status === 'responded' ? 'Evidence-backed workday result.' : '<!-- treeseed:abstain -->' },
		}));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
	});

	it('rounds precise provider timing up to whole accounting seconds', async () => {
		const api = client();
		await runProviderAssignment({ client: api, treeDx, leaseToken: 'lease', runnerId: 'runner', assignment: { id: 'assignment-precise', executionKind: 'conversation' },
			executor: { id: 'chat', observe: async () => ({ available: true }), execute: async () => ({ status: 'responded', summary: 'Answered.', responseMarkdown: 'Ready.', usage: [{ activeSeconds: 3.01, elapsedSeconds: 4.99 }] }) } });
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-precise', expect.objectContaining({ activeSeconds: 4, elapsedSeconds: 5 }), expect.any(String));
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
