import { describe, expect, it, vi } from 'vitest';
import { runProviderAssignment } from '../../../src/provider/operations/runner.ts';
import type { AgentExecutionResult, AgentExecutor } from '../../../src/provider/execution/contracts.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const runtimeBuild = `sha256:${'b'.repeat(64)}`;
const responseReference = { kind: 'treedx', projectId: 'project', repository: 'repo_project', commit: 'a'.repeat(40), path: 'discussion-messages/response.mdx', workspaceId: 'workspace' };
const timingAwareness = {
	schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const,
	requiredChecks: 2 as const,
	completedChecks: 2,
	firstTool: 'treedx:treeseed_time_status' as const,
	firstToolSucceeded: true as const,
	lastTool: 'treedx:treeseed_time_status' as const,
	lastToolSucceeded: true as const,
	firstToolCompliant: true as const,
	finalToolCompliant: true as const,
};

function assignment(executionKind: 'workday' | 'conversation' = 'workday') {
	const attempt = {
		schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1',
		teamId: 'team', projectId: 'project', workdayId: executionKind === 'conversation' ? 'conversation-1' : 'workday-1',
		nodeId: 'node-1', agentClass: 'architect', workItemId: 'work-item', nodeRevision: 1, graphRevision: 1,
		sourceRef: { store: 'treedx', model: 'discussion', id: 'message-1', revision: 1, digest },
		authorityRefs: [{ store: 'treedx', model: 'discussion', id: 'message-1', revision: 1, digest }],
		effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/architect', revision: 1, digest },
			activity: 'chat', handler: 'writer', handlerOrigin: 'agent-package',
			prompt: { system: 'Research the authorized context and answer.' },
			permissionCeiling: { content: { read: [], write: [] }, tools: [] } },
		requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
		provider: { providerId: 'provider', offerId: 'offer', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild },
		contextRefs: [], predecessorResultIds: [], acceptanceCriteria: ['Return the exact result.'], workspace: { mode: 'read-only' },
		estimate: { minimumSeconds: 1, expectedSeconds: 10, maximumSeconds: 30 },
		limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
		deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1',
		attempt: 1, status: 'leased', createdAt: '2026-09-13T12:00:00.000Z',
	};
	return { id: attempt.id, stateVersion: 2, executionKind, assignmentAttempt: attempt,
		workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
}

function client() {
	return {
		assignment: vi.fn().mockResolvedValue({ id: 'assignment-1', stateVersion: 7 }),
		createAssignmentEvent: vi.fn().mockResolvedValue({ ok: true }),
		authorizeAssignmentSource: vi.fn(), createCommunicationTraceEvent: vi.fn().mockResolvedValue({ ok: true }),
		startAssignmentExecution: vi.fn().mockResolvedValue({ stateVersion: 3 }),
		renewAssignment: vi.fn().mockResolvedValue({ assignment: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }),
		startAssignmentCloseout: vi.fn().mockResolvedValue({ ok: true }),
		completeAssignment: vi.fn().mockResolvedValue({ status: 'completed' }),
		returnAssignment: vi.fn().mockResolvedValue({ status: 'returned' }),
		failAssignment: vi.fn().mockResolvedValue({ status: 'failed' }),
		reportAssignmentUsage: vi.fn().mockResolvedValue({ ok: true }),
		respondToAssignmentDiscussion: vi.fn().mockResolvedValue({ status: 'responded', reference: responseReference }),
		settleAssignment: vi.fn().mockResolvedValue({ replayed: false }),
	};
}

const treeDx = { projectId: 'project', handleId: 'handle-1', repositoryId: null, workspaceId: null, invoke: vi.fn() };

	describe('canonical provider assignment runner', () => {
	it('retains verified teardown outputs for failed and returned assignments', async () => {
		for (const status of ['failed', 'returned'] as const) {
			const api = client();
			await runProviderAssignment({ client: api, assignment: assignment(), treeDx,
				leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
				executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
					await request.beginExecution?.();
					return { status, code: status === 'failed' ? 'assignment_timeout' : 'sandbox_returned', summary: 'Stopped.', retryable: false,
						outputs: { sandboxId: 'sandbox-1', teardown: { verified: true, completedAt: '2026-09-27T08:25:11Z' } },
						usage: [{ activeSeconds: 12, elapsedSeconds: 15 }] };
				} } });
			const terminal = status === 'failed' ? api.failAssignment : api.returnAssignment;
			expect(terminal).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
				output: expect.objectContaining({ sandboxId: 'sandbox-1', teardown: { verified: true, completedAt: '2026-09-27T08:25:11Z' } }),
			}));
		}
	});
	it('stops productive accounting exactly once before teardown, including failure fallback', async () => {
		const api = client(), finished = vi.fn(async () => undefined);
		let now = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
		try {
			await runProviderAssignment({ client: api, assignment: assignment(), treeDx,
				leaseToken: 'lease', runnerId: 'runner', runtimeBuild, onActiveExecutionFinished: finished,
				executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
					await request.beginExecution?.();
					now = 2000;
					await request.finishExecution?.();
					await request.finishExecution?.();
					expect(finished).toHaveBeenCalledTimes(1);
					now = 100000; // Infrastructure teardown is elapsed time, not productive usage.
					throw new Error('Teardown failed after harness exit.');
				} } });
			expect(finished).toHaveBeenCalledTimes(1);
			expect(api.failAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
				usage: expect.objectContaining({ activeSeconds: 2, elapsedSeconds: 100 }),
			}));
		} finally { clock.mockRestore(); }
	});
	it('reports a productive timeout as terminal with measured active time', async () => {
		const api = client();
		let executionSignal: AbortSignal | undefined;
		await runProviderAssignment({ client: api, assignment: assignment(), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				executionSignal = request.signal;
				throw Object.assign(new Error('assignment_timeout'), { code: 'assignment_timeout',
					outputs: { teardown: { verified: true, completedAt: '2026-09-13T12:03:00.000Z' } } });
			} } });
		expect(executionSignal?.aborted).toBe(true);
		expect(api.returnAssignment).not.toHaveBeenCalled();
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			code: 'assignment_timeout', retryable: false, activeSeconds: 1,
			usage: expect.objectContaining({ activeSeconds: expect.any(Number), elapsedSeconds: expect.any(Number) }),
			output: { teardown: { verified: true, completedAt: '2026-09-13T12:03:00.000Z' } },
		}));
	});

	it('preserves provider-native failure usage in terminal settlement', async () => {
		const api = client();
		await runProviderAssignment({ client: api, assignment: assignment(), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'failed', code: 'assignment_timeout', summary: 'Expired.', retryable: false,
					usage: [{ activeSeconds: 12, elapsedSeconds: 15, inputTokens: 200 }] };
			} } });
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			activeSeconds: 12, elapsedSeconds: 15, usage: expect.objectContaining({ inputTokens: 200 }),
		}));
	});
	it('starts productive execution only after the executor finishes preparation', async () => {
		const api = client();
		let finishPreparation!: () => void;
		const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
		const running = runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await preparation;
				await request.beginExecution?.();
				return { status: 'responded', summary: 'Answered.', responseMarkdown: 'Prepared response.', outputs: { timingAwareness }, usage: [{ activeSeconds: 1, elapsedSeconds: 1 }] };
			} } });
		await Promise.resolve();
		expect(api.startAssignmentExecution).not.toHaveBeenCalled();
		finishPreparation();
		await running;
		expect(api.startAssignmentExecution).toHaveBeenCalledOnce();
	});

	it('runs workday execution through AgentKernel and settles the one general result', async () => {
		const api = client();
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => {
			await request.beginExecution?.();
			await request.emit?.({ type: 'execution.started', occurredAt: '2026-09-13T12:00:00.000Z', summary: 'Started.' });
			return { status: 'completed', summary: 'Evidence-backed answer.', outputs: { timingAwareness }, usage: [{ activeSeconds: 3, elapsedSeconds: 4 }] };
		}) };
		await runProviderAssignment({ client: api, executor, assignment: assignment(), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild });
		expect(executor.execute).toHaveBeenCalledOnce();
		expect(api.createAssignmentEvent).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ eventType: 'provider.execution.started' }));
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.not.objectContaining({ planRef: expect.anything() }));
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ expectedStateVersion: 7 }));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			output: expect.objectContaining({ assignmentResult: expect.objectContaining({ assignmentId: 'assignment-1' }) }),
		}));
	});

	it('uses the same canonical path for communication and publishes one durable response', async () => {
		const api = client();
		await runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.(); return {
				status: 'responded', summary: 'Answered.', responseMarkdown: 'Researched response.', outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3, inputTokens: 42, nativeUsage: { input_tokens: 42 } }],
			}; } } });
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ markdown: 'Researched response.' }), expect.any(String));
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledOnce();
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledBefore(api.settleAssignment);
		expect(api.settleAssignment).toHaveBeenCalledOnce();
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			usageActual: expect.objectContaining({ inputTokens: 42, nativeUsage: { input_tokens: 42 } }),
		}), expect.any(String));
		expect(api.startAssignmentCloseout).toHaveBeenCalledOnce();
		expect(api.startAssignmentCloseout).toHaveBeenCalledBefore(api.settleAssignment);
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			output: expect.objectContaining({ assignmentResult: expect.objectContaining({ references: [responseReference] }) }),
		}));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
		expect(api.returnAssignment).not.toHaveBeenCalled();
	});
	it('does not settle or complete a conversation when durable response publication fails', async () => {
		const api = client();
		api.respondToAssignmentDiscussion.mockRejectedValueOnce(new Error('publication unavailable'));
		await expect(runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'responded', summary: 'Answered.', responseMarkdown: 'Exact reply.', outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
			} } })).rejects.toThrow('publication unavailable');
		expect(api.settleAssignment).not.toHaveBeenCalled();
		expect(api.completeAssignment).not.toHaveBeenCalled();
		expect(api.returnAssignment).not.toHaveBeenCalled();
	});
	it('preserves a long discussion reply without overflowing the canonical summary', async () => {
		const api = client();
		const markdown = 'Useful source findings. '.repeat(300);
		await runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'responded', summary: markdown, responseMarkdown: markdown,
					outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
			} } });
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledWith('assignment-1',
			expect.objectContaining({ markdown }), expect.any(String));
		const completion = api.completeAssignment.mock.calls[0]?.[1];
		expect(completion.output.assignmentResult.summary.length).toBeLessThanOrEqual(4000);
		expect(completion.output.assignmentResult.references).toContainEqual(responseReference);
		expect(api.completeAssignment).toHaveBeenCalledOnce();
		expect(api.settleAssignment).toHaveBeenCalledOnce();
	});
	it('completes an optional abstention through the same general result and exact response reference', async () => {
		const api = client();
		await runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'abstained', summary: 'No relevant contribution.', outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
			} } });
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ outcome: 'abstained' }), expect.any(String));
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ output: expect.objectContaining({ assignmentResult: expect.objectContaining({ status: 'completed', references: [responseReference] }) }) }));
		expect(api.returnAssignment).not.toHaveBeenCalled();
	});
	it('rejects a path-only response receipt before closeout or settlement', async () => {
		const api = client();
		api.respondToAssignmentDiscussion.mockResolvedValueOnce({ status: 'responded' });
		await expect(runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'responded', summary: 'Answer.', responseMarkdown: 'Answer.', outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
			} } })).rejects.toThrow();
		expect(api.startAssignmentCloseout).not.toHaveBeenCalled();
		expect(api.settleAssignment).not.toHaveBeenCalled();
		expect(api.completeAssignment).not.toHaveBeenCalled();
	});
	it('does not complete or return a published response when its normal settlement fails', async () => {
		const api = client();
		api.settleAssignment.mockRejectedValueOnce(new Error('settlement unavailable'));
		await expect(runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				return { status: 'responded', summary: 'Answered.', responseMarkdown: 'Exact reply.', outputs: { timingAwareness }, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
			} } })).rejects.toThrow('settlement unavailable');
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledOnce();
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-1', expect.any(Object), 'assignment-settlement:assignment-1:runner');
		expect(api.completeAssignment).not.toHaveBeenCalled();
		expect(api.startAssignmentCloseout).toHaveBeenCalledOnce();
		expect(api.failAssignment).not.toHaveBeenCalled();
	});

	it('fails closed before provider execution when the canonical attempt is absent', async () => {
		const api = client(); const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		await runProviderAssignment({ client: api, assignment: { id: 'assignment-1', stateVersion: 2 }, treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild, executor });
		expect(executor.execute).not.toHaveBeenCalled();
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ code: 'assignment_attempt_invalid', retryable: false }));
	});

	it('aborts isolated execution and returns the assignment when lease renewal fails', async () => {
		const api = client(); api.renewAssignment.mockRejectedValueOnce(new Error('lease expired'));
		let signal: AbortSignal | undefined;
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
			await request.beginExecution?.();
			signal = request.signal;
			await new Promise<void>(resolve => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
			return { status: 'returned', summary: 'aborted' };
		} };
		await runProviderAssignment({ client: api, assignment: assignment(), treeDx, leaseToken: 'lease', runnerId: 'runner',
			runtimeBuild, executor, renewalIntervalMs: 1 });
		expect(signal?.aborted).toBe(true);
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.returnAssignment);
		expect(api.settleAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ activeSeconds: 1 }), expect.any(String));
		expect(api.returnAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ code: 'assignment_lease_renewal_failed' }));
	});

	it('keeps provider proxy credentials outside AgentKernel-visible assignment data', async () => {
		const api = client(); let visible: Record<string, unknown> | undefined;
		const value = assignment(); Object.assign(value, { treedxProxyHandle: { token: 'secret' } });
		Object.assign(value.workspaceContext, { treedxProxyHandle: { token: 'nested-secret' } });
		await runProviderAssignment({ client: api, assignment: value, treeDx, leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				await request.beginExecution?.();
				visible = request.assignment; return { status: 'completed', summary: 'done', outputs: { timingAwareness } };
			} } });
		expect(JSON.stringify(visible)).not.toContain('secret');
	});
});
