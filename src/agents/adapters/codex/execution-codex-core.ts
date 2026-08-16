import { isAbsolute, relative } from 'node:path';
import { findAgentToolDefinition } from '@treeseed/sdk';
import type { ExecutionProviderToolDescriptor } from '../../runtime/runtime-types.ts';
import { createAgentToolMcpServerCommand } from '../../tools/agent-tool-mcp-server.ts';
import { agentToolMcpName } from '../../tools/agent-tool-mcp-server.ts';
import {
	type CodexApprovalPolicy,
	type CodexSandboxMode,
	resolveCodexProviderConfig,
} from './codex-readiness.ts';
import { codexClientEnvironment } from '../accounts/codex-auth.ts';
import { createIsolatedCodexRuntimeHome } from '../runtime/codex-runtime-home.ts';
import type { ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';
import { codexDeadlineContract } from './execution-codex-deadline.ts';
export { hasCompletedToolEvent, readToolTelemetry, treeDxContentReceipts } from './execution-codex-receipts.ts';

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
	leaseToken?: string | null;
	toolTelemetryPath?: string | null;
	toolConfigPath?: string | null;
	providerAccessToken?: string;
	apiBaseUrl?: string;
	researchSourcePolicy?: ResearchSourcePolicy;
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
		estimatedSeconds?: number;
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

export interface CodexClient {
	startThread(options?: CodexThreadOptions): CodexThread;
	resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
	cleanup?(): Promise<void>;
}

export interface CodexThread {
	id?: string | null;
	run(input: string, options?: Record<string, unknown>): Promise<CodexRunResult>;
	runStreamed?(input: string, options?: Record<string, unknown>): Promise<{ events: AsyncIterable<Record<string, unknown>> }>;
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

export interface RunCodexTaskOptions {
	signal?: AbortSignal;
	createCodexClient?: (request?: CodexExecutionRequest) => CodexClient | Promise<CodexClient>;
	client?: CodexClient | Promise<CodexClient>;
	now?: () => number;
	onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
}

export interface PreparedCodexWorktree {
	branchName: string;
	worktreeRoot: string;
	exactBaseRef?: string;
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

export function normalizeChangedPath(value: string, root: string) {
	if (!isAbsolute(value)) return normalizePath(value);
	const relativePath = relative(root, value);
	if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return normalizePath(value);
	return normalizePath(relativePath);
}

export class CodexExecutionTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Codex execution exceeded the configured timeout of ${timeoutMs}ms.`);
		this.name = 'CodexExecutionTimeoutError';
	}
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout?.();
			reject(new CodexExecutionTimeoutError(timeoutMs));
		}, timeoutMs);
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

export function isChangedPathAllowed(path: string, allowedPaths: string[], forbiddenPaths: string[]) {
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

export function safetyResult(request: CodexExecutionRequest, error: CodexRequestSafetyError): CodexExecutionResult {
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

function agentTools(request: CodexExecutionRequest) {
	return (request.tools ?? []).filter((tool) => tool.kind === 'agent_tool');
}

export function codexAgentToolServer(request: CodexExecutionRequest) {
	const tools = agentTools(request);
	if (tools.length === 0) return null;
	const assignmentId = String(request.metadata?.assignment && typeof request.metadata.assignment === 'object'
		? (request.metadata.assignment as Record<string, unknown>).id ?? ''
		: '');
	return createAgentToolMcpServerCommand({
		apiBaseUrl: request.apiBaseUrl ?? '',
		providerAccessToken: request.providerAccessToken ?? '',
		assignmentId,
		leaseToken: request.leaseToken ?? null,
		repoRoot: request.repoRoot,
		telemetryPath: request.toolTelemetryPath ?? null,
		descriptors: tools,
		researchSourcePolicy: request.researchSourcePolicy,
	});
}

export function codexAgentToolEnvironment(request: CodexExecutionRequest) {
	const server = codexAgentToolServer(request);
	if (!server) return {};
	return request.toolConfigPath
		? { TREESEED_AGENT_TOOL_CONFIG_PATH: request.toolConfigPath }
		: server.env;
}

function redactToolForPrompt(tool: ExecutionProviderToolDescriptor) {
	const metadata = tool.metadata && typeof tool.metadata === 'object' && !Array.isArray(tool.metadata)
		? tool.metadata as Record<string, unknown>
		: {};
	return {
		kind: tool.kind,
		id: tool.id,
		name: tool.name,
		description: tool.description,
		callName: agentToolMcpName(tool.id),
		executionTarget: tool.executionTarget,
		mutability: tool.mutability,
		contentAction: metadata.contentAction ?? undefined,
		contentModel: metadata.contentModel ?? undefined,
		contentPreset: metadata.contentPreset ?? undefined,
		permissionSummary: metadata.permissionSummary ?? undefined,
		inputSchema: tool.inputSchema,
	};
}

export function codexAgentToolConfig(request: CodexExecutionRequest) {
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
	const configuredServiceTier = process.env.TREESEED_CODEX_SERVICE_TIER?.trim();
	if (configuredServiceTier === 'fast') baseConfig.service_tier = 'fast';
	const server = codexAgentToolServer(request);
	if (!server) return baseConfig;
	return {
		...baseConfig,
		features: {
			builtin_mcp: true,
		},
		mcp_servers: {
			treeseed_tools: {
				command: server.command,
				args: server.args,
				env: codexAgentToolEnvironment(request),
				required: true,
				startup_timeout_sec: 90,
				default_tools_approval_mode: 'approve',
			},
		},
	};
}

export async function createDefaultCodexClient(request?: CodexExecutionRequest, env: NodeJS.ProcessEnv = process.env): Promise<CodexClient> {
	const { Codex } = await import('@openai/codex-sdk');
	const runtimeHome = await createIsolatedCodexRuntimeHome({
		serviceTier: env.TREESEED_CODEX_SERVICE_TIER?.trim() === 'fast' ? 'fast' : undefined,
		model: request?.model,
		env,
	});
	const client = new Codex({
		env: codexClientEnvironment({
			...env,
			TREESEED_CODEX_AUTH_FILE: runtimeHome.authFile,
			CODEX_HOME: runtimeHome.codexHome,
		}),
		config: request ? codexAgentToolConfig(request) : undefined,
	} as ConstructorParameters<typeof Codex>[0]);
	let cleaned = false;
	return {
		startThread(options) {
			return client.startThread(options);
		},
		resumeThread(id, options) {
			return client.resumeThread(id, options);
		},
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			await runtimeHome.cleanup();
		},
	};
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
	// A resumed Codex thread already contains the immutable assignment boundary,
	// tool catalog, and work package. Repeating them consumes the context window
	// and can make a bounded completion-correction turn larger than the original.
	if (request.threadId) return request.prompt.trim();
	const permissionStage = request.sandboxMode === 'workspace_write'
		? 'approved_worktree_mutation'
		: 'read_only_or_planning';
	const contextPackSummary = request.metadata?.contextPackSummary ?? request.metadata?.contextSummary;
	const rawWorkPackage = request.metadata?.workPackage ?? request.metadata?.workPackageYaml;
	const workPackage = rawWorkPackage && typeof rawWorkPackage === 'object' && !Array.isArray(rawWorkPackage)
		? Object.fromEntries(Object.entries(rawWorkPackage as Record<string, unknown>)
			.filter(([key]) => key !== 'instructions' && key !== 'context'))
		: rawWorkPackage;
	const operationBoundary = request.sandboxMode === 'workspace_write'
		? [
			'- Use only the tools listed in the available TreeSeed tool catalog.',
			'- Do not stage shared branches unless an explicit stage tool is present.',
			'- Do not close the task directly unless an explicit close tool is present.',
			'- Do not release unless an explicit release tool is present.',
		].join('\n')
	: '- Treat this as read-only/planning unless the handler grants a later mutation stage.';
	const tools = agentTools(request);
	const toolIds = new Set(tools.map((tool) => tool.id));
	const deadlineContract = codexDeadlineContract(request.metadata?.executionTiming, toolIds.has('treeseed.status'));
	const artifactKind = typeof request.metadata?.workPackage === 'object'
		&& request.metadata.workPackage
		&& typeof (request.metadata.workPackage as { metadata?: { artifactKind?: unknown } }).metadata?.artifactKind === 'string'
		? (request.metadata.workPackage as { metadata: { artifactKind: string } }).metadata.artifactKind
		: null;
	const sourceCheckpointRequired = artifactKind === 'failing_test_proof'
		|| artifactKind === 'implementation_change'
		|| artifactKind === 'implementation_revision';
	const completionGates = [
		...(toolIds.has('treeseed.verify') ? [
			'- Verification gate: call treeseed.verify with the exact bounded node/npm argv and wait for a successful verification_completed receipt. For a test-first red proof, set expectedExitCode to the behaviorally correct failing exit code.',
		] : []),
		...(toolIds.has('treeseed.checkpoint') ? [
			sourceCheckpointRequired
				? `- Source checkpoint gate: the ${artifactKind} deliverable requires treeseed.checkpoint after verification and a successful source_checkpoint_committed receipt containing commitSha.`
				: '- Source checkpoint gate: if you create or change any repository file, call treeseed.checkpoint after verification and wait for a successful source_checkpoint_committed receipt containing commitSha.',
			'- A final response is not completion while changed repository files lack a successful checkpoint receipt. If checkpoint fails, correct the scoped cause and retry it; otherwise report the exact tool failure as blocked.',
		] : []),
		...(toolIds.has('treeseed.review_decision') ? [
			'- Review disposition gate: after evaluating the governed evidence, call treeseed.review_decision with exactly approved or rejected and wait for a successful review_decision_recorded receipt before final response.',
		] : []),
		...(request.metadata?.workPackage
			&& typeof (request.metadata.workPackage as { metadata?: { researchStage?: unknown } }).metadata?.researchStage === 'string'
			&& (request.metadata.workPackage as { metadata: { researchStage: string } }).metadata.researchStage === 'independent-source-fetch'
			&& toolIds.has('research.fetch_source') ? [
				`- Research fetch gate: call the available TreeSeed tool with callName ${agentToolMcpName('research.fetch_source')} (policy id research.fetch_source) for at least two independent allowed publishers and wait for a successful research_citation_fetched receipt from each before final response. Search for and invoke the callName, not the dotted policy id.`,
			] : []),
	];
	const toolSection = tools.length > 0
		? [
			'Available TreeSeed tools:',
			'Use only these assignment-scoped tools when tool use is needed.',
			'Do not request raw TreeDX URLs, bearer tokens, GitHub tokens, deploy keys, provider API keys, or direct repository credentials.',
			'Do not use shell as a substitute for missing TreeSeed tools.',
			'Local shell reads are reserved for repository files in the assigned workspace; Knowledge Hub model instances must be accessed through TreeDX tools.',
			'Never inspect src/content or docs/src/content with shell commands; those paths are Knowledge Hub content and TreeDX is their only access authority.',
			'When a model-aware TreeSeed content tool is available, use it instead of hand-writing Knowledge Hub frontmatter or markdown files.',
			'Do not infer or guess Knowledge Hub file paths. Discover records through TreeSeed content queries or TreeDX graph/search tools, then reuse only exact paths returned by those tools.',
			'Batch file reads fail when any requested path is absent; include only paths already verified by a query, graph, search, or content receipt.',
			'For hierarchically placed content, pass the exact repository-relative path from the content receipt when reading, updating, linking, or validating that record.',
			'Content tools return staged TreeDX workspace changes unless a commit-capable content tool is explicitly listed.',
			'If a needed tool is absent or returns a structured scope error, adapt the work or report the missing capability in the final response.',
			formatMetadataBlock(tools.map(redactToolForPrompt)),
		].join('\n')
		: 'Available TreeSeed tools:\nNo assignment-scoped tools were provided; use only repository/work package context and report blocked work with the exact missing capability.';
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
		...deadlineContract,
		'- Do not modify files outside allowed paths.',
		'- Do not write outside the assigned git worktree.',
		operationBoundary,
		'- Do not approve decisions.',
			'- Prefer small, reviewable changes.',
			'- Run or suggest verification that is relevant to the change.',
			'- Report uncertainty.',
			'- Record commands you ran or believe should be run.',
			'- If the task requires broader scope or a missing tool, stop with a clear blocked summary that names the missing permission or tool.',
			...completionGates,
		'',
		toolSection,
		'',
		'Context pack:',
		formatMetadataBlock(contextPackSummary),
		'',
		'Work package:',
		formatMetadataBlock(workPackage),
	].join('\n');
	return taskPrompt;
}
