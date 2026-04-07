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

export interface AgentMessageContracts {
	question_priority_updated: QuestionPriorityUpdatedMessage;
	objective_priority_updated: ObjectivePriorityUpdatedMessage;
	architecture_updated: ArchitectureUpdatedMessage;
	subscriber_notified: SubscriberNotifiedMessage;
	research_started: ResearchStartedMessage;
	research_completed: ResearchCompletedMessage;
	task_complete: TaskCompleteMessage;
	task_waiting: TaskWaitingMessage;
	task_failed: TaskFailedMessage;
	task_verified: TaskVerifiedMessage;
	review_failed: ReviewFailedMessage;
	review_waiting: ReviewWaitingMessage;
	release_started: ReleaseStartedMessage;
	release_completed: ReleaseCompletedMessage;
	release_failed: ReleaseFailedMessage;
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
	'task_complete',
	'task_waiting',
	'task_failed',
	'task_verified',
	'review_failed',
	'review_waiting',
	'release_started',
	'release_completed',
	'release_failed',
] as const satisfies readonly AgentMessageType[];

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
