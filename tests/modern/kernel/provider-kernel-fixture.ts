import { vi } from 'vitest';
import type { AgentExecutionRequest } from '../../../src/provider/execution/contracts.ts';

export const commit = 'a'.repeat(40);
export const candidateCommit = 'b'.repeat(40);
export const digest = `sha256:${'c'.repeat(64)}`;
export const runtimeBuild = `sha256:${'d'.repeat(64)}`;
export const timingAwareness = {
	schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
	firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true,
	lastTool: 'treedx:treeseed_time_status', lastToolSucceeded: true,
	firstToolCompliant: true, finalToolCompliant: true,
};

export function request(): AgentExecutionRequest {
	const assignmentAttempt = {
		schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1',
		teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1', nodeId: 'node-1', agentClass: 'engineer', workItemId: 'implement-change', nodeRevision: 1, graphRevision: 1,
		sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal-1', revision: 1, digest },
		authorityRefs: [{ store: 'treedx', model: 'decision', id: 'decision-1', revision: 1, digest }],
		effectiveProfile: {
			profileRef: { store: 'treedx', model: 'agent', id: 'engineer', revision: 1, digest },
			activity: 'acting', handler: 'actor', handlerOrigin: 'agent-package',
			prompt: { system: 'Implement the accepted change.' },
			permissionCeiling: { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read', 'source.write'] },
		},
		requiredCapabilities: [],
		grant: { contentRead: [], contentWrite: [], sourceRead: ['treeseed-ai/sdk'], sourceWrite: ['treeseed-ai/sdk'], tools: ['source.read', 'source.write'] },
		provider: { providerId: 'provider-1', offerId: 'codex', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild },
		contextRefs: [{ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit }], predecessorResultIds: [],
		acceptanceCriteria: ['Commit the exact source change.'],
		workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: commit, branch: 'treeseed/assignments/assignment-1', writablePaths: ['src'] },
		estimate: { expectedSeconds: 10, maximumSeconds: 30 },
		limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
		deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1', attempt: 1,
		status: 'leased', createdAt: '2026-09-13T12:00:00.000Z',
	};
	return {
		assignment: { id: 'assignment-1', assignmentAttempt, workspaceContext: { assignmentAttempt, predecessorResults: [] } },
		assignmentId: 'assignment-1', leaseToken: 'lease-token', runnerId: 'runner-1',
		treeDx: { projectId: 'project-1', handleId: 'handle-1', repositoryId: null, workspaceId: null, invoke: vi.fn() },
	};
}
