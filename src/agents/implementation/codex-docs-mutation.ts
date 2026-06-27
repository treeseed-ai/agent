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
import { runCodexSubscriptionTask, type CodexExecutionResult } from '../adapters/execution-codex.ts';
import type {
	CodexDocsMutationResult,
	CodexDocsMutationTaskInput,
	AgentRepairTaskPayload,
} from '../contracts/implementation.ts';
import type { AgentContext, AgentVerificationAdapter, AgentVerificationResult } from '../runtime-types.ts';
import {
	AgentWorktreeManager,
	changedPathViolations,
	type AgentMergeToStagingResult,
} from '../../services/agent-worktrees.ts';

export interface CodexDocsMutationDependencies {
	worktrees?: AgentWorktreeManager;
	runCodexTask?: typeof runCodexSubscriptionTask;
	verification?: AgentVerificationAdapter;
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown, fallback = '') {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
	return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function isContentPath(path: string) {
	const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
	return normalized === 'src/content'
		|| normalized.startsWith('src/content/')
		|| normalized.startsWith('content/')
		|| normalized.startsWith('knowledge/');
}

function includesContentScope(paths: string[]) {
	return paths.some((path) => {
		const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\*\*.*$/u, '');
		return isContentPath(normalized);
	});
}

function readOperationGrants(value: unknown) {
	return Array.isArray(value) ? value as AgentOperationGrant[] : [];
}

export function normalizeCodexDocsMutationInput(payload: Record<string, unknown>, context: AgentContext): CodexDocsMutationTaskInput {
	const workPackage = readRecord(payload.workPackage) ?? payload;
	const taskId = readString(payload.taskId, context.runId);
	const featureBranch = readString(payload.featureBranch, `${context.agent.execution.branchPrefix}/${taskId}`);
	return {
		taskId,
		workDayId: readString(payload.workDayId) || undefined,
		taskKind: readString(payload.taskKind, 'implementation'),
		agentRole: readString(payload.agentRole, 'engineer'),
		projectId: readString(payload.projectId, 'market'),
		environment: readString(payload.environment, 'local'),
		provider: readString(payload.provider, 'codex'),
		releaseAllowed: readBoolean(payload.releaseAllowed, false),
		goal: readString(payload.goal) || readString(payload.prompt, `Run implementation task ${taskId}.`),
		featureBranch,
		stagingBranch: readString(payload.stagingBranch, 'staging'),
		approvalId: readString(payload.approvalId) || undefined,
		permissionGrantId: readString(payload.permissionGrantId) || undefined,
		operationGrants: readOperationGrants(payload.operationGrants ?? payload.grants),
		allowedPaths: readStringArray(payload.allowedPaths),
		forbiddenPaths: readStringArray(payload.forbiddenPaths),
		verificationCommands: readStringArray(payload.verificationCommands ?? payload.verification),
		sandboxMode: 'workspace_write',
		model: readString(payload.model) || undefined,
		reasoningEffort: ['low', 'medium', 'high'].includes(String(payload.reasoningEffort))
			? payload.reasoningEffort as 'low' | 'medium' | 'high'
			: undefined,
		threadId: readString(payload.threadId) || undefined,
		contextPackSummary: readString(payload.contextPackSummary) || undefined,
		workPackage,
	};
}

async function appendOperationEvent(input: {
	context: AgentContext;
	request: AgentOperationRequest;
	result: AgentOperationResult;
}) {
	await input.context.sdk.createMessage({
		type: 'agent.operation_event',
		payload: createAgentOperationEvent({
			request: input.request,
			result: input.result,
		}) as unknown as Record<string, unknown>,
		relatedModel: 'provider_assignment',
		relatedId: input.context.capacity?.assignment?.id ?? null,
		priority: 100,
	}).catch(() => null);
}

async function lifecycleOperation(input: {
	context: AgentContext;
	task: CodexDocsMutationTaskInput;
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
		agentSlug: input.context.agent.slug,
		agentRole: input.task.agentRole,
		projectId: input.task.projectId,
		environment: input.task.environment,
		repoRoot: input.context.repoRoot,
		worktreeRoot: input.worktreeRoot,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
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
				mergedToStaging: input.operation === 'stage' && input.metadata?.phase === 'staging_merge' ? Boolean(input.metadata?.mergedToStaging) : undefined,
				commandsRun: [],
				artifacts: [],
				metadata: {
					permission: decision,
					...(input.metadata ?? {}),
				},
			} satisfies AgentOperationResult
		: deniedAgentOperationResult(request, decision);
	await appendOperationEvent({ context: input.context, request, result });
	return result;
}

function statusFromOperation(result: AgentOperationResult) {
	return result.status === 'completed' || result.status === 'skipped' || result.status === 'retry_created';
}

function waitingResult(input: {
	task: CodexDocsMutationTaskInput;
	worktreeRoot?: string | null;
	operationResults: AgentOperationResult[];
	summary: string;
	code: string;
}) {
	return {
		status: 'waiting',
		summary: input.summary,
		taskId: input.task.taskId,
		workDayId: input.task.workDayId,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		worktreeRoot: input.worktreeRoot ?? null,
		changedPaths: [],
		operationResults: input.operationResults,
		snapshots: [],
		mergedToStaging: false,
		error: {
			code: input.code,
			message: input.summary,
			retryable: true,
		},
	} satisfies CodexDocsMutationResult;
}

function failedResult(input: {
	task: CodexDocsMutationTaskInput;
	worktreeRoot?: string | null;
	operationResults: AgentOperationResult[];
	summary: string;
	code: string;
	changedPaths?: string[];
	codexResult?: CodexExecutionResult;
	verification?: AgentVerificationResult;
	snapshots?: CodexDocsMutationResult['snapshots'];
	mergeFailure?: CodexDocsMutationResult['mergeFailure'];
	repairTask?: AgentRepairTaskPayload;
	status?: 'failed' | 'merge_failed';
}) {
	return {
		status: input.status ?? 'failed',
		summary: input.summary,
		taskId: input.task.taskId,
		workDayId: input.task.workDayId,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		worktreeRoot: input.worktreeRoot ?? null,
		changedPaths: input.changedPaths ?? [],
		codexResult: input.codexResult,
		verification: input.verification,
		operationResults: input.operationResults,
		snapshots: input.snapshots ?? [],
		mergedToStaging: false,
		mergeFailure: input.mergeFailure,
		repairTask: input.repairTask,
		error: {
			code: input.code,
			message: input.summary,
			retryable: true,
		},
	} satisfies CodexDocsMutationResult;
}

function repairTaskFor(input: {
	task: CodexDocsMutationTaskInput;
	worktreeRoot: string;
	merge: NonNullable<AgentMergeToStagingResult['mergeFailure']>;
}) {
	return {
		taskKind: 'implementation_repair',
		sourceTaskId: input.task.taskId,
		featureBranch: input.task.featureBranch,
		stagingBranch: input.task.stagingBranch,
		worktreeRoot: input.worktreeRoot,
		conflictedPaths: input.merge.conflictedPaths,
		mergeMessage: input.merge.message,
		allowedPaths: input.task.allowedPaths,
		forbiddenPaths: input.task.forbiddenPaths,
	} satisfies AgentRepairTaskPayload;
}

export async function runCodexDocsMutationLifecycle(
	context: AgentContext,
	task: CodexDocsMutationTaskInput,
	dependencies: CodexDocsMutationDependencies = {},
): Promise<CodexDocsMutationResult> {
	const operationResults: AgentOperationResult[] = [];
	const snapshots: CodexDocsMutationResult['snapshots'] = [];
	const worktrees = dependencies.worktrees ?? new AgentWorktreeManager(context.repoRoot);
	const plannedWorktreeRoot = worktrees.plannedWorktreePath(task.featureBranch, task.taskId);

	if (task.provider !== 'codex' && task.provider !== 'codex_subscription') {
		return waitingResult({
			task,
			worktreeRoot: plannedWorktreeRoot,
			operationResults,
			summary: `Unsupported implementation provider "${task.provider}".`,
			code: 'unsupported_provider',
		});
	}

	if (task.allowedPaths.length === 0) {
		return waitingResult({
			task,
			worktreeRoot: plannedWorktreeRoot,
			operationResults,
			summary: 'Approved implementation tasks must declare at least one allowed path.',
			code: 'allowed_paths_required',
		});
	}

	if (includesContentScope(task.allowedPaths) && context.capacity?.assignment && !context.treeDx) {
		return waitingResult({
			task,
			worktreeRoot: plannedWorktreeRoot,
			operationResults,
			summary: 'Content mutation assignments require an assignment-scoped TreeDX workspace handle.',
			code: 'treedx_workspace_required',
		});
	}

	const switchResult = await lifecycleOperation({
		context,
		task,
		operation: 'switch',
		mode: 'mutating',
		worktreeRoot: plannedWorktreeRoot,
		summary: 'Authorized isolated worktree creation.',
	});
	operationResults.push(switchResult);
	if (!statusFromOperation(switchResult)) {
		return waitingResult({
			task,
			worktreeRoot: plannedWorktreeRoot,
			operationResults,
			summary: switchResult.summary,
			code: switchResult.error?.code ?? 'operation_permission_required',
		});
	}

	const worktree = await worktrees.createOrResumeWorktree(task.featureBranch, task.taskId);
	const worktreeRoot = worktree.worktreeRoot;

	const devResult = await lifecycleOperation({
		context,
		task,
		operation: 'dev',
		mode: 'dry_run',
		worktreeRoot,
		summary: 'Completed readiness check before Codex execution.',
	});
	operationResults.push(devResult);
	if (!statusFromOperation(devResult)) {
		return waitingResult({
			task,
			worktreeRoot,
			operationResults,
			summary: devResult.summary,
			code: devResult.error?.code ?? 'operation_permission_required',
		});
	}

	const runCodexTask = dependencies.runCodexTask ?? runCodexSubscriptionTask;
	const codexResult = await runCodexTask({
		taskId: task.taskId,
		workDayId: task.workDayId,
		agentSlug: context.agent.slug,
		repoRoot: context.repoRoot,
		worktreeRoot,
		prompt: task.goal,
		threadId: task.threadId,
		approvalId: task.approvalId,
		allowedPaths: task.allowedPaths,
		forbiddenPaths: task.forbiddenPaths,
		sandboxMode: task.sandboxMode,
		approvalPolicy: 'never',
		model: task.model,
		reasoningEffort: task.reasoningEffort,
		metadata: {
			subscriptionPlan: 'unknown',
			coreObjective: context.coreObjective?.content,
			contextPackSummary: task.contextPackSummary,
			workPackage: task.workPackage,
			approvalId: task.approvalId,
		},
	});
	if (codexResult.status !== 'completed') {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: codexResult.summary ?? 'Codex execution did not complete.',
			changedPaths: [],
			metadata: { codexResult },
		});
		snapshots.push(snapshot);
		const closeResult = await lifecycleOperation({
			context,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot,
			status: 'failed',
			summary: codexResult.summary ?? 'Closed after Codex execution failure.',
			metadata: { codexResult },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			worktreeRoot,
			operationResults,
			codexResult,
			snapshots,
			summary: codexResult.summary ?? 'Codex execution did not complete.',
			code: codexResult.error?.code ?? 'codex_execution_failed',
		});
	}

	const changedPaths = await worktrees.inspectChangedPaths(worktreeRoot);
	const localContentChanges = changedPaths.filter(isContentPath);
	if (localContentChanges.length > 0 && context.treeDx) {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: `Local content writes are blocked when TreeDX workspace access is available: ${localContentChanges.join(', ')}`,
			changedPaths,
			metadata: { codexResult },
		});
		snapshots.push(snapshot);
		return failedResult({
			task,
			worktreeRoot,
			operationResults,
			codexResult,
			snapshots,
			changedPaths,
			summary: `Local content writes are blocked when TreeDX workspace access is available: ${localContentChanges.join(', ')}`,
			code: 'local_content_write_blocked',
		});
	}
	const violations = changedPathViolations({
		changedPaths,
		allowedPaths: task.allowedPaths,
		forbiddenPaths: task.forbiddenPaths,
	});
	if (violations.length > 0) {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: `Changed paths outside approved scope: ${violations.join(', ')}`,
			changedPaths,
			metadata: { codexResult, violations },
		});
		snapshots.push(snapshot);
		const closeResult = await lifecycleOperation({
			context,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot,
			status: 'failed',
			changedPaths,
			summary: 'Closed after scope violation.',
			metadata: { violations },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			worktreeRoot,
			operationResults,
			codexResult,
			snapshots,
			changedPaths,
			summary: `Changed paths outside approved scope: ${violations.join(', ')}`,
			code: 'changed_path_scope_violation',
		});
	}

	const verifyOperation = await lifecycleOperation({
		context,
		task,
		operation: 'verify',
		mode: 'read_only',
		worktreeRoot,
		changedPaths,
		summary: 'Authorized canonical verification.',
		metadata: { commands: task.verificationCommands },
	});
	operationResults.push(verifyOperation);
	if (!statusFromOperation(verifyOperation)) {
		return waitingResult({
			task,
			worktreeRoot,
			operationResults,
			summary: verifyOperation.summary,
			code: verifyOperation.error?.code ?? 'operation_permission_required',
		});
	}
	const verification = await (dependencies.verification ?? context.verification).runChecks({
		agent: context.agent,
		runId: context.runId,
		commands: task.verificationCommands,
		cwd: worktreeRoot,
	});
	if (verification.status !== 'completed') {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'failure',
			summary: verification.summary,
			changedPaths,
			metadata: { codexResult, verification },
		});
		snapshots.push(snapshot);
		const closeResult = await lifecycleOperation({
			context,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot,
			status: 'failed',
			changedPaths,
			summary: verification.summary,
			metadata: { verification },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			worktreeRoot,
			operationResults,
			codexResult,
			verification,
			snapshots,
			changedPaths,
			summary: verification.summary,
			code: verification.errorCategory ?? 'verification_failed',
		});
	}

	const saveOperation = await lifecycleOperation({
		context,
		task,
		operation: 'save',
		mode: 'mutating',
		worktreeRoot,
		changedPaths,
		summary: 'Authorized verified snapshot save.',
	});
	operationResults.push(saveOperation);
	if (!statusFromOperation(saveOperation)) {
		return waitingResult({
			task,
			worktreeRoot,
			operationResults,
			summary: saveOperation.summary,
			code: saveOperation.error?.code ?? 'operation_permission_required',
		});
	}
	const verifiedSnapshot = await worktrees.saveSnapshot({
		taskId: task.taskId,
		kind: 'verified',
		summary: 'Verified Codex docs mutation snapshot.',
		changedPaths,
		metadata: { codexResult, verification },
	});
	snapshots.push(verifiedSnapshot);

	const stageOperation = await lifecycleOperation({
		context,
		task,
		operation: 'stage',
		mode: 'mutating',
		worktreeRoot,
		changedPaths,
		summary: 'Authorized approved path staging.',
	});
	operationResults.push(stageOperation);
	if (!statusFromOperation(stageOperation)) {
		return waitingResult({
			task,
			worktreeRoot,
			operationResults,
			summary: stageOperation.summary,
			code: stageOperation.error?.code ?? 'operation_permission_required',
		});
	}
	await worktrees.stageAndCommit({
		worktreeRoot,
		changedPaths,
		message: `agent: ${task.taskId}`,
	});

	const mergeAuthorization = await lifecycleOperation({
		context,
		task,
		operation: 'stage',
		mode: 'mutating',
		worktreeRoot,
		changedPaths,
		summary: 'Authorized feature branch merge to staging.',
		metadata: { phase: 'staging_merge' },
	});
	operationResults.push(mergeAuthorization);
	if (!statusFromOperation(mergeAuthorization)) {
		return waitingResult({
			task,
			worktreeRoot,
			operationResults,
			summary: mergeAuthorization.summary,
			code: mergeAuthorization.error?.code ?? 'operation_permission_required',
		});
	}
	const mergeResult = await worktrees.mergeToStaging({
		taskId: task.taskId,
		featureBranch: task.featureBranch,
		stagingBranch: task.stagingBranch,
	});
	if (!mergeResult.mergedToStaging && mergeResult.mergeFailure) {
		const snapshot = await worktrees.saveSnapshot({
			taskId: task.taskId,
			kind: 'merge_failure',
			summary: mergeResult.mergeFailure.message,
			changedPaths,
			metadata: { mergeFailure: mergeResult.mergeFailure },
		});
		snapshots.push(snapshot);
		const repairTask = repairTaskFor({
			task,
			worktreeRoot,
			merge: mergeResult.mergeFailure,
		});
		const closeResult = await lifecycleOperation({
			context,
			task,
			operation: 'close',
			mode: 'mutating',
			worktreeRoot,
			status: 'failed',
			changedPaths,
			summary: mergeResult.mergeFailure.message,
			metadata: { repairTask },
		});
		operationResults.push(closeResult);
		return failedResult({
			task,
			worktreeRoot,
			operationResults,
			codexResult,
			verification,
			snapshots,
			changedPaths,
			summary: mergeResult.mergeFailure.message,
			code: 'staging_merge_failed',
			status: 'merge_failed',
			mergeFailure: mergeResult.mergeFailure,
			repairTask,
		});
	}

	const closeResult = await lifecycleOperation({
		context,
		task,
		operation: 'close',
		mode: 'mutating',
		worktreeRoot,
		changedPaths,
		status: 'completed',
		summary: 'Closed implementation task as staged.',
		metadata: { mergedToStaging: true, mergeResult },
	});
	operationResults.push(closeResult);
	return {
		status: 'staged',
		summary: `Codex docs mutation ${task.taskId} merged to ${task.stagingBranch}.`,
		taskId: task.taskId,
		workDayId: task.workDayId,
		featureBranch: task.featureBranch,
		stagingBranch: task.stagingBranch,
		worktreeRoot,
		changedPaths,
		codexResult,
		verification,
		operationResults,
		snapshots,
		mergedToStaging: true,
	};
}
