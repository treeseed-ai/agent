import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
	createAgentOperationEvent,
	decideAgentOperationPermission,
	deniedAgentOperationResult,
	type AgentOperationGrant,
	type AgentOperationName,
	type AgentOperationRequest,
	type AgentOperationResult,
	type AgentOperationStatus,
} from '@treeseed/sdk/operations/agent-tools';
import type { KnowledgeDraft } from '../agents/contracts/knowledge.ts';
import { validateKnowledgeDraft } from '../agents/contracts/knowledge.ts';
import { serializeKnowledgeDraft } from '../agents/knowledge/pipeline.ts';
import { AgentWorktreeManager, type AgentMergeToStagingResult } from './agent-worktrees.ts';

const execFileAsync = promisify(execFile);

export const PROMOTION_APPROVAL_DECISIONS = [
	'approve_as_book_content',
	'request_more_research',
	'reject',
] as const;

export const RELEASE_APPROVAL_DECISIONS = [
	'approve_release',
	'reject_release',
] as const;

export type PromotionApprovalDecision = typeof PROMOTION_APPROVAL_DECISIONS[number];
export type ReleaseApprovalDecision = typeof RELEASE_APPROVAL_DECISIONS[number];
export type AgentApprovalDecision = PromotionApprovalDecision | ReleaseApprovalDecision;
export type AgentApprovalKind = 'promote_knowledge_draft' | 'release_staged_knowledge';

export interface KnowledgePromotionApprovalDecisionRecord {
	approvalId: string;
	decision: PromotionApprovalDecision;
	actor: string;
	reason?: string | null;
	decidedAt?: string;
}

export interface ReleaseStagedKnowledgeRequest {
	id: string;
	approvalKind: 'release_staged_knowledge';
	draftId: string;
	targetPath: string;
	recommendation: 'approve_release';
	sourceQuestionId?: string;
	sourceResearchIds: string[];
	sourcePromotionTaskId: string;
	promotionApprovalId: string;
	featureBranch: string;
	stagingBranch: string;
	changedPaths: string[];
	stagedCommitSha?: string | null;
	releaseInput: { bump: 'patch' | 'minor' | 'major' };
}

export interface KnowledgePromotionToStagingResult {
	status: 'staged' | 'waiting' | 'failed' | 'merge_failed';
	summary: string;
	taskId: string;
	workDayId?: string;
	draftId?: string;
	targetPath?: string;
	featureBranch?: string;
	stagingBranch?: string;
	worktreeRoot?: string | null;
	changedPaths: string[];
	verification?: {
		ok: boolean;
		summary: string;
		commandsRun: string[];
		errors: string[];
	};
	snapshots: Array<{
		kind: string;
		ref: string;
		summary: string;
		changedPaths: string[];
		createdAt: string;
	}>;
	operationResults: AgentOperationResult[];
	mergedToStaging: boolean;
	stagedCommitSha?: string | null;
	mergeCommitSha?: string | null;
	mergeFailure?: AgentMergeToStagingResult['mergeFailure'];
	repairTask?: Record<string, unknown>;
	releaseRequest?: ReleaseStagedKnowledgeRequest;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	};
}

export interface KnowledgePromotionTaskInput {
	taskId: string;
	workDayId?: string;
	projectId: string;
	environment: string;
	agentSlug: string;
	agentRole: string;
	repoRoot: string;
	taskKind: 'promote_knowledge_to_staging';
	approvalDecision: KnowledgePromotionApprovalDecisionRecord;
	knowledgeDraft: KnowledgeDraft;
	allowedPaths: string[];
	forbiddenPaths: string[];
	featureBranch: string;
	stagingBranch: string;
	verificationCommands: string[];
	operationGrants: AgentOperationGrant[];
	permissionGrantId?: string;
	repositoryClaim?: {
		id?: string;
		repositoryId?: string;
		runnerId?: string;
		volumeIdentity?: string;
		claimState?: string;
		metadata?: Record<string, unknown>;
	} | null;
}

export interface KnowledgePromotionDependencies {
	worktrees?: AgentWorktreeManager;
	verify?: (input: {
		worktreeRoot: string;
		commands: string[];
		draft: KnowledgeDraft;
	}) => Promise<KnowledgePromotionToStagingResult['verification']>;
}

function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown, fallback = '') {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function hostedRuntimeEnabled() {
	return process.env.TREESEED_AGENT_RUNTIME_MODE?.trim() === 'hosted';
}

function readRepositoryClaim(value: unknown): KnowledgePromotionTaskInput['repositoryClaim'] {
	const claim = readRecord(value);
	if (!Object.keys(claim).length) return null;
	return {
		id: readString(claim.id) || undefined,
		repositoryId: readString(claim.repositoryId ?? claim.repository_id) || undefined,
		runnerId: readString(claim.runnerId ?? claim.runner_id) || undefined,
		volumeIdentity: readString(claim.volumeIdentity ?? claim.volume_identity) || undefined,
		claimState: readString(claim.claimState ?? claim.claim_state, 'active'),
		metadata: readRecord(claim.metadata),
	};
}

function repoRootFromClaim(claim: KnowledgePromotionTaskInput['repositoryClaim'], fallback: string) {
	if (!claim || claim.claimState !== 'active') return fallback;
	const metadata = readRecord(claim.metadata);
	const candidates = [
		metadata.worktreeRoot,
		metadata.repositoryRoot,
		metadata.checkoutRoot,
		metadata.volumeRepositoryRoot,
		claim.volumeIdentity,
	];
	for (const candidate of candidates) {
		const value = readString(candidate);
		if (value) return value;
	}
	return fallback;
}

function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9./_-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 96) || 'knowledge-promotion';
}

function defaultPromotionGrant(input: {
	taskId: string;
	taskKind: string;
	projectId: string;
	environment: string;
	agentRole: string;
	allowedPaths: string[];
	forbiddenPaths: string[];
}) {
	return {
		id: `grant:knowledge-promotion:${input.taskId}`,
		state: 'active',
		operations: ['switch', 'dev', 'verify', 'save', 'stage', 'merge_to_staging', 'close'] as AgentOperationName[],
		modes: ['dry_run', 'read_only', 'mutating'],
		agentRoles: [input.agentRole],
		taskKinds: [input.taskKind],
		projectIds: [input.projectId],
		environments: [input.environment],
		allowedPaths: input.allowedPaths,
		forbiddenPaths: input.forbiddenPaths,
		metadata: {
			source: 'approved_knowledge_promotion',
		},
	} satisfies AgentOperationGrant;
}

export function defaultReleaseGrant(input: {
	taskId: string;
	projectId: string;
	environment: string;
	approvalId: string;
}) {
	return {
		id: `grant:knowledge-release:${input.taskId}`,
		state: 'active',
		operations: ['release'] as AgentOperationName[],
		modes: ['mutating'],
		agentRoles: ['releaser'],
		taskKinds: ['release_staged_knowledge_request'],
		projectIds: [input.projectId],
		environments: [input.environment],
		requiresApproval: true,
		approvalIds: [input.approvalId],
		metadata: {
			source: 'staged_knowledge_release_request',
		},
	} satisfies AgentOperationGrant;
}

export function normalizeKnowledgePromotionTaskInput(input: {
	task: Record<string, unknown>;
	payload: Record<string, unknown>;
	repoRoot: string;
	projectId?: string;
	environment?: string;
}): KnowledgePromotionTaskInput | null {
	const taskId = readString(input.task.id, readString(input.payload.taskId));
	const draft = readRecord(input.payload.knowledgeDraft) as unknown as KnowledgeDraft;
	const decision = readRecord(input.payload.approvalDecision) as unknown as KnowledgePromotionApprovalDecisionRecord;
	if (!taskId || draft.kind !== 'knowledge_draft' || decision.decision !== 'approve_as_book_content') {
		return null;
	}
	const allowedPaths = readStringArray(input.payload.allowedPaths);
	const forbiddenPaths = readStringArray(input.payload.forbiddenPaths);
	const targetPath = draft.targetPath;
	const taskKind = 'promote_knowledge_to_staging';
	const projectId = readString(input.payload.projectId, input.projectId ?? 'market');
	const environment = readString(input.payload.environment, input.environment ?? 'local');
	const agentRole = readString(input.payload.agentRole, 'engineer');
	const grantInput = {
		taskId,
		taskKind,
		projectId,
		environment,
		agentRole,
		allowedPaths: allowedPaths.length ? allowedPaths : [targetPath],
		forbiddenPaths,
	};
	const explicitOperationGrants = Array.isArray(input.payload.operationGrants) && input.payload.operationGrants.length
		? input.payload.operationGrants as AgentOperationGrant[]
		: null;
	const hostedRuntimeRequiresExplicitGrants = hostedRuntimeEnabled();
	const operationGrants = explicitOperationGrants
		?? (hostedRuntimeRequiresExplicitGrants ? [] : [defaultPromotionGrant(grantInput)]);
	const repositoryClaim = readRepositoryClaim(input.payload.repositoryClaim ?? input.payload.repository_claim);
	return {
		taskId,
		workDayId: readString(input.task.workDayId, readString(input.task.work_day_id)) || readString(input.payload.workDayId) || undefined,
		projectId,
		environment,
		agentSlug: readString(input.payload.agentSlug, 'engineer-agent'),
		agentRole,
		repoRoot: hostedRuntimeRequiresExplicitGrants ? repoRootFromClaim(repositoryClaim, input.repoRoot) : input.repoRoot,
		taskKind,
		approvalDecision: decision,
		knowledgeDraft: draft,
		allowedPaths: grantInput.allowedPaths,
		forbiddenPaths,
		featureBranch: readString(input.payload.featureBranch, `agent/knowledge-promotion/${slugify(taskId)}`),
		stagingBranch: readString(input.payload.stagingBranch, 'staging'),
		verificationCommands: readStringArray(input.payload.verificationCommands ?? input.payload.verification),
		operationGrants,
		permissionGrantId: readString(input.payload.permissionGrantId) || undefined,
		repositoryClaim,
	};
}

async function appendOperationEvent(input: {
	sdk?: { appendTaskEvent?: (request: { taskId: string; kind: string; data: Record<string, unknown>; actor: string }) => Promise<unknown> };
	task: KnowledgePromotionTaskInput;
	request: AgentOperationRequest;
	result: AgentOperationResult;
}) {
	if (typeof input.sdk?.appendTaskEvent !== 'function') return;
	await input.sdk.appendTaskEvent({
		taskId: input.task.taskId,
		kind: 'operation_event',
		data: createAgentOperationEvent({
			request: input.request,
			result: input.result,
		}) as unknown as Record<string, unknown>,
		actor: input.task.agentSlug,
	});
}

async function lifecycleOperation(input: {
	sdk?: { appendTaskEvent?: (request: { taskId: string; kind: string; data: Record<string, unknown>; actor: string }) => Promise<unknown> };
	task: KnowledgePromotionTaskInput;
	operation: AgentOperationName;
	mode: AgentOperationRequest['mode'];
	worktreeRoot?: string;
	changedPaths?: string[];
	status?: AgentOperationStatus;
	summary?: string;
	metadata?: Record<string, unknown>;
}) {
	const request: AgentOperationRequest = {
		operation: input.operation,
		mode: input.mode,
		taskId: input.task.taskId,
		taskKind: input.task.taskKind,
		workDayId: input.task.workDayId,
		agentSlug: input.task.agentSlug,
		agentRole: input.task.agentRole,
		projectId: input.task.projectId,
		environment: input.task.environment,
		repoRoot: input.task.repoRoot,
		worktreeRoot: input.worktreeRoot,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		approvalId: input.task.approvalDecision.approvalId,
		approval: {
			id: input.task.approvalDecision.approvalId,
			kind: 'promote_knowledge_draft',
			state: 'approved',
		},
		permissionGrantId: input.task.permissionGrantId,
		allowedPaths: input.task.allowedPaths,
		forbiddenPaths: input.task.forbiddenPaths,
		changedPaths: input.changedPaths ?? [],
		input: input.metadata ?? {},
	};
	const decision = decideAgentOperationPermission({
		request,
		grants: input.task.operationGrants,
	});
	const result = decision.allowed
		? {
				operation: input.operation,
				status: input.status ?? 'completed',
				summary: input.summary ?? `Completed handler-controlled ${input.operation}.`,
				changedPaths: input.changedPaths ?? [],
				stagedPaths: input.operation === 'stage' ? input.changedPaths ?? [] : [],
				mergedToStaging: input.operation === 'merge_to_staging' ? Boolean(input.metadata?.mergedToStaging) : undefined,
				mergeFailure: input.metadata?.mergeFailure as AgentOperationResult['mergeFailure'],
				commandsRun: [],
				artifacts: [],
				metadata: {
					permission: decision,
					...(input.metadata ?? {}),
				},
			} satisfies AgentOperationResult
		: deniedAgentOperationResult(request, decision);
	await appendOperationEvent({ sdk: input.sdk, task: input.task, request, result });
	return result;
}

function resultStatusOk(result: AgentOperationResult) {
	return result.status === 'completed' || result.status === 'skipped' || result.status === 'retry_created';
}

function failedResult(input: {
	task: KnowledgePromotionTaskInput;
	status?: KnowledgePromotionToStagingResult['status'];
	summary: string;
	code: string;
	worktreeRoot?: string | null;
	changedPaths?: string[];
	operationResults: AgentOperationResult[];
	snapshots?: KnowledgePromotionToStagingResult['snapshots'];
	verification?: KnowledgePromotionToStagingResult['verification'];
	mergeFailure?: AgentMergeToStagingResult['mergeFailure'];
	repairTask?: Record<string, unknown>;
}) {
	return {
		status: input.status ?? 'failed',
		summary: input.summary,
		taskId: input.task.taskId,
		workDayId: input.task.workDayId,
		draftId: input.task.knowledgeDraft.id,
		targetPath: input.task.knowledgeDraft.targetPath,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		worktreeRoot: input.worktreeRoot ?? null,
		changedPaths: input.changedPaths ?? [],
		verification: input.verification,
		snapshots: input.snapshots ?? [],
		operationResults: input.operationResults,
		mergedToStaging: false,
		mergeFailure: input.mergeFailure,
		repairTask: input.repairTask,
		error: {
			code: input.code,
			message: input.summary,
			retryable: true,
		},
	} satisfies KnowledgePromotionToStagingResult;
}

async function defaultVerify(input: {
	worktreeRoot: string;
	commands: string[];
	draft: KnowledgeDraft;
}) {
	const validation = validateKnowledgeDraft(input.draft);
	if (!validation.ok) {
		return {
			ok: false,
			summary: validation.errors.join(' '),
			commandsRun: [],
			errors: validation.errors,
		};
	}
	const commandsRun: string[] = [];
	const errors: string[] = [];
	for (const command of input.commands) {
		commandsRun.push(command);
		try {
			await execFileAsync('sh', ['-lc', command], {
				cwd: input.worktreeRoot,
				env: process.env,
				maxBuffer: 1024 * 1024 * 10,
			});
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return {
		ok: errors.length === 0,
		summary: errors.length ? errors.join('\n') : 'Knowledge promotion verification passed.',
		commandsRun,
		errors,
	};
}

function releaseRequestFor(input: {
	task: KnowledgePromotionTaskInput;
	changedPaths: string[];
	stagedCommitSha?: string | null;
	mergeCommitSha?: string | null;
}) {
	return {
		id: `release:${input.task.knowledgeDraft.id}`,
		approvalKind: 'release_staged_knowledge',
		draftId: input.task.knowledgeDraft.id,
		targetPath: input.task.knowledgeDraft.targetPath,
		recommendation: 'approve_release',
		sourceQuestionId: input.task.knowledgeDraft.sourceQuestionId,
		sourceResearchIds: input.task.knowledgeDraft.sourceResearchIds,
		sourcePromotionTaskId: input.task.taskId,
		promotionApprovalId: input.task.approvalDecision.approvalId,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		changedPaths: input.changedPaths,
		stagedCommitSha: input.mergeCommitSha ?? input.stagedCommitSha ?? null,
		releaseInput: { bump: 'patch' },
	} satisfies ReleaseStagedKnowledgeRequest;
}

function repairTaskFor(input: {
	task: KnowledgePromotionTaskInput;
	worktreeRoot: string;
	mergeFailure: NonNullable<AgentMergeToStagingResult['mergeFailure']>;
}) {
	return {
		kind: 'knowledge_promotion_merge_repair',
		sourceTaskId: input.task.taskId,
		draftId: input.task.knowledgeDraft.id,
		targetPath: input.task.knowledgeDraft.targetPath,
		worktreeRoot: input.worktreeRoot,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		mergeFailure: input.mergeFailure,
	};
}

function verificationRepairTaskFor(input: {
	task: KnowledgePromotionTaskInput;
	worktreeRoot: string;
	snapshotRef?: string | null;
	changedPaths: string[];
	verification: NonNullable<KnowledgePromotionToStagingResult['verification']>;
}) {
	return {
		kind: 'knowledge_promotion_verification_repair',
		sourceTaskId: input.task.taskId,
		draftId: input.task.knowledgeDraft.id,
		targetPath: input.task.knowledgeDraft.targetPath,
		worktreeRoot: input.worktreeRoot,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		snapshotRef: input.snapshotRef ?? null,
		failedCommands: input.verification.commandsRun,
		changedPaths: input.changedPaths,
		verificationErrors: input.verification.errors,
		verificationSummary: input.verification.summary,
	};
}

export async function runKnowledgePromotionToStaging(input: {
	task: KnowledgePromotionTaskInput;
	sdk?: { appendTaskEvent?: (request: { taskId: string; kind: string; data: Record<string, unknown>; actor: string }) => Promise<unknown> };
	dependencies?: KnowledgePromotionDependencies;
}) {
	const task = input.task;
	const operationResults: AgentOperationResult[] = [];
	const snapshots: KnowledgePromotionToStagingResult['snapshots'] = [];
	const worktrees = input.dependencies?.worktrees ?? new AgentWorktreeManager(task.repoRoot);
	const verify = input.dependencies?.verify ?? defaultVerify;

	if (task.approvalDecision.decision !== 'approve_as_book_content') {
		return failedResult({
			task,
			status: 'waiting',
			summary: 'Knowledge promotion requires an approve_as_book_content decision.',
			code: 'approval_required',
			operationResults,
		});
	}

	if (hostedRuntimeEnabled() && task.repositoryClaim?.claimState !== 'active') {
		await input.sdk?.appendTaskEvent?.({
			taskId: task.taskId,
			kind: 'hosted_repository_claim_required',
			data: {
				projectId: task.projectId,
				environment: task.environment,
				runnerId: task.repositoryClaim?.runnerId ?? null,
				repositoryClaimId: task.repositoryClaim?.id ?? null,
			},
			actor: task.agentSlug,
		});
		return failedResult({
			task,
			status: 'waiting',
			summary: 'Hosted knowledge promotion requires an active runner repository claim.',
			code: 'repository_claim_required',
			operationResults,
		});
	}

	const switchResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'switch',
		mode: 'mutating',
		worktreeRoot: worktrees.plannedWorktreePath(task.featureBranch),
		summary: 'Prepared isolated knowledge promotion worktree.',
	});
	operationResults.push(switchResult);
	if (!resultStatusOk(switchResult)) {
		return failedResult({
			task,
			status: 'waiting',
			summary: switchResult.summary,
			code: switchResult.error?.code ?? 'operation_permission_required',
			operationResults,
		});
	}

	const worktree = await worktrees.createOrResumeWorktree(task.featureBranch);
	const draftForStaging: KnowledgeDraft = {
		...task.knowledgeDraft,
		state: 'feature_branch',
		reviewState: 'verified_for_staging',
		frontmatter: {
			...task.knowledgeDraft.frontmatter,
			status: 'canonical',
			review_state: 'verified_for_staging',
			updated: new Date().toISOString().slice(0, 10),
		},
		updatedAt: new Date().toISOString(),
	};
	const targetPath = join(worktree.worktreeRoot, task.knowledgeDraft.targetPath);
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, serializeKnowledgeDraft(draftForStaging), 'utf8');

	const changedPaths = await worktrees.inspectChangedPaths(worktree.worktreeRoot);
	try {
		worktrees.assertChangedPathsAllowed({
			changedPaths,
			allowedPaths: task.allowedPaths,
			forbiddenPaths: task.forbiddenPaths,
		});
	} catch (error) {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: error instanceof Error ? error.message : String(error),
			changedPaths,
			metadata: { targetPath: task.knowledgeDraft.targetPath },
		});
		snapshots.push(snapshot);
		return failedResult({
			task,
			worktreeRoot: worktree.worktreeRoot,
			summary: error instanceof Error ? error.message : String(error),
			code: 'changed_path_scope_violation',
			changedPaths,
			operationResults,
			snapshots,
		});
	}

	const verifyResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'verify',
		mode: 'mutating',
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		summary: 'Ran canonical knowledge promotion verification.',
	});
	operationResults.push(verifyResult);
	if (!resultStatusOk(verifyResult)) {
		return failedResult({
			task,
			status: 'waiting',
			worktreeRoot: worktree.worktreeRoot,
			summary: verifyResult.summary,
			code: verifyResult.error?.code ?? 'operation_permission_required',
			changedPaths,
			operationResults,
			snapshots,
		});
	}

	const verification = await verify({
		worktreeRoot: worktree.worktreeRoot,
		commands: task.verificationCommands,
		draft: draftForStaging,
	});
	if (!verification.ok) {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: verification.summary,
			changedPaths,
			metadata: { verification },
		});
		snapshots.push(snapshot);
		const repairTask = verificationRepairTaskFor({
			task,
			worktreeRoot: worktree.worktreeRoot,
			snapshotRef: snapshot.ref,
			changedPaths,
			verification,
		});
		const closeResult = await lifecycleOperation({
			sdk: input.sdk,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot: worktree.worktreeRoot,
			changedPaths,
			status: 'failed',
			summary: 'Closed failed knowledge promotion after verification failure.',
			metadata: { verification, repairTask },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			worktreeRoot: worktree.worktreeRoot,
			summary: verification.summary,
			code: 'verification_failed',
			changedPaths,
			operationResults,
			snapshots,
			verification,
			repairTask,
		});
	}

	const verifiedSnapshot = await worktrees.saveSnapshot({
		taskId: task.taskId,
		kind: 'verified',
		summary: 'Verified knowledge draft promotion snapshot.',
		changedPaths,
		metadata: { verification },
	});
	snapshots.push(verifiedSnapshot);
	const saveResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'save',
		mode: 'mutating',
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		summary: 'Saved verified knowledge promotion snapshot.',
		metadata: { snapshot: verifiedSnapshot },
	});
	operationResults.push(saveResult);
	if (!resultStatusOk(saveResult)) {
		return failedResult({
			task,
			status: 'waiting',
			worktreeRoot: worktree.worktreeRoot,
			summary: saveResult.summary,
			code: saveResult.error?.code ?? 'operation_permission_required',
			changedPaths,
			operationResults,
			snapshots,
			verification,
		});
	}

	const stageResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'stage',
		mode: 'mutating',
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		summary: 'Staged approved knowledge paths in the feature worktree.',
	});
	operationResults.push(stageResult);
	if (!resultStatusOk(stageResult)) {
		return failedResult({
			task,
			status: 'waiting',
			worktreeRoot: worktree.worktreeRoot,
			summary: stageResult.summary,
			code: stageResult.error?.code ?? 'operation_permission_required',
			changedPaths,
			operationResults,
			snapshots,
			verification,
		});
	}
	const stagedCommitSha = await worktrees.stageAndCommit({
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		message: `docs: promote ${task.knowledgeDraft.id}`,
	});

	const mergeResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'merge_to_staging',
		mode: 'mutating',
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		summary: 'Merged verified knowledge promotion to staging.',
	});
	operationResults.push(mergeResult);
	if (!resultStatusOk(mergeResult)) {
		return failedResult({
			task,
			status: 'waiting',
			worktreeRoot: worktree.worktreeRoot,
			summary: mergeResult.summary,
			code: mergeResult.error?.code ?? 'operation_permission_required',
			changedPaths,
			operationResults,
			snapshots,
			verification,
		});
	}
	const merge = await worktrees.mergeToStaging({
		taskId: task.taskId,
		featureBranch: worktree.branchName,
		stagingBranch: task.stagingBranch,
	});
	if (!merge.mergedToStaging) {
		const failureSnapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'merge_failure',
			summary: merge.mergeFailure?.message ?? 'Merge to staging failed.',
			changedPaths,
			metadata: { mergeFailure: merge.mergeFailure },
		});
		snapshots.push(failureSnapshot);
		const repairTask = merge.mergeFailure
			? repairTaskFor({ task, worktreeRoot: worktree.worktreeRoot, mergeFailure: merge.mergeFailure })
			: undefined;
		const closeResult = await lifecycleOperation({
			sdk: input.sdk,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot: worktree.worktreeRoot,
			changedPaths,
			status: 'retry_created',
			summary: 'Closed knowledge promotion with merge repair context.',
			metadata: { mergeFailure: merge.mergeFailure, repairTask },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			status: 'merge_failed',
			worktreeRoot: worktree.worktreeRoot,
			summary: merge.mergeFailure?.message ?? 'Merge to staging failed.',
			code: 'merge_to_staging_failed',
			changedPaths,
			operationResults,
			snapshots,
			verification,
			mergeFailure: merge.mergeFailure,
			repairTask,
		});
	}

	const releaseRequest = releaseRequestFor({
		task,
		changedPaths,
		stagedCommitSha,
		mergeCommitSha: merge.commitSha,
	});
	const closeResult = await lifecycleOperation({
		sdk: input.sdk,
		task,
		operation: 'close',
		mode: 'mutating',
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		summary: 'Closed staged knowledge promotion and created release approval request.',
		metadata: { releaseRequest, mergedToStaging: true, commitSha: merge.commitSha },
	});
	operationResults.push(closeResult);

	return {
		status: 'staged',
		summary: 'Knowledge draft was verified, merged to staging, and is waiting for release approval.',
		taskId: task.taskId,
		workDayId: task.workDayId,
		draftId: task.knowledgeDraft.id,
		targetPath: task.knowledgeDraft.targetPath,
		featureBranch: worktree.branchName,
		stagingBranch: task.stagingBranch,
		worktreeRoot: worktree.worktreeRoot,
		changedPaths,
		verification,
		snapshots,
		operationResults,
		mergedToStaging: true,
		stagedCommitSha,
		mergeCommitSha: merge.commitSha,
		releaseRequest,
	} satisfies KnowledgePromotionToStagingResult;
}
