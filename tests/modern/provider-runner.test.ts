import { describe, expect, it, vi } from 'vitest';
import { runProviderAssignment } from '../../src/provider/operations/runner.ts';
import type { AgentExecutor } from '../../src/provider/execution/contracts.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const runtimeBuild = `sha256:${'b'.repeat(64)}`;

function assignment(executionKind: 'workday' | 'conversation' = 'workday') {
	const attempt = {
		schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1',
		teamId: 'team', projectId: 'project', workdayId: executionKind === 'conversation' ? 'conversation-1' : 'workday-1',
		nodeId: 'node-1', workItemId: 'work-item', nodeRevision: 1, graphRevision: 1,
		sourceRef: { store: 'treedx', model: 'discussion', id: 'message-1', revision: 1, digest },
		authorityRefs: [{ store: 'treedx', model: 'discussion', id: 'message-1', revision: 1, digest }],
		effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/architect', revision: 1, digest },
			activity: 'chat', handler: 'writer', handlerOrigin: 'agent-package',
			prompt: { system: 'Research the authorized context and answer.' },
			permissionCeiling: { content: { read: [], write: [] }, tools: [] } },
		requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
		provider: { providerId: 'provider', offerId: 'offer', offerRevision: 1, runtimeBuild },
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
		respondToAssignmentDiscussion: vi.fn().mockResolvedValue({ status: 'responded' }),
		settleAssignment: vi.fn().mockResolvedValue({ replayed: false }),
	};
}

const treeDx = { projectId: 'project', repositoryId: null, workspaceId: null, invoke: vi.fn() };

describe('canonical provider assignment runner', () => {
	it('runs workday execution through AgentKernel and settles the one general result', async () => {
		const api = client();
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async request => {
			await request.emit?.({ type: 'execution.started', occurredAt: '2026-09-13T12:00:00.000Z', summary: 'Started.' });
			return { status: 'completed', summary: 'Evidence-backed answer.', usage: [{ activeSeconds: 3, elapsedSeconds: 4 }] };
		}) };
		await runProviderAssignment({ client: api, executor, assignment: assignment(), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild });
		expect(executor.execute).toHaveBeenCalledOnce();
		expect(api.createAssignmentEvent).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ eventType: 'provider.execution.started' }));
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.not.objectContaining({ planRef: expect.anything() }));
		expect(api.settleAssignment).toHaveBeenCalledBefore(api.completeAssignment);
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			output: expect.objectContaining({ assignmentResult: expect.objectContaining({ assignmentId: 'assignment-1' }) }),
		}));
	});

	it('uses the same canonical path for communication and publishes one durable response', async () => {
		const api = client();
		await runProviderAssignment({ client: api, assignment: assignment('conversation'), treeDx,
			leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async () => ({
				status: 'responded', summary: 'Answered.', responseMarkdown: 'Researched response.', usage: [{ activeSeconds: 2, elapsedSeconds: 3 }],
			}) } });
		expect(api.respondToAssignmentDiscussion).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ markdown: 'Researched response.' }), expect.any(String));
		expect(api.settleAssignment).toHaveBeenCalledOnce();
		expect(api.startAssignmentCloseout).not.toHaveBeenCalled();
		expect(api.completeAssignment).not.toHaveBeenCalled();
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
			signal = request.signal;
			await new Promise<void>(resolve => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
			return { status: 'returned', summary: 'aborted' };
		} };
		await runProviderAssignment({ client: api, assignment: assignment(), treeDx, leaseToken: 'lease', runnerId: 'runner',
			runtimeBuild, executor, renewalIntervalMs: 1 });
		expect(signal?.aborted).toBe(true);
		expect(api.returnAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ code: 'assignment_lease_renewal_failed' }));
	});

	it('keeps provider proxy credentials outside AgentKernel-visible assignment data', async () => {
		const api = client(); let visible: Record<string, unknown> | undefined;
		const value = assignment(); Object.assign(value, { treedxProxyHandle: { token: 'secret' } });
		Object.assign(value.workspaceContext, { treedxProxyHandle: { token: 'nested-secret' } });
		await runProviderAssignment({ client: api, assignment: value, treeDx, leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
			executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
				visible = request.assignment; return { status: 'completed', summary: 'done' };
			} } });
		expect(JSON.stringify(visible)).not.toContain('secret');
	});
});
