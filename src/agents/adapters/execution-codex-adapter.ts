import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAgentToolDefinition } from '@treeseed/sdk';
import type { AgentRuntimeSpec, ExecutionRunRef } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation, ExecutionProviderToolDescriptor } from '../runtime-types.ts';
import { AgentWorktreeManager } from '../../services/agent-worktrees.ts';
import { type CodexApprovalPolicy, type CodexSandboxMode, resolveCodexProviderConfig } from './codex-readiness.ts';
import {
	CodexRequestSafetyError,
	codexAgentToolServer,
	readToolTelemetry,
	treeDxContentReceipts,
	type CodexExecutionRequest,
	type CodexReasoningEffort,
	type CodexSubscriptionClient,
	type PreparedCodexWorktree,
} from './execution-codex-core.ts';
import { runCodexSubscriptionTask } from './execution-codex-result.ts';
import type { ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';

export interface CodexSubscriptionExecutionProviderAdapterOptions {
	repoRoot?: string;
	createCodexClient?: (request?: CodexExecutionRequest) => CodexSubscriptionClient | Promise<CodexSubscriptionClient>;
	prepareWorktree?: (input: {
		agent: AgentRuntimeSpec;
		runId: string;
		repoRoot: string;
		exactBaseRef?: string;
	}) => Promise<PreparedCodexWorktree>;
	env?: NodeJS.ProcessEnv;
	researchSourcePolicy?: ResearchSourcePolicy;
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
	exactBaseRef?: string;
}) {
	const branchPrefix = input.agent.execution.worktree?.branchPrefix
		?? input.agent.execution.branchPrefix
		?? 'agent';
	const featureBranch = [
		sanitizeBranchPart(branchPrefix),
		sanitizeBranchPart(input.agent.slug),
		sanitizeBranchPart(input.runId),
	].filter(Boolean).join('/');
	return new AgentWorktreeManager(input.repoRoot).createOrResumeWorktree(featureBranch, input.runId, input.exactBaseRef ?? 'HEAD');
}

function toolsWithWorktree(
	tools: ExecutionProviderToolDescriptor[] | undefined,
	worktreeRoot: string | undefined,
) {
	return (tools ?? [])
		.map((tool) => ({
			...tool,
			metadata: {
				...(tool.metadata ?? {}),
				worktreeRoot: worktreeRoot ?? (tool.metadata?.worktreeRoot ?? null),
			},
		}))
		.filter((tool) => {
			const definition = findAgentToolDefinition(tool.id);
			if (!definition?.requirements.includes('assignment_worktree')) return true;
			return typeof tool.metadata?.worktreeRoot === 'string' && tool.metadata.worktreeRoot.trim().length > 0;
		});
}

export class CodexSubscriptionExecutionProviderAdapter implements ExecutionProviderAdapter {
	private readonly assignmentWorktrees = new Map<string, string>();
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
		const exactBaseRef = typeof input.metadata?.exactBaseRef === 'string' && input.metadata.exactBaseRef.trim()
			? input.metadata.exactBaseRef.trim()
			: undefined;
		const worktree = sandboxMode === 'workspace_write'
			? await (this.options.prepareWorktree ?? prepareDefaultWorktree)({
				agent: input.agent,
				runId,
				repoRoot,
				exactBaseRef,
			})
			: undefined;
		if (worktree) this.assignmentWorktrees.set(input.assignment.id, worktree.worktreeRoot);
		if (exactBaseRef && !worktree?.exactBaseRef?.toLowerCase().startsWith(exactBaseRef.toLowerCase())) {
			throw new CodexRequestSafetyError(
				'worktree_base_ref_mismatch',
				'Prepared assignment worktree does not prove the governed exact base ref.',
				false,
			);
		}
		const tools = toolsWithWorktree(input.tools, worktree?.worktreeRoot);
		const configuredTelemetryPath = typeof input.metadata?.toolTelemetryPath === 'string' ? input.metadata.toolTelemetryPath : null;
		const telemetryDirectory = tools.length && !configuredTelemetryPath ? await mkdtemp(join(tmpdir(), 'treeseed-agent-tools-')) : null;
		const toolTelemetryPath = configuredTelemetryPath ?? (telemetryDirectory ? join(telemetryDirectory, 'events.jsonl') : null);
		const toolConfigPath = telemetryDirectory ? join(telemetryDirectory, 'mcp-env.json') : null;
		let result: Awaited<ReturnType<typeof runCodexSubscriptionTask>>;
		let toolTelemetry: Record<string, unknown>[] = [];
		try {
			const request: CodexExecutionRequest = {
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
			tools,
			leaseToken: input.leaseToken,
			toolTelemetryPath,
			toolConfigPath,
			providerAccessToken: this.options.env?.TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN ?? '',
			apiBaseUrl: this.options.env?.TREESEED_API_BASE_URL ?? '',
			researchSourcePolicy: this.options.researchSourcePolicy,
			metadata: {
				subscriptionPlan: config.subscriptionPlan,
				worktreeBranch: worktree?.branchName,
				exactBaseRef: worktree?.exactBaseRef ?? exactBaseRef ?? null,
				workPackage: input.workPackage,
				assignment: {
					id: input.assignment.id,
					projectId: input.assignment.projectId,
					workDayId: input.assignment.workDayId,
					mode: input.capacityEnvelope.mode,
				},
			},
			};
			if (toolConfigPath) {
				await writeFile(toolConfigPath, JSON.stringify(codexAgentToolServer({ ...request, toolConfigPath: null })?.env ?? {}), { encoding: 'utf8', mode: 0o600 });
			}
			result = await runCodexSubscriptionTask(request, {
				createCodexClient: this.options.createCodexClient,
			});
		} finally {
			toolTelemetry = await readToolTelemetry(toolTelemetryPath);
			if (telemetryDirectory) await rm(telemetryDirectory, { recursive: true, force: true });
		}
		const contentReceipts = treeDxContentReceipts(toolTelemetry);
		return {
			status: result.status,
			summary: result.summary ?? 'Codex subscription provider returned no summary.',
			runId,
			outputs: {
				finalResponse: result.finalResponse ?? '',
				stdout: result.finalResponse ?? '',
				stderr: result.error?.message ?? '',
				toolTelemetry,
				contentReceipts,
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
				...contentReceipts,
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
				worktreeRoot: worktree?.worktreeRoot ?? null,
				worktreeBranch: worktree?.branchName ?? null,
				baseRef: worktree?.exactBaseRef ?? exactBaseRef ?? null,
				codex: result,
			},
		};
	}

	async collectUsage(input: ExecutionRunRef) {
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

	async collectArtifacts(input: ExecutionRunRef) {
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

	async releaseAssignmentResources(input: { assignmentId: string; outcome: 'completed' | 'returned' | 'failed' | 'expired' }) {
		const worktreeRoot = this.assignmentWorktrees.get(input.assignmentId);
		if (!worktreeRoot || input.outcome !== 'completed') return;
		await new AgentWorktreeManager(this.options.repoRoot ?? process.cwd()).releaseWorktree(worktreeRoot);
		this.assignmentWorktrees.delete(input.assignmentId);
	}
}
