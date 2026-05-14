import {
	normalizeTaskAdmissionPolicy,
	normalizeTaskPlanProposal,
	validateTaskPlanProposal,
	type PlannedTaskNode,
	type TaskAdmissionDecision,
	type TaskClassification,
	type TaskPlanProposal,
	type WorkdayPolicy,
} from '@treeseed/sdk';

type TaskPayload = Record<string, unknown>;
type TaskRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function parseJsonString(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function proposalTasksFromPayload(payload: TaskPayload): PlannedTaskNode[] {
	const direct = Array.isArray(payload.proposedTasks) ? payload.proposedTasks : [];
	const planning = isRecord(payload.planning) ? payload.planning : {};
	const nested = Array.isArray(planning.proposedTasks) ? planning.proposedTasks : [];
	return [...direct, ...nested]
		.filter(isRecord)
		.map((entry) => entry as PlannedTaskNode);
}

export function planningDepthForPayload(payload: TaskPayload) {
	const planning = isRecord(payload.planning) ? payload.planning : {};
	const value = Number(payload.planningDepth ?? planning.planningDepth ?? 0);
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildPlanningTaskPayload(input: {
	sourceTaskId: string;
	sourceTaskType: string;
	sourcePayload: TaskPayload;
	classification: TaskClassification;
	admission: TaskAdmissionDecision;
	policy: WorkdayPolicy;
	planningDepth?: number;
	now?: Date;
}): TaskPayload {
	const policySnapshot = normalizeTaskAdmissionPolicy(input.admission.policySnapshot ?? input.policy.metadata ?? {});
	const proposedTasks = proposalTasksFromPayload(input.sourcePayload);
	return {
		executionKind: 'planning',
		taskSignature: policySnapshot.planningTaskSignature,
		mutationScope: 'none',
		risk: 'low',
		confidence: 'high',
		planning: {
			sourceTaskId: input.sourceTaskId,
			sourceTaskType: input.sourceTaskType,
			sourcePayload: input.sourcePayload,
			sourceClassification: input.classification,
			sourceAdmission: input.admission,
			planningDepth: Math.max(0, Math.floor(input.planningDepth ?? 0)),
			policySnapshot,
			proposedTasks,
		},
		createdAt: (input.now ?? new Date()).toISOString(),
	};
}

export function buildPlanningProposalFromTask(input: {
	task: TaskRecord;
	payload?: TaskPayload | null;
	now?: Date;
}): TaskPlanProposal {
	const payload = input.payload ?? parseJsonString(input.task.payloadJson ?? input.task.payload_json);
	const planning = isRecord(payload.planning) ? payload.planning : {};
	const sourceTaskId = readString(planning.sourceTaskId) || readString(input.task.parentTaskId) || readString(input.task.parent_task_id) || readString(input.task.id);
	const sourceTaskType = readString(planning.sourceTaskType) || 'task';
	const policySnapshot = isRecord(planning.policySnapshot) ? planning.policySnapshot : {};
	const proposedTasks = proposalTasksFromPayload(payload);
	const proposal = normalizeTaskPlanProposal({
		schemaVersion: 1,
		planId: `${readString(input.task.id) || sourceTaskId}:proposal`,
		sourceTaskId,
		parentTaskId: readString(input.task.id) || null,
		planningDepth: planningDepthForPayload(payload),
		tasks: proposedTasks,
		createdAt: (input.now ?? new Date()).toISOString(),
		metadata: {
			sourceTaskType,
			sourceClassification: isRecord(planning.sourceClassification) ? planning.sourceClassification : null,
			sourceAdmission: isRecord(planning.sourceAdmission) ? planning.sourceAdmission : null,
		},
	}, policySnapshot);
	const validation = validateTaskPlanProposal(proposal, policySnapshot);
	return {
		...proposal,
		metadata: {
			...(proposal.metadata ?? {}),
			valid: validation.ok,
			validationReasons: validation.reasons,
			rejectedNodes: validation.rejected,
		},
	};
}

export function extractPlanningProposalFromOutput(output: unknown): TaskPlanProposal | null {
	const record = isRecord(output) ? output : {};
	const proposal = isRecord(record.planningProposal) ? record.planningProposal : isRecord(record.proposal) ? record.proposal : {};
	if (!Object.keys(proposal).length) {
		return null;
	}
	return normalizeTaskPlanProposal(proposal, isRecord(proposal.metadata) ? proposal.metadata : undefined);
}
