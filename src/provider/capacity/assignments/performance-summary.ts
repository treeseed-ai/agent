import {
	ASSIGNMENT_PERFORMANCE_SCHEMA, CAPACITY_BUDGET_SCHEMA, emptyCapacityBudget,
	type AgentArtifactManifest,type AssignmentPerformanceSummary, type AssignmentTerminalDisposition, type CapacityBudgetV2, type ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import { record, stringValue } from '../../configuration/value-utils.ts';

const number = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const strings = (value: unknown) => Array.isArray(value) ? value.map(String).filter(Boolean) : [];

export function buildAssignmentPerformanceSummary(input: {
	assignment: ProviderAssignment;
	disposition: AssignmentTerminalDisposition;
	reason: string;
	completion?: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	usage: Record<string, unknown>;
	activeSeconds: number;
	elapsedSeconds: number;
	preparationSeconds?: number;
	executionSeconds?: number;
	closeoutSeconds?: number;
	agentAssessment?: Record<string, unknown> | null;
	artifactManifest?: AgentArtifactManifest | null;
}): AssignmentPerformanceSummary {
	const assignment = input.assignment;
	const metadata = record(assignment.metadata);
	const completion = record(input.completion);
	const budgetCandidate = record(input.capacityEnvelope.budget);
	const budget = budgetCandidate.schemaVersion === CAPACITY_BUDGET_SCHEMA
		? budgetCandidate as unknown as CapacityBudgetV2
		: emptyCapacityBudget(stringValue(budgetCandidate.deadline) ?? new Date().toISOString(), number(record(budgetCandidate.time).requestedSeconds));
	const tokens = record(input.usage.tokens ?? input.usage);
	const cost = record(input.usage.cost);
	const revisions = record(metadata.configurationRevisions);
	const recordedOutcomes = Array.isArray(completion.downstreamOutcomes)
		? completion.downstreamOutcomes as AssignmentPerformanceSummary['downstreamOutcomes'] : [];
	const receiptOutcomes: AssignmentPerformanceSummary['downstreamOutcomes'] = (input.artifactManifest?.mutationReceipts ?? []).map((receipt) => ({
		kind: 'integration', status: receipt.phase, evidenceRefs: [receipt.before.ref,receipt.after.ref],
		artifactMutationReceiptIds: [receipt.id], occurredAt: receipt.createdAt,
	}));
	const verificationOutcomes: AssignmentPerformanceSummary['downstreamOutcomes'] = (input.artifactManifest?.verification ?? []).map((verification) => ({
		kind: 'validation', status: verification.status, evidenceRefs: verification.evidenceRefs ?? [], artifactMutationReceiptIds: [],
		occurredAt: input.artifactManifest?.createdAt ?? new Date().toISOString(),
	}));
	return {
		schemaVersion: ASSIGNMENT_PERFORMANCE_SCHEMA,
		assignmentId: assignment.id, workdayId: assignment.workDayId ?? null, teamId: assignment.teamId, projectId: assignment.projectId,
		agentId: assignment.agentId ?? null, agentClassId: assignment.projectAgentClassId,
		activityProfile: stringValue(metadata.activityProfile, metadata.activityType, assignment.mode) ?? assignment.mode,
		handlerId: assignment.handlerId ?? null, capacityProviderId: assignment.capacityProviderId,
		executionProviderId: assignment.executionProviderId ?? null, model: stringValue(metadata.model),
		groupIds: strings(metadata.groupIds),
		configuration: {
			planningGraphRevision: stringValue(revisions.planningGraphRevision, metadata.planningGraphRevision),
			agentDefinitionRevision: stringValue(revisions.agentDefinitionRevision, metadata.agentDefinitionRevision),
			agentClassRevision: stringValue(revisions.agentClassRevision, metadata.agentClassRevision),
			activityProfileRevision: stringValue(revisions.activityProfileRevision, metadata.activityProfileRevision),
			handlerRevision: stringValue(revisions.handlerRevision, metadata.handlerRevision),
			groupMembershipRevision: stringValue(revisions.groupMembershipRevision, metadata.groupMembershipRevision),
			executionProviderConfigurationRevision: stringValue(revisions.executionProviderConfigurationRevision, metadata.executionProviderConfigurationRevision),
		},
		taskSignature: stringValue(input.usage.taskSignature) ?? `${assignment.projectAgentClassId}:${assignment.mode}`,
		disposition: input.disposition, reason: input.reason,
		acceptanceChecks: Array.isArray(completion.acceptanceChecks) ? completion.acceptanceChecks as AssignmentPerformanceSummary['acceptanceChecks'] : [],
		completedScope: strings(completion.completedScope), remainingScope: strings(completion.remainingScope),
		artifactRefs: strings(completion.durableArtifactRefs), budget,
		actual: { preparationSeconds:number(input.preparationSeconds),executionSeconds:number(input.executionSeconds??input.activeSeconds),closeoutSeconds:number(input.closeoutSeconds),custodySeconds:input.elapsedSeconds,
			activeSeconds: input.activeSeconds, elapsedSeconds: input.elapsedSeconds,
			inputTokens: number(tokens.inputTokens ?? input.usage.promptTokens), cachedInputTokens: number(tokens.cachedInputTokens),
			reasoningTokens: number(tokens.reasoningTokens), outputTokens: number(tokens.outputTokens ?? input.usage.completionTokens),
			costAmount: cost.amount == null && input.usage.usd == null ? null : number(cost.amount ?? input.usage.usd),
			costCurrency: stringValue(cost.currency) ?? (input.usage.usd == null ? null : 'USD'),
			native: Array.isArray(input.usage.native) ? input.usage.native as AssignmentPerformanceSummary['actual']['native'] : [], attempts: number(assignment.attemptCount) + 1 },
		noUsefulScopedWorkRemaining: completion.noUsefulScopedWorkRemaining === true,
		agentAssessment: input.agentAssessment ?? null,
		systemAssessment: { generatedBy: 'agent-runner', measuredAt: new Date().toISOString(), enforcementConfidence: budget.enforcementConfidence },
		downstreamOutcomes: [...recordedOutcomes,...receiptOutcomes,...verificationOutcomes],
	};
}
