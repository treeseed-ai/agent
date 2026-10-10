import { assignmentAttemptSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import type { Row } from '../../../acceptance/acceptance-cli.ts';

// Controlled public assertion input only; never a real admission or usage receipt.
export function liveAssignmentRecord(attempt: AssignmentAttempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt)): Row {
	const mode = ['acting', 'reviewing', 'reporting'].includes(attempt.effectiveProfile.activity) ? 'acting' : 'planning';
	const envelope = { teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId, mode,
		projectAgentClassId: 'opaque-configured-row', capacityProviderId: attempt.provider.providerId,
		executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId };
	return { id: attempt.id, membershipId: 'controlled-membership', ...envelope, stateVersion: 1, status: 'leased', leaseState: 'leased',
		createdAt: attempt.createdAt, updatedAt: attempt.createdAt, attemptCount: attempt.attempt, executionNodeId: attempt.nodeId,
		executionNodeRevision: attempt.nodeRevision, graphRevision: attempt.graphRevision, assignmentAttempt: structuredClone(attempt),
		capacityEnvelope: envelope, workspaceContext: {}, allowedOutputs: {}, explanation: {}, lifecycleOutput: {}, metadata: {} };
}
export function liveRun(item: Row): Row {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	return { id: attempt.workdayId, teamId: attempt.teamId, executionMode: 'simulation', startedAt: attempt.createdAt,
		parameters: { scheduledProjectIds: [attempt.projectId] } };
}
