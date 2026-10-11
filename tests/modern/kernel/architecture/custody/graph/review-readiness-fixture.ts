import { assignmentAttemptSchema, assignmentResultSchema, executionEdgeSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../../provider-kernel-fixture.ts';

/** Supplied graph/read-back inputs, never generated governance or model evidence. */
export function reviewedGraphFixture() {
	const base = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const at = (second: number) => `2026-09-13T12:00:0${second}.000Z`;
	const assignments = ['actor', 'review', 'next'].map((nodeId, index) => {
		const reviewer = nodeId === 'review', workItemId = nodeId === 'next' ? 'next' : 'first';
		const attempt = assignmentAttemptSchema.parse({ ...base, id: `attempt-${nodeId}`, idempotencyKey: `attempt-${nodeId}`,
			nodeId, workItemId, createdAt: at(index * 2), leaseId: `lease-${nodeId}`, reservationId: `reservation-${nodeId}`,
			agentClass: reviewer ? 'configured-auditor' : 'configured-author',
			effectiveProfile: { ...base.effectiveProfile, activity: reviewer ? 'reviewing' : 'acting',
				profileRef: { ...base.effectiveProfile.profileRef, id: reviewer ? 'configured-auditor' : 'configured-author' } },
			predecessorResultIds: index === 0 ? [] : index === 1 ? ['result-actor'] : ['result-actor', 'result-review'] });
		return { id: attempt.id, teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId,
			executionNodeId: nodeId, executionNodeRevision: attempt.nodeRevision, status: 'completed', assignmentAttempt: attempt,
			createdAt: attempt.createdAt, completedAt: at(index * 2 + 1),
			assignmentResult: assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${nodeId}`,
				assignmentId: attempt.id, status: 'completed', summary: 'Supplied immutable read-back input.', references: [], verification: [],
				usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: at(index * 2 + 1) }),
			lifecycleOutput: { activityCompletion: { reviewDisposition: reviewer ? 'approved' : undefined } } };
	});
	const nodes = assignments.map(item => executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1',
		id: item.executionNodeId, teamId: base.teamId, projectId: base.projectId, workItemId: item.assignmentAttempt.workItemId,
		kind: item.executionNodeId === 'review' ? 'reviewing' : 'acting', pairRole: item.executionNodeId === 'review' ? 'reviewer' : 'actor',
		sourceRef: base.sourceRef, authorityRefs: base.authorityRefs, ruleRevision: 1, nodeRevision: 1, agentClass: item.assignmentAttempt.agentClass,
		status: 'completed', estimate: base.estimate, requiredCapabilities: [], requestedPermissions: base.effectiveProfile.permissionCeiling,
		workspace: 'git', acceptanceCriteria: base.acceptanceCriteria, maximumReviewCycles: 2, graphRevisionCreated: 1, graphRevisionUpdated: 1 }));
	const edges = [['paired', 'actor', 'review', 'review-pair'], ['dependent', 'review', 'next', 'work-item']].map(([id, fromNodeId, toNodeId, provenance]) =>
		executionEdgeSchema.parse({ schemaVersion: 'treeseed.execution-edge/v1', id, teamId: base.teamId, fromNodeId, toNodeId,
			provenance, sourceRef: base.sourceRef, graphRevisionCreated: 1 }));
	return { graph: { teamId: base.teamId, revision: 1, digest: `sha256:${'d'.repeat(64)}`, nodes, edges }, assignments };
}
