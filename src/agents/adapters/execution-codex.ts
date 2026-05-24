import { Codex } from '@openai/codex-sdk';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type { AgentExecutionAdapter, AgentExecutionResult } from '../runtime-types.ts';
import { prependCoreObjectiveToPrompt } from '../core-objective.ts';
import {
	type CodexApprovalPolicy,
	type CodexSandboxMode,
	resolveCodexProviderConfig,
} from './codex-readiness.ts';
import { codexClientEnvironment } from './codex-auth.ts';
import { AgentWorktreeManager } from '../../services/agent-worktrees.ts';

export type CodexExecutionStatus = 'completed' | 'waiting' | 'failed';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';

export interface CodexExecutionRequest {
	taskId: string;
	workDayId?: string;
	agentSlug: string;
	repoRoot: string;
	worktreeRoot?: string;
	prompt: string;
	threadId?: string;
	approvalId?: string;
	allowedPaths: string[];
	forbiddenPaths: string[];
	sandboxMode: CodexSandboxMode;
	approvalPolicy: CodexApprovalPolicy;
	model?: string;
	reasoningEffort?: CodexReasoningEffort;
	timeoutMs?: number;
	metadata?: Record<string, unknown>;
}

export interface CodexExecutionResult {
	provider: 'codex';
	threadId: string;
	status: CodexExecutionStatus;
	finalResponse?: string;
	summary?: string;
	changedPaths: string[];
	proposedCommands: string[];
	verificationHints: string[];
	rawEventRefs?: string[];
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	};
	usage?: {
		subscriptionPlan?: string;
		estimatedCredits?: number;
		wallMs?: number;
		wallMinutes?: number;
		nativeUnit?: 'wall_minute';
		inputTokens?: number | null;
		outputTokens?: number | null;
		cachedInputTokens?: number | null;
		filesChanged?: number;
	};
	metadata?: Record<string, unknown>;
}

export interface CodexSubscriptionClient {
	startThread(options?: CodexThreadOptions): CodexThread;
	resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
}

export interface CodexThread {
	id?: string | null;
	run(input: string, options?: Record<string, unknown>): Promise<CodexRunResult>;
}

export interface CodexThreadOptions {
	model?: string;
	sandboxMode?: 'read-only' | 'workspace-write';
	workingDirectory?: string;
	skipGitRepoCheck?: boolean;
	modelReasoningEffort?: 'low' | 'medium' | 'high';
	approvalPolicy?: 'never' | 'on-request';
}

export interface CodexRunResult {
	items?: unknown[];
	finalResponse?: string;
	usage?: {
		input_tokens?: number;
		cached_input_tokens?: number;
		output_tokens?: number;
		reasoning_output_tokens?: number;
	} | null;
}

export interface RunCodexSubscriptionTaskOptions {
	createCodexClient?: () => CodexSubscriptionClient | Promise<CodexSubscriptionClient>;
	now?: () => number;
}

export interface PreparedCodexWorktree {
	branchName: string;
	worktreeRoot: string;
	created?: boolean;
}

export class CodexRequestSafetyError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = 'CodexRequestSafetyError';
	}
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function matchesPattern(path: string, pattern: string) {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);
	if (normalizedPattern === '**' || normalizedPattern === '*') {
		return true;
	}
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('/')) {
		return normalizedPath.startsWith(normalizedPattern);
	}
	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function isChangedPathAllowed(path: string, allowedPaths: string[], forbiddenPaths: string[]) {
	if (forbiddenPaths.some((pattern) => matchesPattern(path, pattern))) {
		return false;
	}
	return allowedPaths.length === 0 || allowedPaths.some((pattern) => matchesPattern(path, pattern));
}

export function validateCodexExecutionRequest(request: CodexExecutionRequest) {
	if (!request.taskId.trim()) {
		throw new CodexRequestSafetyError('task_id_required', 'Codex execution requires a task id.');
	}
	if (!request.agentSlug.trim()) {
		throw new CodexRequestSafetyError('agent_slug_required', 'Codex execution requires an agent slug.');
	}
	if (!request.repoRoot.trim()) {
		throw new CodexRequestSafetyError('repo_root_required', 'Codex execution requires a repository root.');
	}
	if (request.sandboxMode === 'workspace_write') {
		if (request.allowedPaths.length === 0) {
			throw new CodexRequestSafetyError(
				'allowed_paths_required',
				'Codex workspace-write execution requires at least one allowed path.',
				true,
			);
		}
		if (!request.worktreeRoot?.trim()) {
			throw new CodexRequestSafetyError(
				'worktree_required',
				'Codex workspace-write execution requires an assigned worktree root.',
				true,
			);
		}
	}
}

function safetyResult(request: CodexExecutionRequest, error: CodexRequestSafetyError): CodexExecutionResult {
	return {
		provider: 'codex',
		threadId: request.threadId ?? '',
		status: error.retryable ? 'waiting' : 'failed',
		summary: error.message,
		changedPaths: [],
		proposedCommands: [],
		verificationHints: [],
		error: {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
		},
	};
}

async function createDefaultCodexClient(): Promise<CodexSubscriptionClient> {
	return new Codex({ env: codexClientEnvironment() } as ConstructorParameters<typeof Codex>[0]);
}

export function mapCodexThreadOptions(request: CodexExecutionRequest): CodexThreadOptions {
	const workingDirectory = request.sandboxMode === 'workspace_write'
		? request.worktreeRoot ?? request.repoRoot
		: request.repoRoot;
	return {
		model: request.model,
		sandboxMode: request.sandboxMode === 'workspace_write' ? 'workspace-write' : 'read-only',
		workingDirectory,
		skipGitRepoCheck: true,
		modelReasoningEffort: request.reasoningEffort,
		approvalPolicy: request.approvalPolicy === 'never' ? 'never' : 'on-request',
	};
}

function formatList(values: string[]) {
	return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '- <none>';
}

function formatMetadataBlock(value: unknown) {
	if (value === undefined || value === null) return '<none>';
	if (typeof value === 'string') return value.trim() || '<none>';
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function buildCodexPrompt(request: CodexExecutionRequest) {
	const permissionStage = request.sandboxMode === 'workspace_write'
		? 'approved_worktree_mutation'
		: 'read_only_or_planning';
	const contextPackSummary = request.metadata?.contextPackSummary ?? request.metadata?.contextSummary;
	const workPackage = request.metadata?.workPackage ?? request.metadata?.workPackageYaml;
	const operationBoundary = request.sandboxMode === 'workspace_write'
		? [
			'- The handler controls save, stage, merge_to_staging, close, and release.',
			'- Do not stage shared branches.',
			'- Do not merge to staging directly.',
			'- Do not close the task directly.',
			'- Do not release.',
		].join('\n')
		: '- Treat this as read-only/planning unless the handler grants a later mutation stage.';
	const taskPrompt = [
		'You are operating as a TreeSeed implementation agent.',
		'',
		'Goal:',
		request.prompt,
		'',
		'Current permission stage:',
		permissionStage,
		'',
		`Task id: ${request.taskId}`,
		`Workday id: ${request.workDayId ?? '<none>'}`,
		`Agent slug: ${request.agentSlug}`,
		`Repository root: ${request.repoRoot}`,
		`Assigned worktree root: ${request.worktreeRoot ?? '<none>'}`,
		'',
		'Allowed paths:',
		formatList(request.allowedPaths),
		'',
		'Forbidden paths:',
		formatList(request.forbiddenPaths),
		'',
		'Required behavior:',
		'- Do not modify files outside allowed paths.',
		'- Do not write outside the assigned git worktree.',
		operationBoundary,
		'- Do not approve decisions.',
		'- Prefer small, reviewable changes.',
		'- Run or suggest verification that is relevant to the change.',
		'- Report uncertainty.',
		'- Record commands you ran or believe should be run.',
		'- If the task requires broader scope, stop and return TASK_WAITING.',
		'',
		'Context pack:',
		formatMetadataBlock(contextPackSummary),
		'',
		'Work package:',
		formatMetadataBlock(workPackage),
	].join('\n');
	return prependCoreObjectiveToPrompt({
		prompt: taskPrompt,
		repoRoot: request.repoRoot,
		coreObjective: typeof request.metadata?.coreObjective === 'string'
			? request.metadata.coreObjective
			: null,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
	return typeof value === 'string' ? value : undefined;
}

function extractCommand(item: Record<string, unknown>) {
	return item.type === 'command_execution' ? stringValue(item.command) : undefined;
}

function extractFileChangePaths(item: Record<string, unknown>) {
	if (item.type !== 'file_change' || !Array.isArray(item.changes)) return [];
	return item.changes
		.map((change) => isRecord(change) ? stringValue(change.path) : undefined)
		.filter((path): path is string => Boolean(path));
}

function commandLooksLikeVerification(command: string) {
	return /\b(test|check|build|verify|lint|vitest|jest)\b|npm\s+(run\s+)?test/u.test(command);
}

function unique(values: string[]) {
	return [...new Set(values)];
}

function failedScopeResult(input: {
	request: CodexExecutionRequest;
	threadId: string;
	finalResponse: string;
	changedPaths: string[];
	proposedCommands: string[];
	verificationHints: string[];
	rawEventRefs: string[];
	wallMs: number;
	violatingPath: string;
}) {
	return {
		provider: 'codex',
		threadId: input.threadId,
		status: 'failed',
		finalResponse: input.finalResponse,
		summary: `${input.violatingPath} is outside the approved Codex mutation scope.`,
		changedPaths: input.changedPaths,
		proposedCommands: input.proposedCommands,
		verificationHints: input.verificationHints,
		rawEventRefs: input.rawEventRefs,
		error: {
			code: 'changed_path_scope_violation',
			message: `${input.violatingPath} is outside the approved Codex mutation scope.`,
			retryable: true,
		},
		usage: {
			subscriptionPlan: String(input.request.metadata?.subscriptionPlan ?? ''),
			wallMs: input.wallMs,
			wallMinutes: input.wallMs / 60_000,
			nativeUnit: 'wall_minute',
			filesChanged: input.changedPaths.length,
		},
		metadata: {
			allowedPaths: input.request.allowedPaths,
			forbiddenPaths: input.request.forbiddenPaths,
			violatingPath: input.violatingPath,
		},
	} satisfies CodexExecutionResult;
}

export function normalizeCodexRunResult(input: {
	request: CodexExecutionRequest;
	result: CodexRunResult;
	threadId: string;
	wallMs: number;
}): CodexExecutionResult {
	const items = input.result.items?.filter(isRecord) ?? [];
	const rawEventRefs = unique(items.map((item) => stringValue(item.id)).filter((id): id is string => Boolean(id)));
	const proposedCommands = unique(items.map(extractCommand).filter((command): command is string => Boolean(command)));
	const changedPaths = unique(items.flatMap(extractFileChangePaths).map(normalizePath));
	const verificationHints = unique(proposedCommands.filter(commandLooksLikeVerification));
	const finalResponse = input.result.finalResponse ?? '';
	const summary = finalResponse.split('\n').find((line) => line.trim())?.trim() || 'Codex SDK task completed.';

	if (input.request.sandboxMode === 'workspace_write') {
		const violatingPath = changedPaths.find((path) => !isChangedPathAllowed(
			path,
			input.request.allowedPaths,
			input.request.forbiddenPaths,
		));
		if (violatingPath) {
			return failedScopeResult({
				request: input.request,
				threadId: input.threadId,
				finalResponse,
				changedPaths,
				proposedCommands,
				verificationHints,
				rawEventRefs,
				wallMs: input.wallMs,
				violatingPath,
			});
		}
	}

	return {
		provider: 'codex',
		threadId: input.threadId,
		status: 'completed',
		finalResponse,
		summary,
		changedPaths,
		proposedCommands,
		verificationHints,
		rawEventRefs,
		usage: {
			subscriptionPlan: String(input.request.metadata?.subscriptionPlan ?? ''),
			estimatedCredits: undefined,
			wallMs: input.wallMs,
			wallMinutes: input.wallMs / 60_000,
			nativeUnit: 'wall_minute',
			inputTokens: input.result.usage?.input_tokens ?? null,
			outputTokens: input.result.usage?.output_tokens ?? null,
			cachedInputTokens: input.result.usage?.cached_input_tokens ?? null,
			filesChanged: changedPaths.length,
		},
		metadata: {
			usage: input.result.usage ?? null,
		},
	};
}

export async function runCodexSubscriptionTask(
	request: CodexExecutionRequest,
	options: RunCodexSubscriptionTaskOptions = {},
): Promise<CodexExecutionResult> {
	const startedAt = options.now?.() ?? Date.now();
	try {
		validateCodexExecutionRequest(request);
	} catch (error) {
		if (error instanceof CodexRequestSafetyError) {
			return safetyResult(request, error);
		}
		throw error;
	}

	try {
		const createCodexClient = options.createCodexClient ?? createDefaultCodexClient;
		const client = await createCodexClient();
		const threadOptions = mapCodexThreadOptions(request);
		const thread = request.threadId
			? client.resumeThread(request.threadId, threadOptions)
			: client.startThread(threadOptions);
		const prompt = buildCodexPrompt(request);
		const result = await thread.run(prompt);
		const wallMs = (options.now?.() ?? Date.now()) - startedAt;
		return normalizeCodexRunResult({
			request,
			result,
			threadId: thread.id ?? request.threadId ?? '',
			wallMs,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			provider: 'codex',
			threadId: request.threadId ?? '',
			status: 'failed',
			summary: `Codex SDK boundary could not be initialized: ${message}`,
			changedPaths: [],
			proposedCommands: [],
			verificationHints: [],
			error: {
				code: 'codex_sdk_initialization_failed',
				message,
				retryable: true,
			},
		};
	}
}

export interface CodexSubscriptionExecutionAdapterOptions {
	repoRoot?: string;
	createCodexClient?: () => CodexSubscriptionClient | Promise<CodexSubscriptionClient>;
	prepareWorktree?: (input: {
		agent: AgentRuntimeSpec;
		runId: string;
		repoRoot: string;
	}) => Promise<PreparedCodexWorktree>;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_CODEX_ALLOWED_PATHS = ['**'];
const DEFAULT_CODEX_FORBIDDEN_PATHS = ['.git/**', '.agent-worktrees/**', '.treeseed/secrets/**', 'node_modules/**'];

function sanitizeBranchPart(value: string) {
	return value.replace(/[^A-Za-z0-9._/-]+/gu, '-').replace(/^\/+|\/+$/gu, '') || 'agent';
}

async function prepareDefaultWorktree(input: {
	agent: AgentRuntimeSpec;
	runId: string;
	repoRoot: string;
}) {
	const branchPrefix = input.agent.execution.worktree?.branchPrefix
		?? input.agent.execution.branchPrefix
		?? 'agent';
	const featureBranch = [
		sanitizeBranchPart(branchPrefix),
		sanitizeBranchPart(input.agent.slug),
		sanitizeBranchPart(input.runId),
	].filter(Boolean).join('/');
	return new AgentWorktreeManager(input.repoRoot).createOrResumeWorktree(featureBranch, input.runId);
}

export class CodexSubscriptionExecutionAdapter implements AgentExecutionAdapter {
	constructor(private readonly options: CodexSubscriptionExecutionAdapterOptions = {}) {}

	async runTask(input: {
		agent: AgentRuntimeSpec;
		runId: string;
		prompt: string;
	}): Promise<AgentExecutionResult> {
		const config = resolveCodexProviderConfig(this.options.env ?? process.env);
		const repoRoot = this.options.repoRoot ?? process.cwd();
		const sandboxMode = (input.agent.execution.sandboxMode ?? config.sandboxMode) as CodexSandboxMode;
		const worktree = sandboxMode === 'workspace_write'
			? await (this.options.prepareWorktree ?? prepareDefaultWorktree)({
				agent: input.agent,
				runId: input.runId,
				repoRoot,
			})
			: undefined;
		const result = await runCodexSubscriptionTask({
			taskId: input.runId,
			agentSlug: input.agent.slug,
			repoRoot,
			worktreeRoot: worktree?.worktreeRoot,
			prompt: input.prompt,
			allowedPaths: input.agent.execution.allowedPaths?.length
				? input.agent.execution.allowedPaths
				: DEFAULT_CODEX_ALLOWED_PATHS,
			forbiddenPaths: input.agent.execution.forbiddenPaths?.length
				? input.agent.execution.forbiddenPaths
				: DEFAULT_CODEX_FORBIDDEN_PATHS,
			sandboxMode,
			approvalPolicy: (input.agent.execution.approvalPolicy ?? config.approvalPolicy) as CodexApprovalPolicy,
			model: input.agent.execution.model ?? config.defaultModel,
			reasoningEffort: input.agent.execution.reasoningEffort as CodexReasoningEffort | undefined,
			timeoutMs: config.timeoutMs,
			metadata: {
				subscriptionPlan: config.subscriptionPlan,
				worktreeBranch: worktree?.branchName,
			},
		}, {
			createCodexClient: this.options.createCodexClient,
		});
		return {
			status: result.status,
			summary: result.summary ?? 'Codex subscription provider returned no summary.',
			stdout: result.finalResponse ?? '',
			stderr: result.error?.message ?? '',
			metadata: {
				codex: result,
			},
		};
	}
}
