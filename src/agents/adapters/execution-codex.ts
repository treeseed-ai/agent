import { Codex } from '@openai/codex-sdk';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	ExecutionProviderAdapter,
	ExecutionProviderInvocation,
	ExecutionProviderToolDescriptor,
	TreeDxProxyExecutionToolDescriptor,
} from '../runtime-types.ts';
import { TREE_DX_PROXY_TOOL_NAMES } from '../tools/treedx-proxy-tool.ts';
import { createTreeDxProxyMcpServerCommand } from '../tools/treedx-proxy-mcp-server.ts';
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
export type { CodexSandboxMode } from './codex-readiness.ts';

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
	tools?: ExecutionProviderToolDescriptor[];
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
	createCodexClient?: (request?: CodexExecutionRequest) => CodexSubscriptionClient | Promise<CodexSubscriptionClient>;
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

class CodexExecutionTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Codex execution exceeded the configured timeout of ${timeoutMs}ms.`);
		this.name = 'CodexExecutionTimeoutError';
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new CodexExecutionTimeoutError(timeoutMs)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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

function treeDxProxyTools(request: CodexExecutionRequest) {
	return (request.tools ?? []).filter((tool): tool is TreeDxProxyExecutionToolDescriptor => tool.kind === 'treedx_proxy');
}

function redactToolForPrompt(tool: TreeDxProxyExecutionToolDescriptor) {
	return {
		kind: tool.kind,
		id: tool.id,
		name: tool.name,
		description: tool.description,
		operations: tool.operations,
		projectId: tool.projectId,
		assignmentId: tool.assignmentId,
		handleId: tool.handleId,
		repositoryId: tool.repositoryId ?? null,
		workspaceId: tool.workspaceId ?? null,
		allowedOperations: tool.allowedOperations,
		allowedPaths: tool.allowedPaths,
		allowedReadPaths: tool.allowedReadPaths ?? [],
		allowedWritePaths: tool.allowedWritePaths ?? [],
		routes: tool.routes,
		toolNames: TREE_DX_PROXY_TOOL_NAMES,
	};
}

export function codexTreeDxConfig(request: CodexExecutionRequest) {
	const projectRoot = request.sandboxMode === 'workspace_write'
		? request.worktreeRoot ?? request.repoRoot
		: request.repoRoot;
	const baseConfig = {
		projects: {
			[projectRoot]: {
				trust_level: 'trusted',
			},
		},
	} as Record<string, unknown>;
	const tools = treeDxProxyTools(request);
	if (tools.length === 0) return baseConfig;
	const mcpServers: Record<string, unknown> = {};
	for (const [index, tool] of tools.entries()) {
		const server = createTreeDxProxyMcpServerCommand({
			apiBaseUrl: process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_MARKET_URL ?? process.env.TREESEED_CAPACITY_ACCEPTANCE_API_URL ?? '',
			providerApiKey: process.env.TREESEED_CAPACITY_PROVIDER_API_KEY ?? process.env.TREESEED_PROVIDER_API_KEY ?? '',
			assignmentId: tool.assignmentId,
			handleId: tool.handleId,
			descriptor: tool,
		});
		mcpServers[index === 0 ? 'treedx_proxy' : `treedx_proxy_${index + 1}`] = {
			command: server.command,
			args: server.args,
			env: server.env,
		};
	}
	return {
		...baseConfig,
		mcp_servers: mcpServers,
	};
}

async function createDefaultCodexClient(request?: CodexExecutionRequest): Promise<CodexSubscriptionClient> {
	return new Codex({
		env: codexClientEnvironment(),
		config: request ? codexTreeDxConfig(request) : undefined,
	} as ConstructorParameters<typeof Codex>[0]);
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
	const treeDxTools = treeDxProxyTools(request);
	const treeDxSection = treeDxTools.length > 0
		? [
			'TreeDX assignment tools:',
			'Use the assignment-scoped TreeDX MCP tools for project content reads, queries, writes, and commits.',
			'Do not request raw TreeDX URLs, bearer tokens, GitHub tokens, deploy keys, provider API keys, or direct repository credentials.',
			'Local shell reads are reserved for repository files in the assigned workspace; Knowledge Hub model instances must be accessed through TreeDX tools.',
			'If required context is missing, call the available tools before reporting that work is blocked.',
			formatMetadataBlock(treeDxTools.map(redactToolForPrompt)),
		].join('\n')
		: 'TreeDX assignment tools:\nNo assignment-scoped TreeDX tools were provided; use only repository/work package context and report blocked work with the exact missing tool or permission.';
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
			'- If the task requires broader scope or a missing tool, stop with a clear blocked summary that names the missing permission or tool.',
		'',
		treeDxSection,
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
	const prompt = buildCodexPrompt(input.request);
	const threadOptions = mapCodexThreadOptions(input.request);
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
			rawItems: items,
			request: {
				model: input.request.model ?? null,
				reasoningEffort: input.request.reasoningEffort ?? null,
				sandboxMode: input.request.sandboxMode,
				approvalPolicy: input.request.approvalPolicy,
				timeoutMs: input.request.timeoutMs ?? null,
				threadOptions,
				allowedPaths: input.request.allowedPaths,
				forbiddenPaths: input.request.forbiddenPaths,
				toolCount: input.request.tools?.length ?? 0,
				tools: input.request.tools ?? [],
				promptCharacters: prompt.length,
				prompt,
			},
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
		const client = await createCodexClient(request);
		const threadOptions = mapCodexThreadOptions(request);
		const thread = request.threadId
			? client.resumeThread(request.threadId, threadOptions)
			: client.startThread(threadOptions);
		const prompt = buildCodexPrompt(request);
		const runPromise = thread.run(prompt);
		runPromise.catch(() => null);
		const result = await withTimeout(runPromise, request.timeoutMs ?? 900_000);
		const wallMs = (options.now?.() ?? Date.now()) - startedAt;
		return normalizeCodexRunResult({
			request,
			result,
			threadId: thread.id ?? request.threadId ?? '',
			wallMs,
		});
	} catch (error) {
		if (error instanceof CodexExecutionTimeoutError) {
			const wallMs = (options.now?.() ?? Date.now()) - startedAt;
			const prompt = buildCodexPrompt(request);
			return {
				provider: 'codex',
				threadId: request.threadId ?? '',
				status: 'failed',
				summary: error.message,
				changedPaths: [],
				proposedCommands: [],
				verificationHints: [],
				error: {
					code: 'codex_execution_timeout',
					message: error.message,
					retryable: true,
				},
				usage: {
					subscriptionPlan: String(request.metadata?.subscriptionPlan ?? ''),
					wallMs,
					wallMinutes: wallMs / 60_000,
					nativeUnit: 'wall_minute',
					inputTokens: null,
					outputTokens: null,
					cachedInputTokens: null,
					filesChanged: 0,
				},
				metadata: {
					timeoutMs: error.timeoutMs,
					request: {
						model: request.model ?? null,
						reasoningEffort: request.reasoningEffort ?? null,
						sandboxMode: request.sandboxMode,
						approvalPolicy: request.approvalPolicy,
						timeoutMs: request.timeoutMs ?? null,
						threadOptions: mapCodexThreadOptions(request),
						allowedPaths: request.allowedPaths,
						forbiddenPaths: request.forbiddenPaths,
						toolCount: request.tools?.length ?? 0,
						tools: request.tools ?? [],
						promptCharacters: prompt.length,
						prompt,
					},
				},
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		const prompt = buildCodexPrompt(request);
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
			metadata: {
				request: {
					model: request.model ?? null,
					reasoningEffort: request.reasoningEffort ?? null,
					sandboxMode: request.sandboxMode,
					approvalPolicy: request.approvalPolicy,
					timeoutMs: request.timeoutMs ?? null,
					threadOptions: mapCodexThreadOptions(request),
					allowedPaths: request.allowedPaths,
					forbiddenPaths: request.forbiddenPaths,
					toolCount: request.tools?.length ?? 0,
					tools: request.tools ?? [],
					promptCharacters: prompt.length,
					prompt,
				},
			},
		};
	}
}

export interface CodexSubscriptionExecutionProviderAdapterOptions {
	repoRoot?: string;
	createCodexClient?: (request?: CodexExecutionRequest) => CodexSubscriptionClient | Promise<CodexSubscriptionClient>;
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

export class CodexSubscriptionExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: CodexSubscriptionExecutionProviderAdapterOptions = {}) {}

	async describe() {
		return {
			id: 'codex',
			kind: 'ai_model' as const,
			capabilities: [
				'planning',
				'implementation',
				'review',
				'repo_read',
				'repo_write',
				'verification',
			],
			capabilityAliases: ['codex_subscription'],
			nativeUnit: 'token_or_wall_minute',
			quotaVisibility: 'partial' as const,
			maxConcurrentAssignments: 1,
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: true,
			supportsArtifacts: true,
		};
	}

	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'normal' as const,
			activeAssignmentCount: 0,
		};
	}

	async start(input: ExecutionProviderInvocation) {
		const config = resolveCodexProviderConfig(this.options.env ?? process.env);
		const repoRoot = this.options.repoRoot ?? process.cwd();
		const runId = typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id;
		const sandboxMode = (input.agent.execution.sandboxMode ?? config.sandboxMode) as CodexSandboxMode;
		const worktree = sandboxMode === 'workspace_write'
			? await (this.options.prepareWorktree ?? prepareDefaultWorktree)({
				agent: input.agent,
				runId,
				repoRoot,
			})
			: undefined;
		const result = await runCodexSubscriptionTask({
			taskId: runId,
			agentSlug: input.agent.slug,
			repoRoot,
			worktreeRoot: worktree?.worktreeRoot,
			prompt: input.workPackage.instructions,
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
			tools: input.tools,
			metadata: {
				subscriptionPlan: config.subscriptionPlan,
				worktreeBranch: worktree?.branchName,
				workPackage: input.workPackage,
				assignment: {
					id: input.assignment.id,
					projectId: input.assignment.projectId,
					workDayId: input.assignment.workDayId,
					mode: input.capacityEnvelope.mode,
				},
			},
		}, {
			createCodexClient: this.options.createCodexClient,
		});
		return {
			status: result.status,
			summary: result.summary ?? 'Codex subscription provider returned no summary.',
			runId,
			outputs: {
				finalResponse: result.finalResponse ?? '',
				stdout: result.finalResponse ?? '',
				stderr: result.error?.message ?? '',
			},
			usage: result.usage
				? [{
					kind: 'codex_subscription',
					unit: result.usage.nativeUnit ?? 'wall_minute',
					amount: Number(result.usage.wallMinutes ?? 0),
					source: 'codex',
					partial: result.status !== 'completed',
					metadata: result.usage,
				}]
				: [],
			artifacts: [
				...(result.finalResponse ? [{
					kind: 'assistant_final_response',
					name: `${runId}-final-response.md`,
					mediaType: 'text/markdown',
					metadata: {
						threadId: result.threadId,
						characters: result.finalResponse.length,
					},
				}] : []),
				...result.changedPaths.map((path) => ({
					kind: 'changed_path',
					name: path,
					uri: `repo://${path}`,
					metadata: {
						threadId: result.threadId,
						provider: 'codex',
					},
				})),
			],
			retryable: result.error?.retryable,
			code: result.error?.code ?? null,
			metadata: {
				provider: 'codex',
				codex: result,
			},
		};
	}

	async collectUsage(input) {
		const usage = input.metadata?.codexUsage;
		return usage && typeof usage === 'object'
			? [{
				kind: 'codex_subscription',
				unit: String((usage as Record<string, unknown>).nativeUnit ?? 'wall_minute'),
				amount: Number((usage as Record<string, unknown>).wallMinutes ?? 0),
				source: 'codex',
				partial: true,
				metadata: usage as Record<string, unknown>,
			}]
			: [{
				kind: 'codex_subscription',
				unit: 'assignment',
				amount: 1,
				source: 'codex',
				partial: true,
				metadata: {
					supported: false,
					reason: 'codex_usage_available_on_start_snapshot',
					assignmentId: input.assignmentId,
				},
			}];
	}

	async collectArtifacts(input) {
		return [{
			kind: 'execution_trace',
			name: `${input.runId}.codex-trace`,
			metadata: {
				supported: true,
				assignmentId: input.assignmentId,
				runId: input.runId,
				externalRef: input.externalRef ?? null,
			},
		}];
	}
}
