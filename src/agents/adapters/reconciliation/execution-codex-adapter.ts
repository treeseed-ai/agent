import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAgentToolDefinition } from '@treeseed/sdk';
import type { AgentRuntimeSpec, ExecutionRunRef, ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation, ExecutionProviderToolDescriptor } from '../../runtime/runtime-types.ts';
import { AgentWorktreeManager } from '../../../services/agent-worktrees.ts';
import { checkCodexProviderReadiness, type CodexApprovalPolicy, type CodexSandboxMode, resolveCodexProviderConfig } from '../codex/codex-readiness.ts';
import {
	CodexRequestSafetyError,
	codexAgentToolServer,
	createDefaultCodexClient,
	readToolTelemetry,
	treeDxContentReceipts,
	type CodexExecutionRequest,
	type CodexExecutionResult,
	type CodexReasoningEffort,
	type CodexClient,
	type PreparedCodexWorktree,
} from '../codex/execution-codex-core.ts';
import { runCodexTask } from '../codex/execution-codex-result.ts';
import type { ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';
import { assignmentDeadlineExpired, assignmentExecutionTiming, capacityExecutionTiming, codexExecutionTimeoutMs, completionCorrectionBoundaryInstruction, deadlineBoundExecutionTimeoutMs, executionCompletionDeadlineMs } from './execution-timeout.ts';
import { missingCodexCompletionReceipts } from './execution-completion-receipts.ts';

export { assignmentDeadlineExpired, codexExecutionTimeoutMs, deadlineBoundExecutionTimeoutMs } from './execution-timeout.ts';
export { missingCodexCompletionReceipts } from './execution-completion-receipts.ts';

export interface CodexExecutionProviderAdapterOptions {
	repoRoot?: string;
	createCodexClient?: (request?: CodexExecutionRequest) => CodexClient | Promise<CodexClient>;
	prepareWorktree?: (input: {
		agent: AgentRuntimeSpec;
		runId: string;
		repoRoot: string;
		exactBaseRef?: string;
	}) => Promise<PreparedCodexWorktree>;
	env?: NodeJS.ProcessEnv;
	researchSourcePolicy?: ResearchSourcePolicy;
	onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
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
	completion: { artifactKind: string | null; requireContentArtifact: boolean },
) {
	return (tools ?? [])
		.map((tool) => ({
			...tool,
			metadata: {
				...(tool.metadata ?? {}),
				worktreeRoot: worktreeRoot ?? (tool.metadata?.worktreeRoot ?? null),
				requiredArtifactKind: completion.artifactKind,
				requireContentArtifact: completion.requireContentArtifact,
			},
		}))
		.filter((tool) => {
			const definition = findAgentToolDefinition(tool.id);
			if (!definition?.requirements.includes('assignment_worktree')) return true;
			return typeof tool.metadata?.worktreeRoot === 'string' && tool.metadata.worktreeRoot.trim().length > 0;
		});
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function hasRequiredResponseSuspensionReceipt(telemetry: Record<string, unknown>[]) {
	return telemetry.some((entry) => entry.status === 'completed' && entry.toolId === 'treeseed.discussion.respond'
		&& record(entry.inputSummary).requiredResponse === true && record(entry.outputSummary).suspended === true);
}

function mergeCodexResults(initial: CodexExecutionResult, correction: CodexExecutionResult): CodexExecutionResult {
	const sum = (left: number | null | undefined, right: number | null | undefined) => {
		if (left === null && right === null) return null;
		return Number(left ?? 0) + Number(right ?? 0);
	};
	const usage = initial.usage || correction.usage ? {
		...initial.usage,
		...correction.usage,
		wallMs: sum(initial.usage?.wallMs, correction.usage?.wallMs) ?? undefined,
		wallMinutes: sum(initial.usage?.wallMinutes, correction.usage?.wallMinutes) ?? undefined,
		inputTokens: sum(initial.usage?.inputTokens, correction.usage?.inputTokens),
		outputTokens: sum(initial.usage?.outputTokens, correction.usage?.outputTokens),
		cachedInputTokens: sum(initial.usage?.cachedInputTokens, correction.usage?.cachedInputTokens),
		filesChanged: new Set([...initial.changedPaths, ...correction.changedPaths]).size,
	} : undefined;
	return {
		...correction,
		changedPaths: [...new Set([...initial.changedPaths, ...correction.changedPaths])],
		proposedCommands: [...new Set([...initial.proposedCommands, ...correction.proposedCommands])],
		verificationHints: [...new Set([...initial.verificationHints, ...correction.verificationHints])],
		rawEventRefs: [...new Set([...(initial.rawEventRefs ?? []), ...(correction.rawEventRefs ?? [])])],
		usage,
		metadata: {
			...correction.metadata,
			completionCorrection: {
				attempted: true,
				initialStatus: initial.status,
				initialThreadId: initial.threadId,
			},
		},
	};
}

function missingReceiptResult(
	result: CodexExecutionResult,
	missingReceipts: string[],
	correctionAttempted: boolean,
): CodexExecutionResult {
	const message = `Codex completion is missing required assignment tool receipt${missingReceipts.length === 1 ? '' : 's'}: ${missingReceipts.join(', ')}.`;
	return {
		...result,
		status: 'failed',
		summary: message,
		error: {
			code: 'codex_required_tool_receipt_missing',
			message,
			retryable: true,
		},
		metadata: {
			...result.metadata,
			completionCorrection: {
				attempted: correctionAttempted,
				missingReceipts,
			},
		},
	};
}

function durableReceiptCompletionResult(result: CodexExecutionResult): CodexExecutionResult {
	return {
		...result,
		status: 'completed',
		summary: 'Assignment completion recovered from its complete durable tool receipts before provider terminalization.',
		error: undefined,
		metadata: {
			...result.metadata,
			completionRecovery: {
				source: 'durable_tool_receipts',
				providerResultCode: result.error?.code ?? null,
			},
		},
	};
}

export class CodexExecutionProviderAdapter implements ExecutionProviderAdapter {
	private readonly assignmentWorktrees = new Map<string, string>();
	constructor(private readonly options: CodexExecutionProviderAdapterOptions = {}) {}

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
			capabilityAliases: [],
			nativeUnit: 'token_or_wall_minute',
			quotaVisibility: 'partial' as const,
			maxConcurrentAssignments: Math.max(1, Number(this.options.env?.TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS ?? process.env.TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS) || 4),
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: true,
			supportsArtifacts: true,
		};
	}

	async observe() {
		const readiness = checkCodexProviderReadiness({
			env: {
				...(this.options.env ?? process.env),
				TREESEED_AGENT_EXECUTION_PROVIDER: 'codex',
			},
		});
		return {
			descriptor: await this.describe(),
			available: readiness.ok,
			pressure: readiness.ok ? 'normal' as const : 'exhausted' as const,
			activeAssignmentCount: 0,
			blockedReason: readiness.ok ? null : readiness.blockingIssues.join('; '),
			metadata: {
				authMode: readiness.authMode,
				sdkInstalled: readiness.sdkInstalled,
				nodeVersionOk: readiness.nodeVersionOk,
			},
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const config = resolveCodexProviderConfig(this.options.env ?? process.env);
		const repoRoot = this.options.repoRoot ?? process.cwd();
		const runId = typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id;
		const sandboxMode = (input.agent.execution.sandboxMode ?? config.sandboxMode) as CodexSandboxMode;
		const exactBaseRef = typeof input.metadata?.exactBaseRef === 'string' && input.metadata.exactBaseRef.trim()
			? input.metadata.exactBaseRef.trim()
			: undefined;
		const treeDxAuthority = input.metadata?.contentAuthority === 'treedx';
		const worktree = sandboxMode === 'workspace_write' || Boolean(exactBaseRef)
			? await (this.options.prepareWorktree ?? prepareDefaultWorktree)({
				agent: input.agent,
				runId,
				repoRoot,
				exactBaseRef: treeDxAuthority ? undefined : exactBaseRef,
			})
			: undefined;
		if (worktree) this.assignmentWorktrees.set(input.assignment.id, worktree.worktreeRoot);
		if (exactBaseRef && !treeDxAuthority && !worktree?.exactBaseRef?.toLowerCase().startsWith(exactBaseRef.toLowerCase())) {
			throw new CodexRequestSafetyError(
				'worktree_base_ref_mismatch',
				'Prepared assignment worktree does not prove the governed exact base ref.',
				false,
			);
		}
		const artifactKind = typeof input.workPackage.metadata?.artifactKind === 'string'
			? input.workPackage.metadata.artifactKind
			: null;
		const requireContentArtifact = input.workPackage.metadata?.requireContentArtifact === true;
		const requiredPublishedSignals = Array.isArray(input.assignment.allowedOutputs?.publishedSignals)
			? input.assignment.allowedOutputs.publishedSignals.map(String).filter(Boolean)
			: [];
		const tools = toolsWithWorktree(input.tools, worktree?.worktreeRoot, { artifactKind, requireContentArtifact });
		const configuredTelemetryPath = typeof input.metadata?.toolTelemetryPath === 'string' ? input.metadata.toolTelemetryPath : null;
		const telemetryDirectory = tools.length && !configuredTelemetryPath ? await mkdtemp(join(tmpdir(), 'treeseed-agent-tools-')) : null;
		const toolTelemetryPath = configuredTelemetryPath ?? (telemetryDirectory ? join(telemetryDirectory, 'events.jsonl') : null);
		if (toolTelemetryPath) await writeFile(toolTelemetryPath, '', { encoding: 'utf8', flag: 'a', mode: 0o600 });
		const toolConfigPath = telemetryDirectory ? join(telemetryDirectory, 'mcp-env.json') : null;
		let result: Awaited<ReturnType<typeof runCodexTask>>;
		let toolTelemetry: Record<string, unknown>[] = [];
		let codexClient: Promise<CodexClient> | null = null;
		const timing = assignmentExecutionTiming(
			capacityExecutionTiming(input.capacityEnvelope) ?? input.workPackage.context?.executionTiming
				?? input.workPackage.metadata?.executionTiming,
			input.assignment,
		);
		const configuredTimeoutMs = codexExecutionTimeoutMs(config.timeoutMs, input.agent.execution.timeoutSeconds);
		const effectiveTimeoutMs = deadlineBoundExecutionTimeoutMs(configuredTimeoutMs, timing);
		const executionDeadline = executionCompletionDeadlineMs(configuredTimeoutMs, timing);
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
			timeoutMs: effectiveTimeoutMs,
			tools,
			leaseToken: input.leaseToken,
			toolTelemetryPath,
			toolConfigPath,
			providerAccessToken: this.options.env?.TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN ?? '',
			apiBaseUrl: this.options.env?.TREESEED_API_BASE_URL ?? '',
			researchSourcePolicy: this.options.researchSourcePolicy,
			metadata: {
				subscriptionPlan: config.subscriptionPlan,
				executionTiming: timing ?? null,
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
			const createClient = this.options.createCodexClient ?? ((value?: CodexExecutionRequest) => createDefaultCodexClient(value, this.options.env ?? process.env));
			codexClient = Promise.resolve(createClient(request));
			result = await runCodexTask(request, {
				client: codexClient,
				onEvent: this.options.onEvent,
				signal: input.signal,
			});
			toolTelemetry = await readToolTelemetry(toolTelemetryPath);
			const requiredResponseSuspended = hasRequiredResponseSuspensionReceipt(toolTelemetry);
			const researchStage = typeof input.workPackage.metadata?.researchStage === 'string' ? input.workPackage.metadata.researchStage : null;
			const minimumIndependentSources = Number(input.workPackage.metadata?.minimumIndependentSources ?? 2);
			const initialMissingReceipts = !requiredResponseSuspended&&(result.status === 'completed' || result.error?.code === 'codex_execution_timeout' || researchStage === 'independent-source-fetch')
				? missingCodexCompletionReceipts(tools, toolTelemetry, artifactKind, researchStage, minimumIndependentSources, requireContentArtifact, requiredPublishedSignals)
				: [];
			if (initialMissingReceipts.length) {
				const remainingTimeoutMs = executionDeadline - Date.now();
				if (remainingTimeoutMs > 0 && result.threadId) {
					const correction = await runCodexTask({
						...request,
						threadId: result.threadId,
						timeoutMs: remainingTimeoutMs,
						prompt: [
							'The assignment completion contract is not yet satisfied.',
							`Missing required tool receipts: ${initialMissingReceipts.join(', ')}.`,
							'Do not redo completed work. Use the granted TreeSeed tools to satisfy only the missing gates.',
							completionCorrectionBoundaryInstruction(timing),
							'Run treeseed.changed_paths if needed, call treeseed.verify with bounded argv if its receipt is missing, then call treeseed.checkpoint if its receipt is missing.',
							'If assignment_plan is missing, write the required operational plan. If assignment_terminal_status or assignment_summary is missing, write the terminal status and summary using the latest authoritative state version before committing.',
							'If content_committed is missing, commit the already-validated TreeDX workspace only after every required artifact, relation, terminal status, and summary receipt exists.',
							'If review_decision_recorded is missing, call treeseed.review_decision with the evidence-based approved or rejected disposition.',
							'If discussion_read or discussion_follow is missing, call treeseed.discussion.read and then treeseed.discussion.follow for the exact assignment discussion before responding.',
							'If discussion_final_response is missing, call treeseed.discussion.respond exactly once after both Discussion read receipts exist, using the assignment discussionId, exact replyTo and sourceMessageRefs, intended recipients, current state version, and a stable idempotency key. Do not use generic content creation for the response.',
							'If research_independent_publishers is missing, call the available TreeSeed tool with callName research_fetch_source (policy id research.fetch_source) for sources hosted on additional independent allowed domains until the required distinct-domain count is met. Search for and invoke the callName, not the dotted policy id. Then create, validate, and commit the required linked evidence note.',
							'If content_artifact_kind is missing, create the assignment-required content model and artifact kind with the required subject relation, validate it, and commit it. Auxiliary questions or notes do not replace the required deliverable.',
							'For every signal_publication:<contract-id> receipt that is missing, call treeseed.publish_signal with that exact declared contractId, the assignment subject identity, and a concise evidence-grounded message. Do not invent or omit a declared publication.',
							'If content_subject_linked is missing for a note path, use treeseed.content.link with placement.path set to that exact repository-relative note path and the assignment-required subject relation; validate the same exact placement, then commit the corrected workspace. Every created note, including an accidental placeholder, must be linked before completion.',
							'Wait for each successful receipt and do not send a final response until every listed receipt exists.',
						].join('\n'),
					}, {
						client: codexClient,
						onEvent: this.options.onEvent,
						signal: input.signal,
					});
					result = mergeCodexResults(result, correction);
					toolTelemetry = await readToolTelemetry(toolTelemetryPath);
				}
				const remainingReceipts = missingCodexCompletionReceipts(tools, toolTelemetry, artifactKind, researchStage, minimumIndependentSources, requireContentArtifact, requiredPublishedSignals);
				if (result.error?.code === 'codex_execution_timeout' && !remainingReceipts.length) {
					result = durableReceiptCompletionResult(result);
				} else if (result.status !== 'failed' && remainingReceipts.length) {
					result = missingReceiptResult(result, remainingReceipts, true);
				}
			}
		} finally {
			toolTelemetry = await readToolTelemetry(toolTelemetryPath);
			await codexClient?.then((client) => client.cleanup?.()).catch(() => undefined);
			if (telemetryDirectory) await rm(telemetryDirectory, { recursive: true, force: true });
		}
		const contentReceipts = treeDxContentReceipts(toolTelemetry);
		const requiredResponseSuspended = hasRequiredResponseSuspensionReceipt(toolTelemetry);
		return {
			status: requiredResponseSuspended ? 'returned' : result.status,
			summary: requiredResponseSuspended ? 'Assignment suspended after a durable required-response checkpoint and Discussion message.' : result.summary ?? 'Codex subscription provider returned no summary.',
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
					kind: 'codex',
					unit: result.usage.nativeUnit ?? 'wall_minute',
					amount: Number(result.usage.wallMinutes ?? 0),
					source: 'codex',
					partial: requiredResponseSuspended || result.status !== 'completed',
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
			retryable: assignmentDeadlineExpired(timing) ? false : result.error?.retryable,
			code: result.error?.code ?? null,
			metadata: {
				provider: 'codex',
				worktreeRoot: worktree?.worktreeRoot ?? null,
				worktreeBranch: worktree?.branchName ?? null,
				baseRef: treeDxAuthority ? exactBaseRef ?? null : worktree?.exactBaseRef ?? exactBaseRef ?? null,
				codex: result,
				...(requiredResponseSuspended ? { completion: { disposition: 'suspended', source: 'required_response_receipt' } } : {}),
			},
		};
	}
	async collectUsage(input: ExecutionRunRef) {
		const usage = input.metadata?.codexUsage;
		return usage && typeof usage === 'object'
			? [{
				kind: 'codex',
				unit: String((usage as Record<string, unknown>).nativeUnit ?? 'wall_minute'),
				amount: Number((usage as Record<string, unknown>).wallMinutes ?? 0),
				source: 'codex',
				partial: true,
				metadata: usage as Record<string, unknown>,
			}]
			: [{
				kind: 'codex',
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

	async releaseAssignmentResources(input: { assignmentId: string; outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled' }) {
		const worktreeRoot = this.assignmentWorktrees.get(input.assignmentId);
		if (!worktreeRoot || !['completed', 'returned', 'failed', 'expired'].includes(input.outcome)) return;
		await new AgentWorktreeManager(this.options.repoRoot ?? process.cwd()).releaseWorktree(worktreeRoot);
		this.assignmentWorktrees.delete(input.assignmentId);
	}
}
