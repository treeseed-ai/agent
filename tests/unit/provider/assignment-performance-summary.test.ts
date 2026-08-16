import { describe,expect,it } from 'vitest';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentPerformanceSummary } from '../../../src/provider/capacity/assignments/performance-summary.ts';

describe('assignment performance attribution', () => {
	it('records configuration revisions and receipt-linked downstream outcomes', () => {
		const assignment = { id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', projectAgentClassId: 'engineer',
			capacityProviderId: 'provider-1', mode: 'acting', attemptCount: 0, metadata: { planningGraphRevision: 'graph-4', agentDefinitionRevision: 'agent-8' } } as ProviderAssignment;
		const downstreamOutcomes = [{ kind: 'integration' as const, status: 'integrated', evidenceRefs: ['checkpoint:abc'],
			artifactMutationReceiptIds: ['receipt-1'], proposalId: 'proposal-1', proposalVersion: 2, occurredAt: '2026-08-13T12:00:00.000Z' }];
		const summary = buildAssignmentPerformanceSummary({ assignment, disposition: 'completed', reason: 'done', capacityEnvelope: {}, usage: {}, activeSeconds: 3,
			elapsedSeconds: 10,preparationSeconds:4,executionSeconds:3,closeoutSeconds:3, completion: { downstreamOutcomes } });
		expect(summary.schemaVersion).toBe('treeseed.assignment-performance/v2');
		expect(summary.configuration).toMatchObject({ planningGraphRevision: 'graph-4', agentDefinitionRevision: 'agent-8' });
		expect(summary.downstreamOutcomes).toEqual(downstreamOutcomes);
		expect(summary.actual).toMatchObject({preparationSeconds:4,executionSeconds:3,closeoutSeconds:3,custodySeconds:10,activeSeconds:3});
	});
});
