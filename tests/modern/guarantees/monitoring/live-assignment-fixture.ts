import { allocateWorkdayCapacity, calculateAssignmentAllocation, appliedWorkdaySchema, assignmentAttemptSchema, compileWorkday, DEFAULT_WORKDAY_POLICY, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import type { Row } from '../../../acceptance/acceptance-cli.ts';

// Controlled public assertion input only; never a real admission or usage receipt.
export function liveAssignmentRecord(attempt: AssignmentAttempt = assignmentAttemptSchema.parse({
	...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), deadline: '2026-09-13T13:00:00.000Z',
})): Row {
	const mode = ['acting', 'reviewing', 'reporting'].includes(attempt.effectiveProfile.activity) ? 'acting' : 'planning';
	const envelope = { teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId, mode,
		projectAgentClassId: 'opaque-configured-row', capacityProviderId: attempt.provider.providerId,
		executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId };
	const item = { id: attempt.id, membershipId: 'controlled-membership', ...envelope, stateVersion: 1, status: 'leased', leaseState: 'leased',
		createdAt: attempt.createdAt, updatedAt: attempt.createdAt, attemptCount: attempt.attempt, executionNodeId: attempt.nodeId,
		executionNodeRevision: attempt.nodeRevision, graphRevision: attempt.graphRevision, assignmentAttempt: structuredClone(attempt),
		capacityEnvelope: { ...envelope, requestedSeconds: attempt.limits.maximumSeconds, reservedSeconds: attempt.limits.maximumSeconds },
		workspaceContext: {}, allowedOutputs: {}, explanation: {} as Row, lifecycleOutput: {}, metadata: {} };
	const plan = appliedWorkdaySchema.parse(liveRun(item).parameters.appliedPlan), seconds = attempt.limits.maximumSeconds;
	const opportunity = allocateWorkdayCapacity({ remainingSeconds: seconds, now: attempt.createdAt,
		workdays: [{ plan, committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: seconds, actingReady: mode === 'acting' }] })[plan.id];
	item.explanation = { metadata: { allocation: { ...calculateAssignmentAllocation({ estimate: attempt.estimate,
		measurements: [], constraints: [{ id: 'shared-model', remainingSeconds: seconds }] }), opportunity } } };
	return item;
}
export function liveRun(item: Row): Row {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	const plan = compileWorkday({ id: attempt.workdayId, teamId: attempt.teamId, executionMode: 'simulation',
		policyId: 'default', policyRevision: 1, startsAt: attempt.createdAt, agentIds: [],
		policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600 } });
	plan.state = 'active'; // Controlled record represents already admitted work, not a prospective plan.
	return { id: attempt.workdayId, teamId: attempt.teamId, executionMode: 'simulation', startedAt: attempt.createdAt,
		parameters: { ...plan.policySnapshot, deadlineAt: plan.endsAt, appliedPlan: plan, scheduledProjectIds: [attempt.projectId] } };
}

// Controlled independent public graph input; this is not native SQL custody.
export function liveAssignmentGraph(item: Row): Row {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), conditionId = `${attempt.nodeId}.authority`;
	const common = { schemaVersion: 'treeseed.execution-node/v1', teamId: attempt.teamId, projectId: attempt.projectId,
		sourceRef: attempt.sourceRef, ruleRevision: 1, nodeRevision: attempt.nodeRevision,
		graphRevisionCreated: attempt.graphRevision, graphRevisionUpdated: attempt.graphRevision };
	return { teamId: attempt.teamId, revision: attempt.graphRevision, digest: `sha256:${'e'.repeat(64)}`, nodes: [
		{ ...common, id: attempt.nodeId, workdayId: attempt.workdayId, workItemId: attempt.workItemId,
			kind: attempt.effectiveProfile.activity === 'chat' ? 'communication' : attempt.effectiveProfile.activity,
			pairRole: attempt.effectiveProfile.activity === 'acting' ? 'actor' : null, maximumReviewCycles: 2,
			status: 'assigned', authorityRefs: attempt.authorityRefs, agentClass: attempt.agentClass,
			estimate: attempt.estimate, requiredCapabilities: attempt.requiredCapabilities,
			requestedPermissions: attempt.effectiveProfile.permissionCeiling, workspace: attempt.workspace.mode,
			...(attempt.acceptanceCriteria ? { acceptanceCriteria: attempt.acceptanceCriteria } : {}) },
		{ ...common, id: conditionId, kind: 'condition', pairRole: null, status: 'completed',
			condition: { conditionType: 'authority', subjectRef: attempt.authorityRefs[0], expectedState: 'accepted' } },
	], edges: [{ schemaVersion: 'treeseed.execution-edge/v1', id: `${attempt.nodeId}.governance`, teamId: attempt.teamId,
		fromNodeId: conditionId, toNodeId: attempt.nodeId, provenance: 'governance', sourceRef: attempt.sourceRef,
		graphRevisionCreated: attempt.graphRevision }] };
}
