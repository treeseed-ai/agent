import {vi} from 'vitest';
export const digest = `sha256:${'a'.repeat(64)}`;
export const runtimeBuild = `sha256:${'b'.repeat(64)}`;
export const responseReference = { kind: 'treedx', projectId: 'project', repository: 'repo_project', commit: 'a'.repeat(40), path: 'discussion-messages/response.mdx', workspaceId: 'workspace' };
export const timingAwareness = {
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

export function assignment(executionKind: 'workday' | 'conversation' = 'workday') {
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
		estimate: { expectedSeconds: 10, maximumSeconds: 30 },
		limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
		deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1',
		attempt: 1, status: 'leased', createdAt: '2026-09-13T12:00:00.000Z',
	};
	return { id: attempt.id, stateVersion: 2, executionKind, assignmentAttempt: attempt,
		workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
}

export function client() {
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

export const treeDx = { projectId: 'project', handleId: 'handle-1', repositoryId: null, workspaceId: null, invoke: vi.fn() };
