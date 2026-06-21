export interface QuestionPriorityUpdatedMessage {
	questionId: string;
	reason: string;
	plannerRunId: string;
}

export interface ObjectivePriorityUpdatedMessage {
	objectiveId: string;
	reason: string;
	plannerRunId: string;
}

export interface ArchitectureUpdatedMessage {
	objectiveId: string;
	knowledgeId: string;
	architectRunId: string;
}

export interface SubscriberNotifiedMessage {
	email: string;
	itemCount: number;
	notifierRunId: string;
}

export interface ResearchStartedMessage {
	questionId: string;
	researcherRunId: string;
}

export interface ResearchCompletedMessage {
	questionId: string;
	knowledgeId: string | null;
	researcherRunId: string;
}

export interface KnowledgeDraftCreatedMessage {
	draftId: string;
	targetPath: string;
	sourceQuestionId: string;
	sourceResearchIds: string[];
	generatorRunId: string;
}

export interface KnowledgeOptimizationCompletedMessage {
	reportId: string;
	draftId: string;
	recommendation: string;
	totalScore: number;
	optimizerRunId: string;
}

export interface TaskCompleteMessage {
	branchName: string | null;
	changedTargets: string[];
	engineerRunId: string;
}

export interface TaskWaitingMessage {
	blockingReason: string;
	engineerRunId: string;
}

export interface TaskFailedMessage {
	failureSummary: string;
	engineerRunId: string;
}

export interface TaskVerifiedMessage {
	branchName: string | null;
	reviewerRunId: string;
}

export interface ReviewFailedMessage {
	failureSummary: string;
	reviewerRunId: string;
}

export interface ReviewWaitingMessage {
	blockingReason: string;
	reviewerRunId: string;
}

export interface ReleaseStartedMessage {
	taskRunId: string | null;
	releaserRunId: string;
}

export interface ReleaseCompletedMessage {
	releaseSummary: string;
	releaserRunId: string;
}

export interface ReleaseFailedMessage {
	failureSummary: string;
	releaserRunId: string;
}

export interface DocumentationAutomationEventMessage extends Record<string, unknown> {
	summary?: string;
	agentRunId?: string;
}

export interface AgentMessageContracts {
	question_priority_updated: QuestionPriorityUpdatedMessage;
	objective_priority_updated: ObjectivePriorityUpdatedMessage;
	architecture_updated: ArchitectureUpdatedMessage;
	subscriber_notified: SubscriberNotifiedMessage;
	research_started: ResearchStartedMessage;
	research_completed: ResearchCompletedMessage;
	knowledge_draft_created: KnowledgeDraftCreatedMessage;
	knowledge_optimization_completed: KnowledgeOptimizationCompletedMessage;
	task_complete: TaskCompleteMessage;
	task_waiting: TaskWaitingMessage;
	task_failed: TaskFailedMessage;
	task_verified: TaskVerifiedMessage;
	review_failed: ReviewFailedMessage;
	review_waiting: ReviewWaitingMessage;
	release_started: ReleaseStartedMessage;
	release_completed: ReleaseCompletedMessage;
	release_failed: ReleaseFailedMessage;
	documentation_gap_detected: DocumentationAutomationEventMessage;
	research_task_requested: DocumentationAutomationEventMessage;
	documentation_plan_updated: DocumentationAutomationEventMessage;
	codebase_inventory_completed: DocumentationAutomationEventMessage;
	research_note_created: DocumentationAutomationEventMessage;
	source_map_created: DocumentationAutomationEventMessage;
	knowledge_gap_detected: DocumentationAutomationEventMessage;
	draft_requires_context: DocumentationAutomationEventMessage;
	promotion_request_created: DocumentationAutomationEventMessage;
	revision_requested: DocumentationAutomationEventMessage;
	draft_rejected: DocumentationAutomationEventMessage;
	docs_mutation_completed: DocumentationAutomationEventMessage;
	docs_mutation_waiting_for_review: DocumentationAutomationEventMessage;
	docs_mutation_failed: DocumentationAutomationEventMessage;
	repair_task_created: DocumentationAutomationEventMessage;
	review_passed: DocumentationAutomationEventMessage;
	human_approval_recommended: DocumentationAutomationEventMessage;
	approval_request_created: DocumentationAutomationEventMessage;
	governance_item_created: DocumentationAutomationEventMessage;
	policy_violation_detected: DocumentationAutomationEventMessage;
	approval_ready_for_human: DocumentationAutomationEventMessage;
	workday_report_created: DocumentationAutomationEventMessage;
	project_summary_updated: DocumentationAutomationEventMessage;
	team_inbox_item_created: DocumentationAutomationEventMessage;
	release_candidate_created: DocumentationAutomationEventMessage;
	release_waiting_for_approval: DocumentationAutomationEventMessage;
	knowledge_generated: DocumentationAutomationEventMessage;
	knowledge_optimized: DocumentationAutomationEventMessage;
	report_created: DocumentationAutomationEventMessage;
	distribution_digest_ready: DocumentationAutomationEventMessage;
}

export type AgentMessageType = keyof AgentMessageContracts;
export type AgentMessagePayload<TType extends AgentMessageType> = AgentMessageContracts[TType];
export const AGENT_MESSAGE_TYPES = [
	'question_priority_updated',
	'objective_priority_updated',
	'architecture_updated',
	'subscriber_notified',
	'research_started',
	'research_completed',
	'knowledge_draft_created',
	'knowledge_optimization_completed',
	'task_complete',
	'task_waiting',
	'task_failed',
	'task_verified',
	'review_failed',
	'review_waiting',
	'release_started',
	'release_completed',
	'release_failed',
	'documentation_gap_detected',
	'research_task_requested',
	'documentation_plan_updated',
	'codebase_inventory_completed',
	'research_note_created',
	'source_map_created',
	'knowledge_gap_detected',
	'draft_requires_context',
	'promotion_request_created',
	'revision_requested',
	'draft_rejected',
	'docs_mutation_completed',
	'docs_mutation_waiting_for_review',
	'docs_mutation_failed',
	'repair_task_created',
	'review_passed',
	'human_approval_recommended',
	'approval_request_created',
	'governance_item_created',
	'policy_violation_detected',
	'approval_ready_for_human',
	'workday_report_created',
	'project_summary_updated',
	'team_inbox_item_created',
	'release_candidate_created',
	'release_waiting_for_approval',
	'knowledge_generated',
	'knowledge_optimized',
	'report_created',
	'distribution_digest_ready',
] as const satisfies readonly AgentMessageType[];

const DOCUMENTATION_AUTOMATION_MESSAGE_TYPES = new Set<string>([
	'documentation_gap_detected',
	'research_task_requested',
	'documentation_plan_updated',
	'codebase_inventory_completed',
	'research_note_created',
	'source_map_created',
	'knowledge_gap_detected',
	'draft_requires_context',
	'promotion_request_created',
	'revision_requested',
	'draft_rejected',
	'docs_mutation_completed',
	'docs_mutation_waiting_for_review',
	'docs_mutation_failed',
	'repair_task_created',
	'review_passed',
	'human_approval_recommended',
	'approval_request_created',
	'governance_item_created',
	'policy_violation_detected',
	'approval_ready_for_human',
	'workday_report_created',
	'project_summary_updated',
	'team_inbox_item_created',
	'release_candidate_created',
	'release_waiting_for_approval',
	'knowledge_generated',
	'knowledge_optimized',
	'report_created',
	'distribution_digest_ready',
]);

function ensureString(value: unknown, label: string) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Invalid ${label}: expected non-empty string.`);
	}
	return value;
}

function ensureOptionalString(value: unknown, label: string) {
	if (value === null || value === undefined) {
		return null;
	}
	return ensureString(value, label);
}

function ensureStringArray(value: unknown, label: string) {
	if (!Array.isArray(value)) {
		throw new Error(`Invalid ${label}: expected array.`);
	}
	return value.map((entry, index) => ensureString(entry, `${label}[${index}]`));
}

function ensureNumber(value: unknown, label: string) {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(`Invalid ${label}: expected number.`);
	}
	return value;
}

export function parseAgentMessagePayload<TType extends AgentMessageType>(
	type: TType,
	payloadJson: string,
): AgentMessagePayload<TType> {
	const parsed = JSON.parse(payloadJson) as Record<string, unknown>;

	switch (type) {
		case 'question_priority_updated':
			return {
				questionId: ensureString(parsed.questionId, 'questionId'),
				reason: ensureString(parsed.reason, 'reason'),
				plannerRunId: ensureString(parsed.plannerRunId, 'plannerRunId'),
			} as AgentMessagePayload<TType>;
		case 'objective_priority_updated':
			return {
				objectiveId: ensureString(parsed.objectiveId, 'objectiveId'),
				reason: ensureString(parsed.reason, 'reason'),
				plannerRunId: ensureString(parsed.plannerRunId, 'plannerRunId'),
			} as AgentMessagePayload<TType>;
		case 'architecture_updated':
			return {
				objectiveId: ensureString(parsed.objectiveId, 'objectiveId'),
				knowledgeId: ensureString(parsed.knowledgeId, 'knowledgeId'),
				architectRunId: ensureString(parsed.architectRunId, 'architectRunId'),
			} as AgentMessagePayload<TType>;
		case 'subscriber_notified':
			return {
				email: ensureString(parsed.email, 'email'),
				itemCount: ensureNumber(parsed.itemCount, 'itemCount'),
				notifierRunId: ensureString(parsed.notifierRunId, 'notifierRunId'),
			} as AgentMessagePayload<TType>;
		case 'research_started':
			return {
				questionId: ensureString(parsed.questionId, 'questionId'),
				researcherRunId: ensureString(parsed.researcherRunId, 'researcherRunId'),
			} as AgentMessagePayload<TType>;
		case 'research_completed':
			return {
				questionId: ensureString(parsed.questionId, 'questionId'),
				knowledgeId: ensureOptionalString(parsed.knowledgeId, 'knowledgeId'),
				researcherRunId: ensureString(parsed.researcherRunId, 'researcherRunId'),
			} as AgentMessagePayload<TType>;
		case 'knowledge_draft_created':
			return {
				draftId: ensureString(parsed.draftId, 'draftId'),
				targetPath: ensureString(parsed.targetPath, 'targetPath'),
				sourceQuestionId: ensureString(parsed.sourceQuestionId, 'sourceQuestionId'),
				sourceResearchIds: ensureStringArray(parsed.sourceResearchIds, 'sourceResearchIds'),
				generatorRunId: ensureString(parsed.generatorRunId, 'generatorRunId'),
			} as AgentMessagePayload<TType>;
		case 'knowledge_optimization_completed':
			return {
				reportId: ensureString(parsed.reportId, 'reportId'),
				draftId: ensureString(parsed.draftId, 'draftId'),
				recommendation: ensureString(parsed.recommendation, 'recommendation'),
				totalScore: ensureNumber(parsed.totalScore, 'totalScore'),
				optimizerRunId: ensureString(parsed.optimizerRunId, 'optimizerRunId'),
			} as AgentMessagePayload<TType>;
		case 'task_complete':
			return {
				branchName: ensureOptionalString(parsed.branchName, 'branchName'),
				changedTargets: ensureStringArray(parsed.changedTargets, 'changedTargets'),
				engineerRunId: ensureString(parsed.engineerRunId, 'engineerRunId'),
			} as AgentMessagePayload<TType>;
		case 'task_waiting':
			return {
				blockingReason: ensureString(parsed.blockingReason, 'blockingReason'),
				engineerRunId: ensureString(parsed.engineerRunId, 'engineerRunId'),
			} as AgentMessagePayload<TType>;
		case 'task_failed':
			return {
				failureSummary: ensureString(parsed.failureSummary, 'failureSummary'),
				engineerRunId: ensureString(parsed.engineerRunId, 'engineerRunId'),
			} as AgentMessagePayload<TType>;
		case 'task_verified':
			return {
				branchName: ensureOptionalString(parsed.branchName, 'branchName'),
				reviewerRunId: ensureString(parsed.reviewerRunId, 'reviewerRunId'),
			} as AgentMessagePayload<TType>;
		case 'review_failed':
			return {
				failureSummary: ensureString(parsed.failureSummary, 'failureSummary'),
				reviewerRunId: ensureString(parsed.reviewerRunId, 'reviewerRunId'),
			} as AgentMessagePayload<TType>;
		case 'review_waiting':
			return {
				blockingReason: ensureString(parsed.blockingReason, 'blockingReason'),
				reviewerRunId: ensureString(parsed.reviewerRunId, 'reviewerRunId'),
			} as AgentMessagePayload<TType>;
		case 'release_started':
			return {
				taskRunId: ensureOptionalString(parsed.taskRunId, 'taskRunId'),
				releaserRunId: ensureString(parsed.releaserRunId, 'releaserRunId'),
			} as AgentMessagePayload<TType>;
		case 'release_completed':
			return {
				releaseSummary: ensureString(parsed.releaseSummary, 'releaseSummary'),
				releaserRunId: ensureString(parsed.releaserRunId, 'releaserRunId'),
			} as AgentMessagePayload<TType>;
		case 'release_failed':
			return {
				failureSummary: ensureString(parsed.failureSummary, 'failureSummary'),
				releaserRunId: ensureString(parsed.releaserRunId, 'releaserRunId'),
			} as AgentMessagePayload<TType>;
		default:
			if (DOCUMENTATION_AUTOMATION_MESSAGE_TYPES.has(type)) {
				return parsed as AgentMessagePayload<TType>;
			}
			throw new Error(`Unsupported message type "${type}".`);
	}
}

export function serializeAgentMessagePayload<TType extends AgentMessageType>(
	type: TType,
	payload: AgentMessagePayload<TType>,
) {
	parseAgentMessagePayload(type, JSON.stringify(payload));
	return payload as unknown as Record<string, unknown>;
}
