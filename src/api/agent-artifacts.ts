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
import type { ResearchNote } from '../agents/contracts/research.ts';
import { createOperationsAdapter } from '../agents/adapters/operations.ts';
import {
	defaultReleaseGrant,
	PROMOTION_APPROVAL_DECISIONS,
	RELEASE_APPROVAL_DECISIONS,
	type AgentApprovalKind,
} from '../services/knowledge-promotion.ts';
import type { GeneratedAgentArtifactSummary } from '../services/research-knowledge-workday.ts';

type SdkLike = Pick<AgentSdk, 'search'> & Partial<Pick<AgentSdk,
	'listApprovalRequests' | 'decideApprovalRequest' | 'upsertTeamInboxItem' | 'listWorkerRunners' | 'listWorkdayManagerLeases'
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
		knowledgeDraft: Record<string, unknown>;
	}>;
	optimizationReports: Array<{
		taskId?: string;
		workDayId?: string;
		createdAt?: string;
		optimizationReport: Record<string, unknown>;
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
	source: 'assignment' | 'mode_run';
}

export interface AgentOperationEventSummary {
	id: string;
	taskId?: string;
	workDayId?: string;
	taskType?: string;
	seq?: number;
	source: 'assignment' | 'mode_run';
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

function emptyTaskHealth() {
	return {
		activeTasks: [],
		staleTasks: [],
		recoveredTaskCount: 0,
		failedStaleTaskCount: 0,
		retryBackoffPolicy: {
			baseSeconds: 0,
			maxSeconds: 0,
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
	const limit = input.limit ?? 1000;
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
				limit,
			}).then((result) => Array.isArray(result.payload) ? result.payload.map(persistedApprovalFrom) : [])
			.catch((error) => {
				warnings.push(`Unable to list persisted approval requests: ${error instanceof Error ? error.message : String(error)}`);
				return [] as AgentApprovalRequestSummary[];
			})
		: [];
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
		artifacts: [],
		researchNotes: [],
		knowledgeDrafts: [],
		optimizationReports: [],
		approvals: uniqueApprovals(persistedApprovals),
		currentWorkday,
		reports: reports.map((report) => ({
			...report,
			body: parseReportBody(report, warnings),
		})),
		taskHealth: emptyTaskHealth(),
		workerRunners,
		managerLease: managerLeases[0] ?? null,
		warnings,
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
		mode: (readString(request, 'mode') || readString(input.body, 'mode') || 'plan') as AgentOperationRequest['mode'],
		taskId: readString(request, 'taskId') || readString(input.body, 'taskId') || 'operation-plan',
		taskKind: readString(request, 'taskKind') || readString(input.body, 'taskKind') || undefined,
		workDayId: readString(request, 'workDayId') || readString(input.body, 'workDayId') || undefined,
		agentSlug: readString(request, 'agentSlug') || readString(input.body, 'agentSlug') || 'api-plan',
		agentRole: readString(request, 'agentRole') || readString(input.body, 'agentRole') || 'reviewer',
		projectId: readString(request, 'projectId') || input.projectId,
		environment: readString(request, 'environment') || input.environment,
		repoRoot: readString(request, 'repoRoot') || input.repoRoot,
		worktreeRoot: readString(request, 'worktreeRoot') || undefined,
		featureBranch: readString(request, 'featureBranch') || undefined,
		stagingBranch: readString(request, 'stagingBranch') || undefined,
		permissionGrantId: readString(request, 'permissionGrantId') || undefined,
		allowedPaths: readStringArray(request.allowedPaths ?? input.body.allowedPaths),
		forbiddenPaths: readStringArray(request.forbiddenPaths ?? input.body.forbiddenPaths),
		changedPaths: readStringArray(request.changedPaths ?? input.body.changedPaths),
		input: asRecord(request.input ?? input.body.input),
	} satisfies AgentOperationRequest;
}

export async function planOnlyAgentOperation(input: {
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
			}) satisfies AgentOperationGrant);
	const decision = decideAgentOperationPermission({ request, grants });
	const result = decision.allowed
		? {
				operation: request.operation,
				status: 'completed',
				summary: decision.summary,
				changedPaths: request.changedPaths ?? [],
				stagedPaths: request.operation === 'stage' ? request.changedPaths ?? [] : [],
				commandsRun: [],
				artifacts: [],
				metadata: { permission: decision, planOnly: true },
			} satisfies AgentOperationResult
		: deniedAgentOperationResult(request, decision);
	return {
		projectId: input.projectId,
		planOnly: true,
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

	let releaseAttempted = false;
	let releaseResult: AgentOperationResult | null = null;
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
			},
		}).catch(() => null);
	}

	return {
		...approval,
		state: persistedDecision?.payload?.state ?? stateForDecision(approval.approvalKind, decision),
		decision,
		reason: input.reason ?? null,
		releaseAttempted,
		releaseResult,
	};
}
