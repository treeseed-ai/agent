import { campaignProposal, rewriteProposal } from '../preflight/proposals/campaign-proposals-fixture.ts';
import { exactContext } from '../../kernel/architecture/portable/context-fixture.ts';
import { allocateWorkdayCapacity, calculateAssignmentAllocation, appliedWorkdaySchema, assignmentAttemptSchema, exactEntityReferenceSchema, compileWorkday, DEFAULT_WORKDAY_POLICY, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { simulationSourceBranch } from '@treeseed/sdk/capacity-provider/sandbox';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import type { Row } from '../../../acceptance/acceptance-cli.ts';

// Controlled public assertion input only; never a real admission or usage receipt.
export function liveAssignmentRecord(input?: AssignmentAttempt): Row {
	const attempt = input ?? assignmentAttemptSchema.parse({
	...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), deadline: '2026-09-13T13:00:00.000Z',
});
	if (!input && attempt.workspace.mode === 'git') Object.assign(attempt.workspace, { branch: simulationSourceBranch('local', attempt.workdayId, attempt.id), writablePaths: ['.'] });
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
export function liveRun(item: Row) {
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

export function liveProviderSession(item: Row): Row {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	return { id: 'controlled-runtime-session', membershipId: item.membershipId, teamId: attempt.teamId,
		providerId: attempt.provider.providerId, openedAt: attempt.createdAt, refreshedAt: attempt.createdAt, status: 'open', sequence: 1,
		snapshot: { adapters: [{ id: attempt.provider.executionProviderId, runtimeBuild: attempt.provider.runtimeBuild,
			nativeLimits: { modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: 28800,
				capabilityLimits: { [attempt.provider.executionCapabilityId]: { dailyActiveSecondsLimit: 7200 } } } }] } };
}

/** Controlled independent governing bytes for owning context-reader tests. */
export function liveGovernedContext(attempt: AssignmentAttempt) {
	const source = attempt.contextRefs.find(ref => ref.store === 'git');
	if (!source?.commit || !source.repository || !attempt.workItemId) throw new Error('Original configured work item and source required');
	const book = exactContext(); book.response.files[0]!.frontmatter.projectId = attempt.projectId;
	const fixture = campaignProposal(0, source.commit, book.ref.commit, book.ref.commit);
	rewriteProposal(fixture, proposal => {
		proposal.projectId = attempt.projectId;
		const items = (proposal.executionPlan as { workItems: Array<Record<string, unknown>> }).workItems;
		for (const item of items) for (const ref of item.contextRefs as Array<Record<string, unknown>>)
			if (ref.store === 'git') Object.assign(ref, source);
		items[3]!.id = attempt.workItemId; (items[3]!.contextRefs as unknown[]).push(book.ref);
		if (attempt.workspace.mode === 'treedx') {
			items[3]!.workspace = 'treedx'; items[3]!.requestedPermissions = attempt.effectiveProfile.permissionCeiling;
			(items[3]!.contextRefs as unknown[]).push({ store: 'treedx', model: 'repository', id: 'mutable-library', repository: book.ref.repository, commit: book.ref.commit, path: '.' });
		}
		(proposal.executionPlan as { workItems: Array<Record<string, unknown>> }).workItems = [items[3]!];
	});
	const file = fixture.observed.files[0]!, reference = exactEntityReferenceSchema.parse({ store: 'treedx', model: 'proposal', id: fixture.expected.id,
		repository: book.ref.repository, commit: fixture.observed.resolvedRef, path: file.path, revision: 1,
		digest: `sha256:${fixture.governance.activeContentHash}` });
	return { reference, book, binding: { repositoryId: book.ref.repository, projectId: attempt.projectId },
		observed: { ...fixture.observed, repoId: book.ref.repository } };
}
