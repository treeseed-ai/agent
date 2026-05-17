import type { AgentSdk, ApprovalRequest } from '@treeseed/sdk';
import {
	decideAgentOperationPermission,
	deniedAgentOperationResult,
	isAgentOperationName,
	type AgentOperationGrant,
	type AgentOperationName,
	type AgentOperationRequest,
	type AgentOperationResult,
} from '@treeseed/sdk/operations/agent-tools';
import type { KnowledgeDraft, OptimizationReport } from '../agents/contracts/knowledge.ts';
import type { ResearchNote } from '../agents/contracts/research.ts';
import { createOperationsAdapter } from '../agents/adapters/operations.ts';
import {
	defaultReleaseGrant,
	PROMOTION_APPROVAL_DECISIONS,
	RELEASE_APPROVAL_DECISIONS,
	type AgentApprovalKind,
} from '../services/knowledge-promotion.ts';
import {
	RESEARCH_KNOWLEDGE_TASK_KINDS,
	extractGeneratedArtifactsFromTaskOutputs,
	followupTaskIdempotencyKey,
	summarizeKnowledgeDraftArtifact,
	summarizeOptimizationReportArtifact,
	summarizePromotionRequestArtifact,
	summarizeReleaseRequestArtifact,
	summarizeResearchNoteArtifact,
	type GeneratedAgentArtifactSummary,
} from '../services/research-knowledge-workday.ts';

type SdkLike = Pick<AgentSdk, 'searchTasks' | 'search' | 'appendTaskEvent'> & Partial<Pick<AgentSdk,
	'createTask' | 'listApprovalRequests' | 'decideApprovalRequest' | 'upsertTeamInboxItem' | 'listWorkerRunners' | 'listWorkdayManagerLeases'
>>;

export interface AgentArtifactApiItem extends GeneratedAgentArtifactSummary {
	workDayId?: string;
	taskType?: string;
	taskState?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentArtifactApiState {
	projectId: string;
	artifacts: AgentArtifactApiItem[];
	researchNotes: Array<{
		taskId?: string;
		workDayId?: string;
		createdAt?: string;
		researchNote: ResearchNote;
	}>;
	knowledgeDrafts: Array<{
		taskId?: string;
		workDayId?: string;
		createdAt?: string;
		knowledgeDraft: KnowledgeDraft;
	}>;
	optimizationReports: Array<{
		taskId?: string;
		workDayId?: string;
		createdAt?: string;
		optimizationReport: OptimizationReport;
	}>;
	approvals: AgentApprovalRequestSummary[];
	currentWorkday: Record<string, unknown> | null;
	reports: Array<Record<string, unknown>>;
	taskHealth: {
		activeTasks: Record<string, unknown>[];
		staleTasks: Record<string, unknown>[];
		recoveredTaskCount: number;
		failedStaleTaskCount: number;
		retryBackoffPolicy: {
			baseSeconds: number;
			maxSeconds: number;
		};
	};
	workerRunners: Record<string, unknown>[];
	managerLease: Record<string, unknown> | null;
	warnings: string[];
}

export interface AgentOperationGrantSummary {
	id: string;
	taskId?: string;
	workDayId?: string;
	taskType?: string;
	state?: string;
	operations: string[];
	modes: string[];
	agentRoles?: string[];
	taskKinds?: string[];
	projectIds?: string[];
	environments?: string[];
	allowedPaths?: string[];
	forbiddenPaths?: string[];
	requiresApproval?: boolean;
	approvalIds?: string[];
	source: 'task_payload' | 'task_output';
}

export interface AgentOperationEventSummary {
	id: string;
	taskId?: string;
	workDayId?: string;
	taskType?: string;
	seq?: number;
	source: 'task_event' | 'task_output';
	operation: string;
	mode?: string;
	agentRole?: string;
	permissionGrantId?: string;
	status?: string;
	summary?: string;
	changedPaths: string[];
	stagedPaths: string[];
	mergedToStaging?: boolean;
	mergeFailure?: Record<string, unknown>;
	error?: Record<string, unknown>;
	createdAt?: string;
}

export interface AgentOperationLifecycleSummary {
	worktreeSnapshots: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
	stagingMerges: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
	mergeFailures: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
	repairTasks: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
	releaseApprovals: AgentApprovalRequestSummary[];
	releaseResults: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
	codexUsage: Array<Record<string, unknown> & { taskId?: string; workDayId?: string; taskType?: string }>;
}

export interface AgentOperationApiState {
	projectId: string;
	grants: AgentOperationGrantSummary[];
	events: AgentOperationEventSummary[];
	lifecycle: AgentOperationLifecycleSummary;
	warnings: string[];
}

export interface AgentApprovalRequestSummary {
	id: string;
	approvalKind: AgentApprovalKind | string;
	taskId: string;
	workDayId?: string;
	taskState?: string;
	state?: string;
	severity?: string;
	title?: string;
	summary?: string;
	draftId?: string;
	targetPath?: string;
	recommendation?: string;
	totalScore?: number;
	sourceQuestionId?: string;
	sourceResearchIds?: string[];
	sourceResearchNoteId?: string;
	optimizationReportId?: string;
	featureBranch?: string;
	stagingBranch?: string;
	changedPaths?: string[];
	options?: Record<string, unknown>[];
	policySnapshot?: Record<string, unknown>;
	artifactRefs?: Record<string, unknown>[];
	sourceMapRefs?: Record<string, unknown>[];
	verificationPlan?: Record<string, unknown>;
	decision?: Record<string, unknown> | null;
	releaseInput?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
	payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function parseJsonObject(value: unknown, warnings: string[], label: string) {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string' || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return asRecord(parsed);
	} catch {
		warnings.push(`Skipped malformed JSON for ${label}.`);
		return {};
	}
}

function parseTaskPayload(task: Record<string, unknown>, warnings: string[]) {
	return parseJsonObject(task.payloadJson ?? task.payload_json, warnings, `task ${readString(task, 'id')} payload`);
}

function parseTaskOutput(output: Record<string, unknown>, warnings: string[]) {
	return parseJsonObject(output.outputJson ?? output.output_json, warnings, `task output ${readString(output, 'id')}`);
}

function parseEventData(event: Record<string, unknown>, warnings: string[]) {
	return parseJsonObject(event.dataJson ?? event.data_json ?? event.data, warnings, `task event ${readString(event, 'id')}`);
}

function parseReportBody(report: Record<string, unknown>, warnings: string[]) {
	return parseJsonObject(report.bodyJson ?? report.body_json, warnings, `report ${readString(report, 'id')} body`);
}

function taskId(task: Record<string, unknown>) {
	return readString(task, 'id');
}

function taskWorkDayId(task: Record<string, unknown>) {
	return readString(task, 'workDayId', 'work_day_id') || undefined;
}

function taskType(task: Record<string, unknown>) {
	return readString(task, 'type');
}

function taskState(task: Record<string, unknown>) {
	return readString(task, 'state') || undefined;
}

function taskCreatedAt(task: Record<string, unknown>) {
	return readString(task, 'createdAt', 'created_at') || undefined;
}

function taskUpdatedAt(task: Record<string, unknown>) {
	return readString(task, 'updatedAt', 'updated_at') || undefined;
}

function taskById(tasks: Record<string, unknown>[]) {
	return new Map(tasks.map((task) => [taskId(task), task]).filter(([id]) => Boolean(id)) as Array<[string, Record<string, unknown>]>);
}

function hasResearchKnowledgeOutput(output: Record<string, unknown>) {
	if (
		output.codebaseInventory
		|| output.researchNote
		|| output.knowledgeDraft
		|| output.optimizationReport
		|| output.promotionRequest
		|| output.docsMutationResult
		|| output.promotionToStaging
		|| output.implementationResult
		|| output.releaseRequest
	) return true;
	if (Array.isArray(output.generatedArtifacts) && output.generatedArtifacts.length > 0) return true;
	return false;
}

function attachTask(summary: GeneratedAgentArtifactSummary, task: Record<string, unknown>): AgentArtifactApiItem {
	return {
		...summary,
		taskId: summary.taskId || taskId(task) || undefined,
		workDayId: taskWorkDayId(task),
		taskType: taskType(task) || undefined,
		taskState: taskState(task),
		createdAt: taskCreatedAt(task),
		updatedAt: taskUpdatedAt(task),
	};
}

function promotionRequestFrom(task: Record<string, unknown>, promotionRequest: Record<string, unknown>) {
	const id = readString(promotionRequest, 'id') || `approval:${taskId(task)}`;
	return {
		id,
		approvalKind: readString(promotionRequest, 'approvalKind') || 'promote_knowledge_draft',
		taskId: taskId(task),
		workDayId: taskWorkDayId(task),
		taskState: taskState(task),
		state: taskState(task) === 'completed' ? 'approved' : 'pending',
		severity: 'medium',
		title: readString(promotionRequest, 'title') || `Promote ${readString(promotionRequest, 'draftId') || id}`,
		summary: readString(promotionRequest, 'summary') || 'Generated knowledge is waiting for promotion approval.',
		draftId: readString(promotionRequest, 'draftId') || undefined,
		targetPath: readString(promotionRequest, 'targetPath') || undefined,
		recommendation: readString(promotionRequest, 'recommendation') || undefined,
		totalScore: Number.isFinite(Number(promotionRequest.totalScore)) ? Number(promotionRequest.totalScore) : undefined,
		sourceQuestionId: readString(promotionRequest, 'sourceQuestionId') || undefined,
		sourceResearchIds: readStringArray(promotionRequest.sourceResearchIds),
		sourceResearchNoteId: readString(promotionRequest, 'sourceResearchNoteId') || undefined,
		optimizationReportId: readString(promotionRequest, 'optimizationReportId') || undefined,
		createdAt: taskCreatedAt(task),
		updatedAt: taskUpdatedAt(task),
		payload: promotionRequest,
	} satisfies AgentApprovalRequestSummary;
}

function releaseRequestFrom(task: Record<string, unknown>, releaseRequest: Record<string, unknown>) {
	const id = readString(releaseRequest, 'id') || `release:${taskId(task)}`;
	return {
		id,
		approvalKind: readString(releaseRequest, 'approvalKind') || 'release_staged_knowledge',
		taskId: taskId(task),
		workDayId: taskWorkDayId(task),
		taskState: taskState(task),
		state: taskState(task) === 'completed' ? 'approved' : 'pending',
		severity: 'medium',
		title: readString(releaseRequest, 'title') || `Release ${readString(releaseRequest, 'draftId') || id}`,
		summary: readString(releaseRequest, 'summary') || 'Staged knowledge is waiting for release approval.',
		draftId: readString(releaseRequest, 'draftId') || undefined,
		targetPath: readString(releaseRequest, 'targetPath') || undefined,
		recommendation: readString(releaseRequest, 'recommendation') || undefined,
		sourceQuestionId: readString(releaseRequest, 'sourceQuestionId') || undefined,
		sourceResearchIds: readStringArray(releaseRequest.sourceResearchIds),
		featureBranch: readString(releaseRequest, 'featureBranch') || undefined,
		stagingBranch: readString(releaseRequest, 'stagingBranch') || undefined,
		changedPaths: readStringArray(releaseRequest.changedPaths),
		releaseInput: asRecord(releaseRequest.releaseInput),
		createdAt: taskCreatedAt(task),
		updatedAt: taskUpdatedAt(task),
		payload: releaseRequest,
	} satisfies AgentApprovalRequestSummary;
}

function persistedApprovalFrom(request: ApprovalRequest): AgentApprovalRequestSummary {
	const metadata = asRecord(request.metadata);
	const recommendation = asRecord(request.recommendation);
	const promotionRequest = asRecord(metadata.promotionRequest);
	const releaseRequest = asRecord(metadata.releaseRequest);
	const payload = Object.keys(promotionRequest).length
		? promotionRequest
		: Object.keys(releaseRequest).length
			? releaseRequest
			: metadata;
	const artifactRefs = asRecords(metadata.artifactRefs ?? recommendation.artifactRefs);
	const sourceMapRefs = asRecords(metadata.sourceMapRefs ?? recommendation.sourceMapRefs);
	return {
		id: request.id,
		approvalKind: readString(metadata, 'approvalKind') || request.kind,
		taskId: request.taskId ?? readString(metadata, 'promotionTaskId', 'taskId') ?? '',
		workDayId: request.workDayId ?? undefined,
		taskState: request.state,
		state: request.state,
		severity: request.severity,
		title: request.title,
		summary: request.summary,
		draftId: readString(metadata, 'draftId') || readString(payload, 'draftId') || undefined,
		targetPath: readString(metadata, 'targetPath') || readString(payload, 'targetPath') || undefined,
		recommendation: readString(recommendation, 'recommendation', 'action') || readString(payload, 'recommendation') || undefined,
		totalScore: Number.isFinite(Number(recommendation.totalScore ?? payload.totalScore)) ? Number(recommendation.totalScore ?? payload.totalScore) : undefined,
		sourceQuestionId: readString(metadata, 'sourceQuestionId') || readString(payload, 'sourceQuestionId') || undefined,
		sourceResearchIds: readStringArray(metadata.sourceResearchIds ?? payload.sourceResearchIds),
		sourceResearchNoteId: readString(metadata, 'sourceResearchNoteId') || readString(payload, 'sourceResearchNoteId') || undefined,
		optimizationReportId: readString(metadata, 'optimizationReportId') || readString(payload, 'optimizationReportId') || undefined,
		featureBranch: readString(metadata, 'featureBranch') || readString(payload, 'featureBranch') || undefined,
		stagingBranch: readString(metadata, 'stagingBranch') || readString(payload, 'stagingBranch') || undefined,
		changedPaths: readStringArray(metadata.changedPaths ?? recommendation.changedPaths ?? payload.changedPaths),
		options: request.options,
		policySnapshot: request.policySnapshot,
		artifactRefs,
		sourceMapRefs,
		verificationPlan: asRecord(metadata.verificationPlan ?? recommendation.verificationPlan),
		decision: request.decision,
		releaseInput: asRecord(metadata.releaseInput ?? payload.releaseInput),
		createdAt: request.createdAt,
		updatedAt: request.updatedAt,
		payload,
	};
}

function uniqueArtifacts(items: AgentArtifactApiItem[]) {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = item.artifactKind === 'promotion_request'
			? `${item.artifactKind}:${item.id}`
			: `${item.artifactKind}:${item.id}:${item.taskId ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function uniqueApprovals(items: AgentApprovalRequestSummary[]) {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = item.id || item.taskId;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function safeSearch(input: {
	sdk: SdkLike;
	model: string;
	filters?: Array<Record<string, unknown>>;
	sort?: Array<Record<string, unknown>>;
	limit?: number;
	warnings: string[];
}) {
	try {
		const result = await input.sdk.search({
			model: input.model as never,
			filters: input.filters as never,
			sort: input.sort as never,
			limit: input.limit,
		});
		return asRecords(result.payload);
	} catch (error) {
		input.warnings.push(`Unable to search ${input.model}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function readTaskLeaseExpiresAt(task: Record<string, unknown>) {
	const raw = readString(task, 'leaseExpiresAt', 'lease_expires_at');
	if (!raw) return null;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

function summarizeTaskHealth(tasks: Record<string, unknown>[], now = new Date()) {
	const activeTasks = tasks.filter((task) => ['claimed', 'running'].includes(readString(task, 'state')));
	const staleTasks = activeTasks.filter((task) => {
		const expiresAt = readTaskLeaseExpiresAt(task);
		return expiresAt !== null && expiresAt <= now.valueOf();
	});
	const recoveredTaskCount = tasks.filter((task) => readString(task, 'lastErrorCode', 'last_error_code') === 'stale_task_recovered').length;
	const failedStaleTaskCount = tasks.filter((task) => readString(task, 'lastErrorCode', 'last_error_code') === 'stale_task_retry_limit_exceeded').length;
	return {
		activeTasks,
		staleTasks,
		recoveredTaskCount,
		failedStaleTaskCount,
		retryBackoffPolicy: {
			baseSeconds: 15,
			maxSeconds: 300,
		},
	};
}

function environmentFromState(currentWorkday: Record<string, unknown> | null) {
	return readString(currentWorkday ?? {}, 'environment') || process.env.TREESEED_DEPLOY_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'prod' : 'local');
}

export async function collectAgentArtifactApiState(input: {
	sdk: SdkLike;
	projectId: string;
	limit?: number;
}): Promise<AgentArtifactApiState> {
	const warnings: string[] = [];
	const taskLimit = input.limit ?? 1000;
	const tasks = asRecords((await input.sdk.searchTasks({ limit: taskLimit })).payload);
	const taskIds = tasks.map(taskId).filter(Boolean);
	const outputs = taskIds.length
		? await safeSearch({
				sdk: input.sdk,
				model: 'task_output',
				filters: [{ field: 'task_id', op: 'in', value: taskIds }],
				sort: [{ field: 'created_at', direction: 'desc' }],
				limit: taskLimit,
				warnings,
			})
		: [];
	const outputsByTask = new Map<string, Record<string, unknown>[]>();
	for (const output of outputs) {
		const id = readString(output, 'taskId', 'task_id');
		if (!id) continue;
		outputsByTask.set(id, [...(outputsByTask.get(id) ?? []), output]);
	}

	const artifacts: AgentArtifactApiItem[] = [];
	const researchNotes: AgentArtifactApiState['researchNotes'] = [];
	const knowledgeDrafts: AgentArtifactApiState['knowledgeDrafts'] = [];
	const optimizationReports: AgentArtifactApiState['optimizationReports'] = [];
	const approvals: AgentApprovalRequestSummary[] = [];

	for (const task of tasks) {
		const type = taskType(task);
		const payload = parseTaskPayload(task, warnings);
		const parsedOutputs = (outputsByTask.get(taskId(task)) ?? [])
			.map((output) => parseTaskOutput(output, warnings))
			.filter(hasResearchKnowledgeOutput);
		const records = [
			...parsedOutputs,
			...(['promote_knowledge_draft_request', 'release_staged_knowledge_request'].includes(type) ? [payload] : []),
		];

		for (const record of records) {
			const generated = extractGeneratedArtifactsFromTaskOutputs([{
				...record,
				taskId: taskId(task),
			}]).map((summary) => attachTask(summary, task));
			artifacts.push(...generated);

			const note = asRecord(record.researchNote);
			if (note.kind === 'research_note') {
				researchNotes.push({
					taskId: taskId(task) || undefined,
					workDayId: taskWorkDayId(task),
					createdAt: taskCreatedAt(task),
					researchNote: note as unknown as ResearchNote,
				});
				artifacts.push(attachTask(summarizeResearchNoteArtifact(note as unknown as ResearchNote, taskId(task) || undefined), task));
			}

			const draft = asRecord(record.knowledgeDraft);
			if (draft.kind === 'knowledge_draft') {
				knowledgeDrafts.push({
					taskId: taskId(task) || undefined,
					workDayId: taskWorkDayId(task),
					createdAt: taskCreatedAt(task),
					knowledgeDraft: draft as unknown as KnowledgeDraft,
				});
				artifacts.push(attachTask(summarizeKnowledgeDraftArtifact(draft as unknown as KnowledgeDraft, taskId(task) || undefined), task));
			}

			const report = asRecord(record.optimizationReport);
			if (report.kind === 'knowledge_optimization_report') {
				optimizationReports.push({
					taskId: taskId(task) || undefined,
					workDayId: taskWorkDayId(task),
					createdAt: taskCreatedAt(task),
					optimizationReport: report as unknown as OptimizationReport,
				});
				artifacts.push(attachTask(summarizeOptimizationReportArtifact(report as unknown as OptimizationReport, taskId(task) || undefined), task));
			}

			const promotionRequest = asRecord(record.promotionRequest);
			if (type === 'promote_knowledge_draft_request' || Object.keys(promotionRequest).length > 0) {
				const request = Object.keys(promotionRequest).length > 0 ? promotionRequest : asRecord(payload.promotionRequest);
				if (Object.keys(request).length > 0) {
					approvals.push(promotionRequestFrom(task, request));
					artifacts.push(attachTask(summarizePromotionRequestArtifact(request, taskId(task) || undefined), task));
				}
			}

			const releaseRequest = asRecord(record.releaseRequest);
			if (type === 'release_staged_knowledge_request' || Object.keys(releaseRequest).length > 0) {
				const baseRequest = Object.keys(releaseRequest).length > 0 ? releaseRequest : asRecord(payload.releaseRequest);
				const request = {
					...baseRequest,
					operationGrants: record.operationGrants ?? payload.operationGrants,
					releaseInput: baseRequest.releaseInput ?? record.releaseInput ?? payload.releaseInput,
				};
				if (Object.keys(request).length > 0) {
					approvals.push(releaseRequestFrom(task, request));
					artifacts.push(attachTask(summarizeReleaseRequestArtifact(request, taskId(task) || undefined), task));
				}
			}
		}

		if (RESEARCH_KNOWLEDGE_TASK_KINDS.includes(type as never) && records.length === 0 && !['promote_knowledge_draft_request', 'release_staged_knowledge_request'].includes(type)) {
			warnings.push(`Task ${taskId(task) || '<unknown>'} has no generated artifact output yet.`);
		}
	}

	const workdays = await safeSearch({
		sdk: input.sdk,
		model: 'work_day',
		filters: [{ field: 'project_id', op: 'eq', value: input.projectId }],
		sort: [{ field: 'updated_at', direction: 'desc' }],
		limit: 20,
		warnings,
	});
	const currentWorkday = workdays.find((workday) => ['active', 'open', 'running'].includes(readString(workday, 'state'))) ?? workdays[0] ?? null;
	const reports = await safeSearch({
		sdk: input.sdk,
		model: 'report',
		sort: [{ field: 'created_at', direction: 'desc' }],
		limit: 50,
		warnings,
	});
	const persistedApprovals = typeof input.sdk.listApprovalRequests === 'function'
		? await input.sdk.listApprovalRequests({
				projectId: input.projectId,
				limit: taskLimit,
			}).then((result) => Array.isArray(result.payload) ? result.payload.map(persistedApprovalFrom) : [])
			.catch((error) => {
				warnings.push(`Unable to list persisted approval requests: ${error instanceof Error ? error.message : String(error)}`);
				return [] as AgentApprovalRequestSummary[];
			})
		: [];
	const taskHealth = summarizeTaskHealth(tasks);
	const environment = environmentFromState(currentWorkday);
	const workerRunners = typeof input.sdk.listWorkerRunners === 'function'
		? await input.sdk.listWorkerRunners(input.projectId, environment).then((result) => asRecords(result.payload)).catch((error) => {
				warnings.push(`Unable to list worker runners: ${error instanceof Error ? error.message : String(error)}`);
				return [] as Record<string, unknown>[];
			})
		: [];
	const managerLeases = typeof input.sdk.listWorkdayManagerLeases === 'function'
		? await input.sdk.listWorkdayManagerLeases(input.projectId, environment).then((result) => asRecords(result.payload)).catch((error) => {
				warnings.push(`Unable to list manager leases: ${error instanceof Error ? error.message : String(error)}`);
				return [] as Record<string, unknown>[];
			})
		: [];

	return {
		projectId: input.projectId,
		artifacts: uniqueArtifacts(artifacts),
		researchNotes,
		knowledgeDrafts,
		optimizationReports,
		approvals: uniqueApprovals([...persistedApprovals, ...approvals]),
		currentWorkday,
		reports: reports.map((report) => ({
			...report,
			body: parseReportBody(report, warnings),
		})),
		taskHealth,
		workerRunners,
		managerLease: managerLeases[0] ?? null,
		warnings,
	};
}

function grantSummariesFromRecord(input: {
	record: Record<string, unknown>;
	task: Record<string, unknown>;
	source: AgentOperationGrantSummary['source'];
}) {
	const candidates = [
		input.record.operationGrants,
		input.record.grants,
		asRecord(input.record.operations).grants,
		asRecord(input.record.workPackage).operationGrants,
		asRecord(input.record.workPackage).grants,
	];
	const grants = candidates.flatMap((value) => Array.isArray(value) ? value.map(asRecord) : []);
	return grants
		.filter((grant) => readString(grant, 'id'))
		.map((grant) => ({
			id: readString(grant, 'id'),
			taskId: taskId(input.task) || undefined,
			workDayId: taskWorkDayId(input.task),
			taskType: taskType(input.task) || undefined,
			state: readString(grant, 'state') || undefined,
			operations: readStringArray(grant.operations),
			modes: readStringArray(grant.modes),
			agentRoles: readStringArray(grant.agentRoles),
			taskKinds: readStringArray(grant.taskKinds),
			projectIds: readStringArray(grant.projectIds),
			environments: readStringArray(grant.environments),
			allowedPaths: readStringArray(grant.allowedPaths),
			forbiddenPaths: readStringArray(grant.forbiddenPaths),
			requiresApproval: typeof grant.requiresApproval === 'boolean' ? grant.requiresApproval : undefined,
			approvalIds: readStringArray(grant.approvalIds),
			source: input.source,
		}) satisfies AgentOperationGrantSummary);
}

function uniqueGrants(grants: AgentOperationGrantSummary[]) {
	const seen = new Set<string>();
	return grants.filter((grant) => {
		const key = `${grant.id}:${grant.taskId ?? ''}:${grant.source}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function operationEventFromResult(input: {
	result: Record<string, unknown>;
	task: Record<string, unknown>;
	index: number;
	source: AgentOperationEventSummary['source'];
}) {
	const error = asRecord(input.result.error);
	return {
		id: `${input.source}:${taskId(input.task) || 'task'}:${input.index}`,
		taskId: taskId(input.task) || undefined,
		workDayId: taskWorkDayId(input.task),
		taskType: taskType(input.task) || undefined,
		source: input.source,
		operation: readString(input.result, 'operation') || 'operation',
		status: readString(input.result, 'status') || undefined,
		summary: readString(input.result, 'summary') || undefined,
		changedPaths: readStringArray(input.result.changedPaths),
		stagedPaths: readStringArray(input.result.stagedPaths),
		mergedToStaging: typeof input.result.mergedToStaging === 'boolean' ? input.result.mergedToStaging : undefined,
		mergeFailure: Object.keys(asRecord(input.result.mergeFailure)).length ? asRecord(input.result.mergeFailure) : undefined,
		error: Object.keys(error).length ? error : undefined,
	} satisfies AgentOperationEventSummary;
}

function operationEventFromTaskEvent(input: {
	event: Record<string, unknown>;
	data: Record<string, unknown>;
	task: Record<string, unknown> | undefined;
	warnings: string[];
}) {
	const result = asRecord(input.data.result);
	if (!readString(input.data, 'operation') && !readString(result, 'operation')) {
		input.warnings.push(`Skipped malformed operation_event ${readString(input.event, 'id') || '<unknown>'}.`);
		return null;
	}
	const task = input.task ?? {};
	return {
		id: readString(input.event, 'id') || `${readString(input.event, 'taskId', 'task_id')}:operation:${readString(input.event, 'seq')}`,
		taskId: readString(input.event, 'taskId', 'task_id') || taskId(task) || undefined,
		workDayId: taskWorkDayId(task),
		taskType: taskType(task) || undefined,
		seq: Number.isFinite(Number(input.event.seq)) ? Number(input.event.seq) : undefined,
		source: 'task_event',
		operation: readString(input.data, 'operation') || readString(result, 'operation') || 'operation',
		mode: readString(input.data, 'mode') || undefined,
		agentRole: readString(input.data, 'agentRole') || undefined,
		permissionGrantId: readString(input.data, 'permissionGrantId') || undefined,
		status: readString(result, 'status') || undefined,
		summary: readString(result, 'summary') || undefined,
		changedPaths: readStringArray(result.changedPaths),
		stagedPaths: readStringArray(result.stagedPaths),
		mergedToStaging: typeof result.mergedToStaging === 'boolean' ? result.mergedToStaging : undefined,
		mergeFailure: Object.keys(asRecord(result.mergeFailure)).length ? asRecord(result.mergeFailure) : undefined,
		error: Object.keys(asRecord(result.error)).length ? asRecord(result.error) : undefined,
		createdAt: readString(input.data, 'createdAt') || readString(input.event, 'createdAt', 'created_at') || undefined,
	} satisfies AgentOperationEventSummary;
}

function outputRecordsForLifecycle(record: Record<string, unknown>) {
	return [
		record,
		asRecord(record.implementationResult),
		asRecord(record.promotionToStaging),
		asRecord(record.artifact),
		asRecord(record.result),
	].filter((entry) => Object.keys(entry).length > 0);
}

function collectLifecycleFromRecord(input: {
	record: Record<string, unknown>;
	task: Record<string, unknown>;
	lifecycle: AgentOperationLifecycleSummary;
}) {
	for (const record of outputRecordsForLifecycle(input.record)) {
		for (const snapshot of (Array.isArray(record.snapshots) ? record.snapshots.map(asRecord) : [])) {
			input.lifecycle.worktreeSnapshots.push({
				...snapshot,
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
		if (record.mergedToStaging !== undefined || record.mergeCommitSha || record.stagedCommitSha) {
			input.lifecycle.stagingMerges.push({
				mergedToStaging: Boolean(record.mergedToStaging),
				featureBranch: readString(record, 'featureBranch') || undefined,
				stagingBranch: readString(record, 'stagingBranch') || undefined,
				commitSha: readString(record, 'mergeCommitSha', 'stagedCommitSha') || undefined,
				changedPaths: readStringArray(record.changedPaths),
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
		const mergeFailure = asRecord(record.mergeFailure);
		if (Object.keys(mergeFailure).length > 0) {
			input.lifecycle.mergeFailures.push({
				...mergeFailure,
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
		const repairTask = asRecord(record.repairTask);
		if (Object.keys(repairTask).length > 0) {
			input.lifecycle.repairTasks.push({
				...repairTask,
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
		const releaseResult = asRecord(record.releaseResult);
		if (Object.keys(releaseResult).length > 0) {
			input.lifecycle.releaseResults.push({
				...releaseResult,
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
		const codexResult = asRecord(record.codexResult);
		const usage = asRecord(codexResult.usage);
		if (Object.keys(usage).length > 0 || readString(codexResult, 'provider')) {
			input.lifecycle.codexUsage.push({
				provider: readString(codexResult, 'provider') || undefined,
				threadId: readString(codexResult, 'threadId') || undefined,
				status: readString(codexResult, 'status') || undefined,
				usage,
				taskId: taskId(input.task) || undefined,
				workDayId: taskWorkDayId(input.task),
				taskType: taskType(input.task) || undefined,
			});
		}
	}
}

function collectLifecycleFromApprovalDecisionEvent(input: {
	event: Record<string, unknown>;
	data: Record<string, unknown>;
	task: Record<string, unknown> | undefined;
	lifecycle: AgentOperationLifecycleSummary;
}) {
	const task = input.task ?? {};
	const approvalKind = readString(input.data, 'approvalKind');
	const approvalRecord = {
		id: readString(input.data, 'approvalId') || readString(input.event, 'id') || `approval:${readString(input.event, 'taskId', 'task_id')}`,
		approvalKind: approvalKind || 'approval_decision',
		taskId: readString(input.event, 'taskId', 'task_id') || taskId(task) || '',
		workDayId: taskWorkDayId(task),
		taskState: taskState(task),
		decision: readString(input.data, 'decision') || undefined,
		reason: readString(input.data, 'reason') || undefined,
		actor: readString(input.event, 'actor') || undefined,
		releaseAttempted: input.data.releaseAttempted === true,
		stagingAttempted: input.data.stagingAttempted === true,
		stagingTaskCreated: input.data.stagingTaskCreated === true,
		createdTaskId: readString(input.data, 'createdTaskId') || undefined,
		createdAt: readString(input.event, 'createdAt', 'created_at') || undefined,
		payload: input.data,
	} as AgentApprovalRequestSummary & Record<string, unknown>;
	input.lifecycle.releaseApprovals.push(approvalRecord);
	const releaseResult = asRecord(input.data.releaseResult);
	if (Object.keys(releaseResult).length > 0) {
		input.lifecycle.releaseResults.push({
			...releaseResult,
			approvalId: approvalRecord.id,
			decision: approvalRecord.decision,
			actor: approvalRecord.actor,
			taskId: approvalRecord.taskId || undefined,
			workDayId: approvalRecord.workDayId,
			taskType: taskType(task) || undefined,
			createdAt: approvalRecord.createdAt,
		});
	}
}

export async function collectAgentOperationApiState(input: {
	sdk: SdkLike;
	projectId: string;
	limit?: number;
}): Promise<AgentOperationApiState> {
	const warnings: string[] = [];
	const taskLimit = input.limit ?? 1000;
	const tasks = asRecords((await input.sdk.searchTasks({ limit: taskLimit })).payload);
	const taskIds = tasks.map(taskId).filter(Boolean);
	const outputs = taskIds.length
		? await safeSearch({
				sdk: input.sdk,
				model: 'task_output',
				filters: [{ field: 'task_id', op: 'in', value: taskIds }],
				sort: [{ field: 'created_at', direction: 'desc' }],
				limit: taskLimit,
				warnings,
			})
		: [];
	const events = taskIds.length
		? await safeSearch({
				sdk: input.sdk,
				model: 'task_event',
				filters: [{ field: 'task_id', op: 'in', value: taskIds }],
				sort: [{ field: 'created_at', direction: 'desc' }],
				limit: taskLimit,
				warnings,
			})
		: [];
	const taskMap = taskById(tasks);
	const outputsByTask = new Map<string, Record<string, unknown>[]>();
	for (const output of outputs) {
		const id = readString(output, 'taskId', 'task_id');
		if (!id) continue;
		outputsByTask.set(id, [...(outputsByTask.get(id) ?? []), output]);
	}
	const grants: AgentOperationGrantSummary[] = [];
	const operationEvents: AgentOperationEventSummary[] = [];
	const lifecycle: AgentOperationLifecycleSummary = {
		worktreeSnapshots: [],
		stagingMerges: [],
		mergeFailures: [],
		repairTasks: [],
		releaseApprovals: [],
		releaseResults: [],
		codexUsage: [],
	};

	for (const task of tasks) {
		const payload = parseTaskPayload(task, warnings);
		grants.push(...grantSummariesFromRecord({ record: payload, task, source: 'task_payload' }));
		const parsedOutputs = (outputsByTask.get(taskId(task)) ?? []).map((output) => parseTaskOutput(output, warnings));
		for (const outputRecord of parsedOutputs) {
			grants.push(...grantSummariesFromRecord({ record: outputRecord, task, source: 'task_output' }));
			collectLifecycleFromRecord({ record: outputRecord, task, lifecycle });
			for (const record of outputRecordsForLifecycle(outputRecord)) {
				for (const [index, result] of (Array.isArray(record.operationResults) ? record.operationResults.map(asRecord).entries() : [])) {
					operationEvents.push(operationEventFromResult({ result, task, index, source: 'task_output' }));
				}
			}
		}
	}

	for (const event of events.filter((entry) => readString(entry, 'kind') === 'operation_event')) {
		const data = parseEventData(event, warnings);
		const task = taskMap.get(readString(event, 'taskId', 'task_id'));
		const summary = operationEventFromTaskEvent({ event, data, task, warnings });
		if (summary) operationEvents.push(summary);
	}

	for (const event of events.filter((entry) => readString(entry, 'kind') === 'approval_decision_recorded')) {
		const data = parseEventData(event, warnings);
		const task = taskMap.get(readString(event, 'taskId', 'task_id'));
		collectLifecycleFromApprovalDecisionEvent({ event, data, task, lifecycle });
	}

	const artifactState = await collectAgentArtifactApiState({
		sdk: input.sdk,
		projectId: input.projectId,
		limit: taskLimit,
	});
	lifecycle.releaseApprovals.push(...artifactState.approvals.filter((approval) => approval.approvalKind === 'release_staged_knowledge'));

	return {
		projectId: input.projectId,
		grants: uniqueGrants(grants),
		events: operationEvents,
		lifecycle,
		warnings: [...warnings, ...artifactState.warnings],
	};
}

function bodyOperationRequest(input: {
	body: Record<string, unknown>;
	operation: AgentOperationName;
	projectId: string;
	repoRoot: string;
	environment: string;
}) {
	const request = asRecord(input.body.request);
	const operation = input.operation;
	return {
		operation,
		mode: readString(request, 'mode') || readString(input.body, 'mode') || 'dry_run',
		taskId: readString(request, 'taskId') || readString(input.body, 'taskId') || 'operation-dry-run',
		taskKind: readString(request, 'taskKind') || readString(input.body, 'taskKind') || undefined,
		workDayId: readString(request, 'workDayId') || readString(input.body, 'workDayId') || undefined,
		agentSlug: readString(request, 'agentSlug') || readString(input.body, 'agentSlug') || 'api-dry-run',
		agentRole: readString(request, 'agentRole') || readString(input.body, 'agentRole') || 'reviewer',
		projectId: readString(request, 'projectId') || input.projectId,
		environment: readString(request, 'environment') || input.environment,
		repoRoot: readString(request, 'repoRoot') || input.repoRoot,
		worktreeRoot: readString(request, 'worktreeRoot') || undefined,
		featureBranch: readString(request, 'featureBranch') || undefined,
		stagingBranch: readString(request, 'stagingBranch') || undefined,
		approvalId: readString(request, 'approvalId') || undefined,
		approval: Object.keys(asRecord(request.approval)).length ? asRecord(request.approval) as AgentOperationRequest['approval'] : undefined,
		permissionGrantId: readString(request, 'permissionGrantId') || undefined,
		allowedPaths: readStringArray(request.allowedPaths ?? input.body.allowedPaths),
		forbiddenPaths: readStringArray(request.forbiddenPaths ?? input.body.forbiddenPaths),
		changedPaths: readStringArray(request.changedPaths ?? input.body.changedPaths),
		input: asRecord(request.input ?? input.body.input),
	} satisfies AgentOperationRequest;
}

export async function dryRunAgentOperation(input: {
	sdk: SdkLike;
	projectId: string;
	operation: string;
	body: Record<string, unknown>;
	repoRoot: string;
	environment?: string;
}) {
	if (!isAgentOperationName(input.operation)) {
		throw new AgentApprovalDecisionError(400, `Unsupported operation "${input.operation}".`, { operation: input.operation });
	}
	const request = bodyOperationRequest({
		body: input.body,
		operation: input.operation,
		projectId: input.projectId,
		repoRoot: input.repoRoot,
		environment: input.environment ?? 'local',
	});
	const explicitGrants = Array.isArray(input.body.grants) ? input.body.grants as AgentOperationGrant[] : [];
	const operationState = explicitGrants.length
		? null
		: await collectAgentOperationApiState({
				sdk: input.sdk,
				projectId: input.projectId,
			});
	const grants = explicitGrants.length
		? explicitGrants
		: (operationState?.grants ?? []).map((grant) => ({
				id: grant.id,
				state: grant.state as AgentOperationGrant['state'],
				operations: grant.operations as AgentOperationName[],
				modes: grant.modes as AgentOperationGrant['modes'],
				agentRoles: grant.agentRoles,
				taskKinds: grant.taskKinds,
				projectIds: grant.projectIds,
				environments: grant.environments,
				allowedPaths: grant.allowedPaths,
				forbiddenPaths: grant.forbiddenPaths,
				requiresApproval: grant.requiresApproval,
				approvalIds: grant.approvalIds,
			}) satisfies AgentOperationGrant);
	const decision = decideAgentOperationPermission({ request, grants });
	const result = decision.allowed
		? {
				operation: request.operation,
				status: 'completed',
				summary: decision.summary,
				changedPaths: request.changedPaths ?? [],
				stagedPaths: request.operation === 'stage' ? request.changedPaths ?? [] : [],
				mergedToStaging: request.operation === 'merge_to_staging' ? false : undefined,
				commandsRun: [],
				artifacts: [],
				metadata: { permission: decision, dryRun: true },
			} satisfies AgentOperationResult
		: deniedAgentOperationResult(request, decision);
	return {
		projectId: input.projectId,
		dryRun: true,
		request,
		decision,
		result,
		warnings: operationState?.warnings ?? [],
	};
}

export class AgentApprovalDecisionError extends Error {
	constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
		super(message);
	}
}

function decisionAllowedForKind(kind: string, decision: string) {
	if (kind === 'release_staged_knowledge') {
		return (RELEASE_APPROVAL_DECISIONS as readonly string[]).includes(decision);
	}
	return ([...PROMOTION_APPROVAL_DECISIONS, 'defer'] as readonly string[]).includes(decision);
}

function normalizeApprovalDecision(decision: string) {
	if (decision === 'approve') return 'approve_as_book_content';
	if (decision === 'request_changes') return 'request_more_research';
	return decision;
}

function stateForDecision(kind: string, decision: string) {
	if (kind === 'release_staged_knowledge') {
		return decision === 'approve_release' ? 'approved' : 'rejected';
	}
	if (decision === 'approve_as_book_content') return 'approved';
	if (decision === 'request_more_research') return 'changes_requested';
	if (decision === 'defer') return 'deferred';
	return 'rejected';
}

const DEFAULT_DOCS_MUTATION_VERIFICATION_COMMANDS = ['npm run test:unit', 'npm run build'];

const DEFAULT_DOCS_AUTOMATION_FORBIDDEN_PATHS = [
	'.env*',
	'**/.env*',
	'**/.git/**',
	'**/node_modules/**',
	'.treeseed/worktrees/**',
	'.treeseed/exports/**',
	'packages/*/src/**',
	'src/lib/**',
	'src/pages/api/**',
	'migrations/**',
];

function promotionTaskPayload(input: {
	approval: AgentApprovalRequestSummary;
	draft: KnowledgeDraft;
	decision: string;
	reason?: string | null;
	actor: string;
	projectId: string;
}) {
	const verificationCommands = readStringArray(asRecord(input.approval.verificationPlan).commands);
	const forbiddenPaths = readStringArray(input.approval.payload.forbiddenPaths);
	const repositoryClaim = asRecord(input.approval.payload.repositoryClaim ?? input.approval.payload.repository_claim);
	const runtimeMode = readString(input.approval.payload, 'runtimeMode') || readString(input.approval.payload, 'runtime_mode');
	return {
		executionKind: 'research_knowledge_pipeline',
		taskKind: 'promote_knowledge_to_staging',
		agentRole: 'engineer',
		agentSlug: 'engineer-agent',
		projectId: input.projectId,
		environment: runtimeMode === 'hosted' ? 'staging' : 'local',
		runtimeMode: runtimeMode || undefined,
		provider: runtimeMode === 'hosted' ? 'hosted_runner' : 'local_branch',
		releaseAllowed: false,
		knowledgeDraft: input.draft,
		promotionRequest: input.approval.payload,
		approval: {
			id: input.approval.id,
			kind: input.approval.approvalKind,
			state: 'approved',
		},
		approvalDecision: {
			approvalId: input.approval.id,
			decision: input.decision,
			reason: input.reason ?? null,
			actor: input.actor,
			decidedAt: new Date().toISOString(),
		},
		allowedPaths: [input.draft.targetPath],
		forbiddenPaths: forbiddenPaths.length ? forbiddenPaths : DEFAULT_DOCS_AUTOMATION_FORBIDDEN_PATHS,
		verificationCommands: verificationCommands.length ? verificationCommands : DEFAULT_DOCS_MUTATION_VERIFICATION_COMMANDS,
		sourceMapRefs: input.approval.sourceMapRefs ?? [],
		changedPaths: input.approval.changedPaths?.length ? input.approval.changedPaths : [input.draft.targetPath],
		verificationPlan: input.approval.verificationPlan ?? { commands: DEFAULT_DOCS_MUTATION_VERIFICATION_COMMANDS },
		policySnapshot: input.approval.policySnapshot ?? {},
		repositoryClaim: Object.keys(repositoryClaim).length > 0 ? repositoryClaim : undefined,
		repositoryClaimId: readString(repositoryClaim, 'id') || readString(input.approval.payload, 'repositoryClaimId') || undefined,
		runnerId: readString(repositoryClaim, 'runnerId', 'runner_id') || readString(input.approval.payload, 'runnerId') || undefined,
		sourceTaskId: input.approval.taskId,
	};
}

async function createPromotionTask(input: {
	sdk: SdkLike;
	state: AgentArtifactApiState;
	approval: AgentApprovalRequestSummary;
	decision: string;
	reason?: string | null;
	actor: string;
	projectId: string;
}) {
	if (typeof input.sdk.createTask !== 'function') {
		return null;
	}
	const draft = input.state.knowledgeDrafts.find((entry) => entry.knowledgeDraft.id === input.approval.draftId)?.knowledgeDraft
		?? asRecord(input.approval.payload.knowledgeDraft) as unknown as KnowledgeDraft;
	if (draft.kind !== 'knowledge_draft') {
		throw new AgentApprovalDecisionError(409, 'Cannot promote knowledge without the source draft artifact.', {
			approvalId: input.approval.id,
			draftId: input.approval.draftId ?? null,
		});
	}
	const workDayId = input.approval.workDayId ?? (input.state.currentWorkday ? readString(input.state.currentWorkday, 'id') : '');
	if (!workDayId) {
		throw new AgentApprovalDecisionError(409, 'Cannot promote knowledge without a workday id.', {
			approvalId: input.approval.id,
		});
	}
	const created = await input.sdk.createTask({
		workDayId,
		agentId: 'engineer-agent',
		type: 'promote_knowledge_to_staging',
		priority: 78,
		idempotencyKey: followupTaskIdempotencyKey(workDayId, 'promote_knowledge_to_staging', input.approval.id),
		payload: promotionTaskPayload({
			approval: input.approval,
			draft,
			decision: input.decision,
			reason: input.reason,
			actor: input.actor,
			projectId: input.projectId,
		}),
		graphVersion: null,
		actor: input.actor,
	});
	return asRecord(created.payload);
}

async function createRevisionTask(input: {
	sdk: SdkLike;
	state: AgentArtifactApiState;
	approval: AgentApprovalRequestSummary;
	reason?: string | null;
	actor: string;
}) {
	if (typeof input.sdk.createTask !== 'function') {
		return null;
	}
	const draft = input.state.knowledgeDrafts.find((entry) => entry.knowledgeDraft.id === input.approval.draftId)?.knowledgeDraft
		?? asRecord(input.approval.payload.knowledgeDraft) as unknown as KnowledgeDraft;
	if (draft.kind !== 'knowledge_draft') {
		throw new AgentApprovalDecisionError(409, 'Cannot request draft changes without the source draft artifact.', {
			approvalId: input.approval.id,
			draftId: input.approval.draftId ?? null,
		});
	}
	const note = input.state.researchNotes.find((entry) => entry.researchNote.id === input.approval.sourceResearchNoteId)?.researchNote
		?? input.state.researchNotes.find((entry) => draft.sourceResearchIds.includes(entry.researchNote.id))?.researchNote
		?? asRecord(input.approval.payload.researchNote) as unknown as ResearchNote;
	if (note.kind !== 'research_note') {
		throw new AgentApprovalDecisionError(409, 'Cannot request draft changes without the source research note artifact.', {
			approvalId: input.approval.id,
			draftId: input.approval.draftId ?? null,
		});
	}
	const report = input.state.optimizationReports.find((entry) => entry.optimizationReport.id === input.approval.optimizationReportId)?.optimizationReport
		?? asRecord(input.approval.payload.optimizationReport) as unknown as OptimizationReport;
	const workDayId = input.approval.workDayId ?? (input.state.currentWorkday ? readString(input.state.currentWorkday, 'id') : '');
	if (!workDayId) {
		throw new AgentApprovalDecisionError(409, 'Cannot request draft changes without a workday id.', {
			approvalId: input.approval.id,
		});
	}
	const created = await input.sdk.createTask({
		workDayId,
		agentId: 'knowledge-generator-agent',
		type: 'generate_knowledge_draft',
		priority: 88,
		idempotencyKey: `${workDayId}:generate_knowledge_draft_revision:${input.approval.id}`,
		payload: {
			executionKind: 'research_knowledge_pipeline',
			researchNote: note,
			question: {
				id: draft.sourceQuestionId,
				title: draft.title,
				book: draft.book,
				section: draft.section,
				targetPath: draft.targetPath,
			},
			previousKnowledgeDraft: draft,
			optimizationReport: report.kind === 'knowledge_optimization_report' ? report : null,
			approvalDecision: {
				approvalId: input.approval.id,
				decision: 'request_more_research',
				reason: input.reason ?? null,
				actor: input.actor,
				decidedAt: new Date().toISOString(),
			},
			sourceTaskId: input.approval.taskId,
			taskKind: 'generate_knowledge_draft',
			revisionOfDraftId: draft.id,
		},
		graphVersion: null,
		actor: input.actor,
	});
	return asRecord(created.payload);
}

function releaseGrantsFromApproval(input: {
	approval: AgentApprovalRequestSummary;
	projectId: string;
	environment: string;
}) {
	const payload = input.approval.payload;
	const explicit = Array.isArray(payload.operationGrants) ? payload.operationGrants as AgentOperationGrant[] : [];
	if (explicit.length) return explicit;
	return [defaultReleaseGrant({
		taskId: input.approval.taskId,
		projectId: input.projectId,
		environment: input.environment,
		approvalId: input.approval.id,
	})];
}

export async function recordAgentApprovalDecision(input: {
	sdk: SdkLike;
	projectId: string;
	approvalId: string;
	decision: string;
	reason?: string | null;
	actor: string;
	actorType?: 'anonymous' | 'user' | 'service' | 'project';
	repoRoot?: string;
	environment?: string;
	operations?: ReturnType<typeof createOperationsAdapter>;
}) {
	const state = await collectAgentArtifactApiState({
		sdk: input.sdk,
		projectId: input.projectId,
	});
	const approval = state.approvals.find((entry) => entry.id === input.approvalId || entry.taskId === input.approvalId);
	if (!approval) return null;
	const decision = normalizeApprovalDecision(input.decision);
	if (!decisionAllowedForKind(approval.approvalKind, decision)) {
		throw new AgentApprovalDecisionError(400, `Decision ${input.decision} is not valid for ${approval.approvalKind}.`, {
			approvalKind: approval.approvalKind,
			decision: input.decision,
		});
	}

	let createdTask: Record<string, unknown> | null = null;
	let releaseAttempted = false;
	let releaseResult: AgentOperationResult | null = null;
	if (approval.approvalKind === 'promote_knowledge_draft' && decision === 'approve_as_book_content') {
		createdTask = await createPromotionTask({
			sdk: input.sdk,
			state,
			approval,
			decision,
			reason: input.reason,
			actor: input.actor,
			projectId: input.projectId,
		});
	}
	if (approval.approvalKind === 'promote_knowledge_draft' && decision === 'request_more_research') {
		createdTask = await createRevisionTask({
			sdk: input.sdk,
			state,
			approval,
			reason: input.reason,
			actor: input.actor,
		});
	}

	if (approval.approvalKind === 'release_staged_knowledge' && decision === 'approve_release') {
		if (input.actorType && input.actorType !== 'user') {
			throw new AgentApprovalDecisionError(403, 'Only a human user may approve a production release.', {
				approvalId: approval.id,
			});
		}
		releaseAttempted = true;
		const environment = input.environment ?? 'local';
		const operations = input.operations ?? createOperationsAdapter();
		releaseResult = await operations.runOperation({
			request: {
				operation: 'release',
				mode: 'mutating',
				taskId: approval.taskId,
				taskKind: 'release_staged_knowledge_request',
				workDayId: approval.workDayId,
				agentSlug: 'releaser-agent',
				agentRole: 'releaser',
				projectId: input.projectId,
				environment,
				repoRoot: input.repoRoot ?? process.cwd(),
				approvalId: approval.id,
				approval: {
					id: approval.id,
					kind: 'release_staged_knowledge',
					state: 'approved',
				},
				allowedPaths: approval.targetPath ? [approval.targetPath] : [],
				forbiddenPaths: [],
				changedPaths: approval.changedPaths ?? [],
				input: {
					bump: 'patch',
					...approval.releaseInput,
				},
			},
			grants: releaseGrantsFromApproval({
				approval,
				projectId: input.projectId,
				environment,
			}),
			sdk: input.sdk as never,
		});
	}

	const persistedDecision = typeof input.sdk.decideApprovalRequest === 'function'
		? await input.sdk.decideApprovalRequest(approval.id, {
				state: stateForDecision(approval.approvalKind, decision),
				optionId: decision,
				note: input.reason ?? null,
				decision: {
					approvalId: approval.id,
					approvalKind: approval.approvalKind,
					decision,
					inputDecision: input.decision,
					reason: input.reason ?? null,
					createdTaskId: readString(createdTask ?? {}, 'id') || null,
					releaseAttempted,
				},
				decidedByType: input.actorType ?? 'user',
				decidedById: input.actor,
			}).catch(() => null)
		: null;
	if (typeof input.sdk.upsertTeamInboxItem === 'function') {
		await input.sdk.upsertTeamInboxItem({
			id: `approval:${approval.id}`,
			teamId: String(persistedDecision?.payload?.teamId ?? process.env.TREESEED_TEAM_ID ?? process.env.TREESEED_HOSTING_TEAM_ID ?? input.projectId),
			projectId: input.projectId,
			kind: 'approval_required',
			state: decision === 'approve_as_book_content' || decision === 'approve_release'
				? 'approved'
				: decision === 'request_more_research'
					? 'action_required'
					: decision === 'defer'
						? 'deferred'
						: 'rejected',
			title: approval.title ?? `Approval ${approval.id}`,
			summary: input.reason ?? approval.summary ?? null,
			href: `/app/governance/${encodeURIComponent(approval.id)}`,
			itemKey: `approval:${approval.id}`,
			metadata: {
				approvalId: approval.id,
				approvalKind: approval.approvalKind,
				decision,
				createdTaskId: readString(createdTask ?? {}, 'id') || null,
			},
		}).catch(() => null);
	}

	await input.sdk.appendTaskEvent({
		taskId: approval.taskId,
		kind: 'approval_decision_recorded',
		data: {
			approvalId: approval.id,
			approvalKind: approval.approvalKind,
			decision,
			inputDecision: input.decision,
			reason: input.reason ?? null,
			releaseAttempted,
			stagingAttempted: false,
			stagingTaskCreated: approval.approvalKind === 'promote_knowledge_draft' && decision === 'approve_as_book_content',
			createdTaskId: readString(createdTask ?? {}, 'id') || null,
			releaseResult,
		},
		actor: input.actor,
	});
	return {
		...approval,
		state: persistedDecision?.payload?.state ?? stateForDecision(approval.approvalKind, decision),
		decision,
		reason: input.reason ?? null,
		createdTask,
		releaseAttempted,
		releaseResult,
	};
}
