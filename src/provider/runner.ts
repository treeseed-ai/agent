import type {
	AgentHandlerOutput,
	AgentTreeDxAdapter,
	ExecutionProviderAdapter,
	ExecutionProviderInvocation,
	ExecutionPreparationResult,
	ExecutionProviderToolDescriptor,
	TreeDxProxyExecutionToolDescriptor,
} from '../agents/runtime-types.ts';
import { AgentSdk, type AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import { buildCapacityProviderAuthHeaders, type ProviderReportRequest, type ProviderWorkdayRequest } from '@treeseed/sdk/capacity-provider';
import type { AgentModeRunStatus, ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import type {
	ExecutionArtifactRef,
	ExecutionProviderObserveInput,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { JiraExecutionProviderConfig } from '../agents/adapters/execution-jira.ts';
import type { GitHubIssuesExecutionProviderConfig } from '../agents/adapters/execution-github-issues.ts';
import type { DiscordExecutionProviderConfig } from '../agents/adapters/execution-discord.ts';
import type { WorkflowExecutionProviderAdapterOptions } from '../agents/adapters/execution-workflow.ts';
import type { PreparedCodexWorktree } from '../agents/adapters/execution-codex.ts';
import { assertRelativeContentPath } from '../agents/content-artifacts.ts';
import {
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
	redactedProviderAssignmentCapabilityHandles,
	validateProviderAssignmentCapabilityHandles,
} from '@treeseed/sdk/agent-capacity';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { createExecutionProviderAdapter } from '../agents/adapters/execution.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import type { ProviderRuntimeConfig } from './config.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { processProviderPortfolio, providerProjectSiteRoot, providerProjectTreeDxOptions, readProviderPortfolioIndex } from './portfolio-processing.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface ProviderAssignmentClient {
	nextAssignment(request?: Record<string, unknown>): Promise<unknown>;
	createAssignmentModeRun(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	completeAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	failAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	portfolio?(request?: Record<string, unknown>): Promise<unknown>;
	createWorkday?(request: ProviderWorkdayRequest): Promise<unknown>;
	writeReport?(request: ProviderReportRequest): Promise<unknown>;
	renewAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	returnAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	dispatchAssignmentWorkflowOperation?(assignmentId: string, operationId: string, request: Record<string, unknown>): Promise<unknown>;
}

const DEFAULT_ASYNC_POLL_INTERVAL_MS = 250;
const DEFAULT_ASYNC_MAX_POLLS = 20;
const execFileAsync = promisify(execFile);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

async function recordEarlyModeRun(input: {
	client: ProviderAssignmentClient;
	assignmentId: string;
	assignment: Record<string, unknown>;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	status: AgentModeRunStatus;
	fallbackReason: string;
	metadata?: Record<string, unknown>;
}) {
	if (!input.assignmentId) return null;
	return input.client.createAssignmentModeRun(input.assignmentId, {
		mode: stringValue(input.assignment.mode, input.capacityEnvelope.mode) ?? 'planning',
		status: input.status,
		selectedInput: input.selectedInput,
		capacityEnvelope: input.capacityEnvelope,
		fallbackReason: input.fallbackReason,
		metadata: {
			source: 'provider_runner_early_exit',
			...(input.metadata ?? {}),
		},
	}).catch(() => null);
}

function waitingResult(summary: string): AgentHandlerOutput {
	return {
		status: 'waiting',
		summary,
	};
}

async function writeProviderContentArtifact(input: {
	repoRoot: string;
	relativePath: string;
	content: string;
	commitMessage: string;
}) {
	const target = assertRelativeContentPath(input.repoRoot, input.relativePath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, input.content, 'utf8');
	return {
		branchName: null,
		commitMessage: input.commitMessage,
		worktreePath: input.repoRoot,
		commitSha: null,
		changedPaths: [input.relativePath],
	};
}

async function inspectProviderRepository(repoRoot: string) {
	try {
		const { stdout: branchStdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: repoRoot,
			env: process.env,
		});
		const { stdout: changedStdout } = await execFileAsync('git', ['status', '--short'], {
			cwd: repoRoot,
			env: process.env,
		});
		const { stdout: shaStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
			cwd: repoRoot,
			env: process.env,
		});
		const changedPaths = changedStdout
			.split('\n')
			.map((entry) => entry.trim().replace(/^[MADRCU?! ]+\s+/, '').trim())
			.filter(Boolean);
		return {
			branchName: branchStdout.trim() || null,
			changedPaths,
			commitSha: shaStdout.trim() || null,
			summary: `Inspected provider workspace with ${changedPaths.length} changed path(s).`,
		};
	} catch (error) {
		return {
			branchName: null,
			changedPaths: [],
			commitSha: null,
			summary: `Provider workspace inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function runProviderVerification(input: { repoRoot: string; commands: string[]; cwd?: string }) {
	if (!input.commands.length) {
		return {
			status: 'completed' as const,
			summary: 'No verification commands were configured for this assignment.',
			stdout: '',
			stderr: '',
		};
	}
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const command of input.commands) {
		try {
			const result = await execFileAsync('/bin/bash', ['-lc', command], {
				cwd: input.cwd ?? input.repoRoot,
				env: process.env,
				maxBuffer: 10 * 1024 * 1024,
			});
			stdout.push(result.stdout);
			stderr.push(result.stderr);
		} catch (error) {
			return {
				status: 'failed' as const,
				summary: `Verification command failed: ${command}`,
				stdout: stdout.join('\n'),
				stderr: error && typeof error === 'object' && 'stderr' in error
					? String((error as { stderr?: string }).stderr ?? '')
					: String(error),
				errorCategory: 'execution_error' as const,
			};
		}
	}
	return {
		status: 'completed' as const,
		summary: `Verification completed for ${input.commands.length} command(s).`,
		stdout: stdout.join('\n'),
		stderr: stderr.join('\n'),
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAsyncExecutionStatus(status: string) {
	return status === 'accepted' || status === 'running' || status === 'waiting' || status === 'blocked';
}

function isRetryableReturnedSnapshot(snapshot: ExecutionRunSnapshot) {
	return snapshot.status === 'blocked' && snapshot.retryable !== false;
}

function modeRunStatusForExecutionSnapshot(snapshot: ExecutionRunSnapshot): AgentModeRunStatus {
	if (snapshot.status === 'completed') return 'succeeded';
	if (snapshot.status === 'failed') return 'failed';
	if (snapshot.status === 'cancelled') return 'cancelled';
	return 'running';
}

function assignmentTerminalCodeForExecutionSnapshot(snapshot: ExecutionRunSnapshot) {
	return snapshot.code ?? `execution_provider_${snapshot.status}`;
}

class DryRunExecutionProviderAdapter implements ExecutionProviderAdapter {
	async describe() {
		return {
			id: 'dry_run',
			kind: 'local_process' as const,
			capabilities: ['planning', 'implementation', 'review', 'test'],
			nativeUnit: 'assignment',
			quotaVisibility: 'opaque' as const,
			maxConcurrentAssignments: 1,
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: false,
			supportsArtifacts: false,
		};
	}

	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'idle' as const,
			activeAssignmentCount: 0,
		};
	}

	async start(input: Parameters<ExecutionProviderAdapter['start']>[0]) {
		return {
			status: 'waiting' as const,
			summary: 'Dry-run execution completed without external model execution because the assignment was explicitly configured as dry-run.',
			runId: typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id,
			metadata: {
				provider: 'dry_run',
				assignmentId: input.assignment.id,
			},
		};
	}
}

interface LifecycleManagedExecutionProviderAdapterOptions {
	adapter: ExecutionProviderAdapter;
	assignmentId: string;
	leaseToken: string | null;
	runnerId: string;
	leaseSeconds: number;
	renewLease: () => Promise<void>;
	recordModeRun: (body: Record<string, unknown>) => Promise<unknown>;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	tools?: ExecutionProviderToolDescriptor[];
	pollIntervalMs?: number;
	maxPolls?: number;
}

class LifecycleManagedExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: LifecycleManagedExecutionProviderAdapterOptions) {}

	describe() {
		return this.options.adapter.describe();
	}

	observe(input: ExecutionProviderObserveInput) {
		return this.options.adapter.observe(input);
	}

	prepare(input: ExecutionProviderInvocation) {
		return this.options.adapter.prepare?.(input)
			?? Promise.resolve({
				accepted: true,
				summary: 'Execution provider accepted the invocation.',
			});
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const invocation = {
			...input,
			leaseToken: input.leaseToken ?? this.options.leaseToken,
			runnerId: input.runnerId || this.options.runnerId,
			tools: [
				...(input.tools ?? []),
				...(this.options.tools ?? []),
			],
		};
		const preparation = await this.prepare(invocation);
		if (!preparation.accepted) {
			const rejected = preparation as Exclude<ExecutionPreparationResult, { accepted: true }>;
			const snapshot: ExecutionRunSnapshot = {
				status: rejected.retryable === false ? 'failed' : 'returned',
				summary: rejected.summary,
				runId: typeof invocation.metadata?.runId === 'string' ? invocation.metadata.runId : invocation.assignment.id,
				retryable: rejected.retryable,
				code: rejected.code ?? 'execution_provider_prepare_rejected',
				metadata: rejected.metadata,
			};
			await this.recordSnapshot(snapshot, 'start');
			return snapshot;
		}

		let snapshot = await this.options.adapter.start(invocation);
		await this.recordSnapshot(snapshot, 'start');

		if (isRetryableReturnedSnapshot(snapshot) || !isAsyncExecutionStatus(snapshot.status) || !this.options.adapter.poll) {
			return this.withCollectedDetails(snapshot);
		}

		const ref = this.snapshotRef(invocation, snapshot);
		const maxPolls = this.options.maxPolls ?? DEFAULT_ASYNC_MAX_POLLS;
		const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_ASYNC_POLL_INTERVAL_MS;

		for (let pollIndex = 0; pollIndex < maxPolls && isAsyncExecutionStatus(snapshot.status); pollIndex += 1) {
			try {
				await this.options.renewLease();
			} catch (error) {
				snapshot = {
					status: 'failed',
					summary: 'Assignment lease renewal failed while execution provider work was in progress.',
					runId: snapshot.runId ?? ref.runId,
					externalRef: snapshot.externalRef ?? ref.externalRef,
					externalUrl: snapshot.externalUrl ?? ref.externalUrl,
					retryable: true,
					code: 'assignment_lease_renewal_failed',
					metadata: {
						...(snapshot.metadata ?? {}),
						error: error instanceof Error ? error.message : String(error),
					},
				};
				await this.recordSnapshot(snapshot, 'poll');
				return snapshot;
			}
			await sleep(pollIntervalMs);
			try {
				snapshot = await this.options.adapter.poll({
					...ref,
					runId: snapshot.runId ?? ref.runId,
					externalRef: snapshot.externalRef ?? ref.externalRef,
					externalUrl: snapshot.externalUrl ?? ref.externalUrl,
					metadata: {
						...(ref.metadata ?? {}),
						...(snapshot.metadata ?? {}),
						pollIndex,
					},
				});
			} catch (error) {
				snapshot = {
					status: 'failed',
					summary: 'Execution provider polling failed.',
					runId: snapshot.runId ?? ref.runId,
					externalRef: snapshot.externalRef ?? ref.externalRef,
					externalUrl: snapshot.externalUrl ?? ref.externalUrl,
					retryable: true,
					code: 'execution_provider_poll_failed',
					metadata: {
						...(snapshot.metadata ?? {}),
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}
			await this.recordSnapshot(snapshot, 'poll');
		}

		if (isAsyncExecutionStatus(snapshot.status)) {
			snapshot = {
				...snapshot,
				status: 'waiting',
				retryable: true,
				code: snapshot.code ?? 'execution_provider_poll_incomplete',
				summary: snapshot.summary || 'Execution provider work is still in progress.',
			};
			await this.recordSnapshot(snapshot, 'poll');
		}

		return this.withCollectedDetails(snapshot);
	}

	poll(input: ExecutionRunRef) {
		return this.options.adapter.poll?.(input)
			?? Promise.resolve({
				status: 'failed' as const,
				summary: 'Execution provider does not support polling.',
				runId: input.runId,
				externalRef: input.externalRef,
				externalUrl: input.externalUrl,
				retryable: false,
				code: 'execution_provider_poll_unsupported',
			});
	}

	resume(input: ExecutionRunRef) {
		return this.options.adapter.resume?.(input) ?? this.poll(input);
	}

	cancel(input: ExecutionRunRef & { reason: string }) {
		return this.options.adapter.cancel?.(input)
			?? Promise.resolve({
				status: 'cancelled' as const,
				summary: input.reason,
				runId: input.runId,
				externalRef: input.externalRef,
				externalUrl: input.externalUrl,
				retryable: false,
				code: 'execution_provider_cancelled',
			});
	}

	collectUsage(input: ExecutionRunRef) {
		return this.options.adapter.collectUsage?.(input) ?? Promise.resolve([]);
	}

	collectArtifacts(input: ExecutionRunRef) {
		return this.options.adapter.collectArtifacts?.(input) ?? Promise.resolve([]);
	}

	private snapshotRef(input: ExecutionProviderInvocation, snapshot: ExecutionRunSnapshot): ExecutionRunRef {
		return {
			assignmentId: input.assignment.id,
			executionProviderId: input.assignment.executionProviderId ?? null,
			runId: snapshot.runId ?? String(input.metadata?.runId ?? input.assignment.id),
			externalRef: snapshot.externalRef ?? null,
			externalUrl: snapshot.externalUrl ?? null,
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			metadata: {
				assignmentId: input.assignment.id,
				provider: snapshot.metadata?.provider ?? null,
			},
		};
	}

	private async recordSnapshot(snapshot: ExecutionRunSnapshot, phase: 'start' | 'poll') {
		await this.options.recordModeRun({
			status: modeRunStatusForExecutionSnapshot(snapshot),
			selectedInput: this.options.selectedInput,
			capacityEnvelope: this.options.capacityEnvelope,
			outputs: {
				status: snapshot.status,
				summary: snapshot.summary,
				outputs: snapshot.outputs ?? {},
				usage: snapshot.usage ?? [],
				artifacts: snapshot.artifacts ?? [],
				externalRef: snapshot.externalRef ?? null,
				externalUrl: snapshot.externalUrl ?? null,
				code: assignmentTerminalCodeForExecutionSnapshot(snapshot),
				metadata: snapshot.metadata ?? {},
			},
			traceRefs: {
				executionRunId: snapshot.runId ?? null,
				externalRef: snapshot.externalRef ?? null,
				externalUrl: snapshot.externalUrl ?? null,
			},
			usageActual: snapshot.usage?.length
				? { nativeUsage: { executionUsage: snapshot.usage } }
				: null,
			fallbackReason: isRetryableReturnedSnapshot(snapshot) ? snapshot.summary : null,
			startedAt: phase === 'start' ? new Date().toISOString() : null,
			completedAt: snapshot.status === 'completed' ? new Date().toISOString() : null,
			failedAt: snapshot.status === 'failed' ? new Date().toISOString() : null,
			metadata: {
				source: 'execution_provider_adapter_lifecycle',
				assignmentId: this.options.assignmentId,
				runnerId: this.options.runnerId,
				leaseSeconds: this.options.leaseSeconds,
				executionStatus: snapshot.status,
				executionRunId: snapshot.runId ?? null,
				externalRef: snapshot.externalRef ?? null,
				externalUrl: snapshot.externalUrl ?? null,
				phase,
			},
		});
	}

	private async withCollectedDetails(snapshot: ExecutionRunSnapshot): Promise<ExecutionRunSnapshot> {
		const runId = snapshot.runId ?? this.options.assignmentId;
		const ref: ExecutionRunRef = {
			assignmentId: this.options.assignmentId,
			runId,
			externalRef: snapshot.externalRef ?? null,
			externalUrl: snapshot.externalUrl ?? null,
			leaseToken: this.options.leaseToken,
			runnerId: this.options.runnerId,
			metadata: snapshot.metadata,
		};
		const [usage, artifacts] = await Promise.all([
			this.collectUsage(ref).catch((): ExecutionUsageActual[] => []),
			this.collectArtifacts(ref).catch((): ExecutionArtifactRef[] => []),
		]);
		const normalizedUsage = snapshot.usage ?? usage;
		const normalizedArtifacts = snapshot.artifacts ?? artifacts;
		return {
			...snapshot,
			usage: normalizedUsage,
			artifacts: normalizedArtifacts,
			metadata: {
				...(snapshot.metadata ?? {}),
				collectedUsageCount: normalizedUsage.length,
				collectedArtifactCount: normalizedArtifacts.length,
			},
		};
	}
}

function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

function providerRunnerCapabilities(config: ProviderRuntimeConfig) {
	const discovered = discoverProviderCapabilities(config);
	return [...new Set(discovered.flatMap((capability) => [
		capability.id,
		...(Array.isArray(capability.metadata?.capabilityAliases)
			? capability.metadata.capabilityAliases.map((entry) => String(entry ?? '').trim()).filter(Boolean)
			: []),
	]).filter(Boolean))];
}

function workspaceAccessMode(assignment: Record<string, unknown>) {
	const handles = record(assignment.capabilityHandles);
	const workspaceContext = record(assignment.workspaceContext);
	const mode = stringValue(handles.workspaceAccessMode, workspaceContext.workspaceAccessMode);
	return ['context_only', 'brokered_workspace', 'full_workspace_no_credentials', 'trusted_direct'].includes(mode ?? '') ? mode : 'context_only';
}

function workflowOperationHandles(assignment: Record<string, unknown>) {
	return Array.isArray(record(assignment.capabilityHandles).workflowOperations)
		? record(assignment.capabilityHandles).workflowOperations as Record<string, unknown>[]
		: [];
}

function executionProviderSelectionForAssignment(assignment: Record<string, unknown>, dryRun: boolean) {
	if (dryRun) return 'dry_run';
	const capacityEnvelope = record(assignment.capacityEnvelope);
	const metadata = record(assignment.metadata);
	const envelopeMetadata = record(capacityEnvelope.metadata);
	const decisionInput = record(assignment.decisionInput);
	const decisionMetadata = record(decisionInput.metadata);
	return stringValue(
		assignment.executionProviderId,
		assignment.executionProviderKind,
		metadata.executionProviderId,
		metadata.executionProviderKind,
		envelopeMetadata.executionProviderId,
		envelopeMetadata.executionProviderKind,
		decisionMetadata.executionProviderId,
		decisionMetadata.executionProviderKind,
		'codex',
	);
}

function createAssignmentExecutionProviderAdapter(input: {
	selection: string | null;
	repoRoot: string;
	dryRun: boolean;
	jira?: JiraExecutionProviderConfig | null;
	githubIssues?: GitHubIssuesExecutionProviderConfig | null;
	discord?: DiscordExecutionProviderConfig | null;
	workflow?: WorkflowExecutionProviderAdapterOptions | null;
}) {
	if (input.dryRun) return new DryRunExecutionProviderAdapter();
	return createExecutionProviderAdapter(input.selection ?? 'codex', {
		repoRoot: input.repoRoot,
		jira: input.jira,
		githubIssues: input.githubIssues,
		discord: input.discord,
		workflow: input.workflow,
		codex: providerLocalCodexOptions(input.repoRoot),
	});
}

function sanitizeCodexWorktreePart(value: string) {
	return value.replace(/[^A-Za-z0-9._/-]+/gu, '-').replace(/^\/+|\/+$/gu, '') || 'agent';
}

function providerLocalCodexOptions(repoRoot: string) {
	if (!repoRoot.startsWith('/workspace')) return null;
	return {
		prepareWorktree: async (input: {
			agent: { slug: string };
			runId: string;
			repoRoot: string;
		}): Promise<PreparedCodexWorktree> => ({
			branchName: [
				'local-mounted-workspace',
				sanitizeCodexWorktreePart(input.agent.slug),
				sanitizeCodexWorktreePart(input.runId),
			].join('/'),
			worktreeRoot: input.repoRoot,
			created: false,
		}),
	};
}

function treeDxPathMatches(pattern: string, candidate: string) {
	const normalizedPattern = String(pattern ?? '').replace(/^\/+/, '');
	const normalizedCandidate = String(candidate ?? '').replace(/^\/+/, '');
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('*')) return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
	return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

function evaluateTreeDxProxyHandleAccessLocal(handle: Record<string, unknown>, request: { projectId: string; assignmentId?: string | null; repositoryId?: string | null; workspaceId?: string | null; operation?: string | null; path?: string | null }) {
	if (handle.projectId !== request.projectId) return { ok: false, reason: 'TreeDX proxy handle scope does not match the project.' };
	if (request.assignmentId && typeof handle.assignmentId === 'string' && handle.assignmentId !== request.assignmentId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different assignment.' };
	if (request.repositoryId && typeof handle.repositoryId === 'string' && handle.repositoryId !== request.repositoryId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different repository.' };
	if (request.workspaceId && typeof handle.workspaceId === 'string' && handle.workspaceId !== request.workspaceId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different workspace.' };
	if (typeof handle.expiresAt === 'string' && Date.parse(handle.expiresAt) <= Date.now()) return { ok: false, reason: 'TreeDX proxy handle has expired.' };
	const operation = request.operation ? String(request.operation) : null;
	const allowedOperations = Array.isArray(handle.allowedOperations) ? handle.allowedOperations.map(String) : [];
	if (operation && allowedOperations.length && !allowedOperations.includes(operation) && !allowedOperations.includes('*')) return { ok: false, reason: 'TreeDX proxy handle does not allow this operation.' };
	const path = request.path ? String(request.path).replace(/^\/+/, '') : null;
	const allowedPaths = Array.isArray(handle.allowedPaths) ? handle.allowedPaths.map(String).filter(Boolean) : [];
	if (path && allowedPaths.length && !allowedPaths.some((pattern) => treeDxPathMatches(pattern, path))) return { ok: false, reason: 'TreeDX proxy handle does not allow this path.' };
	return { ok: true };
}

function createAssignmentTreeDxAdapter(input: {
	config: ProviderRuntimeConfig;
	projectId: string;
	assignmentId: string;
	treedxProxyHandle: Record<string, unknown>;
}): AgentTreeDxAdapter | null {
	const handleId = stringValue(input.treedxProxyHandle.id);
	if (!input.config.marketUrl || !input.config.apiKey || !handleId) return null;
	const baseUrl = normalizeBaseUrl(input.config.marketUrl);
	const defaultRepoId = stringValue(input.treedxProxyHandle.repositoryId);
	const defaultWorkspaceId = stringValue(input.treedxProxyHandle.workspaceId);
	const checkScope = (request: { repoId?: string | null; workspaceId?: string | null; operation?: string | null; path?: string | null }) => {
		const result = evaluateTreeDxProxyHandleAccessLocal(input.treedxProxyHandle, {
			projectId: input.projectId,
			assignmentId: input.assignmentId,
			repositoryId: request.repoId ?? defaultRepoId,
			workspaceId: request.workspaceId ?? defaultWorkspaceId,
			operation: request.operation ?? null,
			path: request.path ?? null,
		});
		if (!result.ok) {
			throw new Error(result.reason ?? 'TreeDX proxy handle does not allow this request.');
		}
	};
	const headers = {
		accept: 'application/json',
		'content-type': 'application/json',
		'x-treeseed-assignment-id': input.assignmentId,
		'x-treeseed-treedx-proxy-handle-id': handleId,
		...buildCapacityProviderAuthHeaders(input.config.apiKey),
	};
	const request = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = record(payload).error;
			const message = typeof error === 'string'
				? error
				: record(error).message && typeof record(error).message === 'string'
					? String(record(error).message)
					: `TreeDX proxy request failed with ${response.status}.`;
			throw new Error(message);
		}
		return record(payload);
	};
	return {
		buildContext: ({ repoId, query, paths, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for context build.');
			checkScope({ repoId: effectiveRepoId, operation: 'files:read', path: paths?.[0] ?? null });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/context/build`, {
			query,
			paths,
			...(body ?? {}),
			});
		},
		readRepositoryFiles: ({ repoId, paths, ref, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for file read.');
			for (const path of paths) checkScope({ repoId: effectiveRepoId, operation: 'files:read', path });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/files/read`, {
			paths,
			ref,
			...(body ?? {}),
			});
		},
		searchWorkspace: ({ workspaceId, query, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace search.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:search' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/search`, {
			query,
			...(body ?? {}),
			});
		},
		readWorkspaceFile: ({ workspaceId, path }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file read.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:read', path });
			return request('GET', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`);
		},
		writeWorkspaceFile: ({ workspaceId, path, content, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file write.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:write', path });
			return request('PUT', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`, {
			content,
			...(body ?? {}),
			});
		},
		commitWorkspace: ({ workspaceId, message, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace commit.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'git:commit' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/commit`, {
			message,
			...(body ?? {}),
			});
		},
	};
}

function assignmentScopedTreeDxOptions(base: AgentSdkTreeDxOptions | undefined, handle: Record<string, unknown>) {
	if (!base) return undefined;
	const repositoryId = stringValue(handle.repositoryId);
	const workspaceId = stringValue(handle.workspaceId);
	return {
		...base,
		...(repositoryId ? { repoId: repositoryId } : {}),
		...(workspaceId ? { workspaceId } : {}),
	} satisfies AgentSdkTreeDxOptions;
}

function createAssignmentTreeDxToolDescriptor(input: {
	projectId: string;
	assignmentId: string;
	treedxProxyHandle: Record<string, unknown>;
	workspaceMode?: string | null;
}): TreeDxProxyExecutionToolDescriptor | null {
	const handleId = stringValue(input.treedxProxyHandle.id);
	if (!handleId) return null;
	const scope = evaluateTreeDxProxyHandleAccessLocal(input.treedxProxyHandle, {
		projectId: input.projectId,
		assignmentId: input.assignmentId,
	});
	if (!scope.ok) return null;
	const repositoryId = stringValue(input.treedxProxyHandle.repositoryId);
	const workspaceId = stringValue(input.treedxProxyHandle.workspaceId);
	const rawAllowedOperations = Array.isArray(input.treedxProxyHandle.allowedOperations)
		? input.treedxProxyHandle.allowedOperations.map(String).filter(Boolean)
		: [];
	const writable = input.workspaceMode !== 'context_only';
	const allowedOperations = rawAllowedOperations.length > 0
		? rawAllowedOperations.filter((operation) => writable || !['files:write', 'git:commit'].includes(operation))
		: writable
			? ['files:read', 'files:search', 'files:write', 'git:commit']
			: ['files:read', 'files:search'];
	const allowedPaths = Array.isArray(input.treedxProxyHandle.allowedPaths)
		? input.treedxProxyHandle.allowedPaths.map(String).filter(Boolean)
		: [];
	const project = encodeURIComponent(input.projectId);
	const repo = repositoryId ? encodeURIComponent(repositoryId) : ':repoId';
	const workspace = workspaceId ? encodeURIComponent(workspaceId) : ':workspaceId';
	return {
		kind: 'treedx_proxy',
		id: `treedx-proxy:${handleId}`,
		name: 'TreeDX assignment proxy',
		description: 'Assignment-scoped TreeDX content and workspace operations proxied through the TreeSeed API.',
		projectId: input.projectId,
		assignmentId: input.assignmentId,
		handleId,
		repositoryId,
		workspaceId,
		operations: allowedOperations,
		allowedOperations,
		allowedPaths,
		routes: {
			buildContext: `POST /v1/dx/projects/${project}/repos/${repo}/context/build`,
			readRepositoryFiles: `POST /v1/dx/projects/${project}/repos/${repo}/files/read`,
			searchWorkspace: `POST /v1/dx/projects/${project}/workspaces/${workspace}/search`,
			readWorkspaceFile: `GET /v1/dx/projects/${project}/workspaces/${workspace}/files?path=:path`,
			writeWorkspaceFile: `PUT /v1/dx/projects/${project}/workspaces/${workspace}/files?path=:path`,
			commitWorkspace: `POST /v1/dx/projects/${project}/workspaces/${workspace}/commit`,
		},
		metadata: {
			requiresHeaders: [
				'Authorization: Bearer <capacity-provider-api-key>',
				'x-treeseed-assignment-id',
				'x-treeseed-treedx-proxy-handle-id',
			],
		},
	};
}

export async function runProviderRunnerOnce(input: {
	config: ProviderRuntimeConfig;
	client: ProviderAssignmentClient;
	runnerId?: string;
	executionAdapter?: ExecutionProviderAdapter;
	treeDx?: AgentSdkTreeDxOptions;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
}) {
	const runnerId = input.runnerId ?? `provider-runner-${process.pid}`;
	const leased = await input.client.nextAssignment({
		runnerId: input.runnerId ?? `provider-runner-${process.pid}`,
		capabilities: providerRunnerCapabilities(input.config),
	});
	const leasedRecord = record(leased);
	const assignment = record(leasedRecord.payload ?? leasedRecord.assignment);
	if (!Object.keys(assignment).length) {
		const leaseDiagnostics = record(leasedRecord.leaseDiagnostics ?? leasedRecord.diagnostics);
		return {
			ok: true,
			role: 'runner',
			dryRun: false,
			assigned: 0,
			result: null,
			...(Object.keys(leaseDiagnostics).length ? { leaseDiagnostics } : {}),
		};
	}
	const leaseToken = stringValue(leasedRecord.leaseToken, assignment.leaseToken);
	const leaseSeconds = Number(leasedRecord.leaseSeconds ?? 300);
	const renewLease = async () => {
		if (!leaseToken || !input.client.renewAssignment) return;
		await input.client.renewAssignment(String(assignment.id), {
			leaseToken,
			runnerId,
			leaseSeconds,
		});
	};
	await renewLease();
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	if (leaseToken && input.client.renewAssignment) {
		const renewEveryMs = Math.max(15_000, Math.min(leaseSeconds * 500, 120_000));
		renewTimer = setInterval(() => {
			void renewLease().catch(() => null);
		}, renewEveryMs);
	}
	let result;
	try {
		result = await runProviderAssignment({
			config: input.config,
			client: input.client,
			assignment,
			leaseToken,
			runnerId,
			leaseSeconds,
			renewLease,
			executionAdapter: input.executionAdapter,
			treeDx: input.treeDx,
			executionLifecycle: input.executionLifecycle,
		});
	} finally {
		if (renewTimer) clearInterval(renewTimer);
	}
	return {
		ok: true,
		role: 'runner',
		dryRun: false,
		assigned: 1,
		assignmentId: stringValue(assignment.id),
		taskId: stringValue(assignment.taskId, assignment.id),
		result,
	};
}

async function runProviderAssignment(input: {
	config: ProviderRuntimeConfig;
	client: ProviderAssignmentClient;
	assignment: Record<string, unknown>;
	leaseToken: string | null;
	runnerId: string;
	leaseSeconds: number;
	renewLease: () => Promise<void>;
	executionAdapter?: ExecutionProviderAdapter;
	treeDx?: AgentSdkTreeDxOptions;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
}) {
	const assignmentId = stringValue(input.assignment.id) ?? '';
	const decisionInput = record(input.assignment.decisionInput);
	const decisionPayload = record(decisionInput.input);
	const capacityEnvelope = record(input.assignment.capacityEnvelope);
	const projectId = stringValue(input.assignment.projectId, decisionInput.projectId, capacityEnvelope.projectId);
	const agentSlug = stringValue(input.assignment.agentId, decisionInput.agentId, decisionPayload.agentSlug, decisionPayload.agentId);
	if (!projectId || !agentSlug) {
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason: 'assignment_missing_project_or_agent',
			metadata: { projectId, agentSlug },
		});
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: 'assignment_missing_project_or_agent',
			message: 'Provider assignment requires projectId and agentId.',
			retryable: false,
		});
	}
	let index = await readProviderPortfolioIndex(input.config);
	let project = index?.projects.find((entry) => entry.projectId === projectId);
	if ((!project || (input.config.environment === 'local' && !project.repository.ok)) && input.client.portfolio && input.client.createWorkday && input.client.writeReport) {
		const portfolioClient = {
			portfolio: input.client.portfolio.bind(input.client),
			createWorkday: async (request: ProviderWorkdayRequest) => {
				const response = record(await input.client.createWorkday!(request));
				return {
					ok: true as const,
					workDay: record(response.workDay ?? response.payload ?? response),
				};
			},
			writeReport: input.client.writeReport.bind(input.client),
		};
		await processProviderPortfolio({
			config: input.config,
			client: portfolioClient,
			treeDx: input.treeDx,
		});
		index = await readProviderPortfolioIndex(input.config);
		project = index?.projects.find((entry) => entry.projectId === projectId);
	}
	if (!project?.repository.ok) {
		const body = {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			reason: `Project ${projectId} has not been synced by the provider manager.`,
			code: 'provider_project_not_synced',
			retryable: true,
			metadata: {
				projectId,
				agentSlug,
			},
		};
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason: body.code,
			metadata: {
				projectId,
				agentSlug,
				repository: project?.repository ?? null,
			},
		});
		if (input.client.returnAssignment) {
			return input.client.returnAssignment(assignmentId, body);
		}
		return input.client.failAssignment(assignmentId, {
			...body,
			message: body.reason,
		});
	}
		const projectSiteRoot = providerProjectSiteRoot(project, project.repository.path);
		const projectTreeDx = providerProjectTreeDxOptions(project, input.treeDx);
		const scopedTreeDx = assignmentScopedTreeDxOptions(projectTreeDx, record(input.assignment.treedxProxyHandle));
		const localSdk = AgentSdk.createLocal({
			repoRoot: projectSiteRoot,
			treeDx: scopedTreeDx,
		});
	const capabilityHandles = redactedProviderAssignmentCapabilityHandles(record(input.assignment.capabilityHandles));
	const workspaceMode = workspaceAccessMode({ ...input.assignment, capabilityHandles });
	const handleFallback = validateProviderAssignmentCapabilityHandles({
		assignment: {
			...input.assignment,
			id: assignmentId,
			teamId: stringValue(input.assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			mode: stringValue(input.assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
			capabilityHandles,
		} as any,
		capabilityHandles,
	});
	if (handleFallback) {
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason: handleFallback.code,
			metadata: handleFallback.metadata,
		});
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: handleFallback.code,
			message: handleFallback.reason,
			retryable: handleFallback.retryable,
			metadata: handleFallback.metadata,
		});
	}
	const providerNoop = async () => ({ ok: true, payload: null });
	let providerMessageCounter = 0;
	const providerCreateMessage = async (request: Record<string, unknown>) => {
		providerMessageCounter += 1;
		const message = {
			id: `provider-message-${assignmentId}-${providerMessageCounter}`,
			...request,
			actor: request.actor ?? 'agent',
			createdAt: new Date().toISOString(),
		};
		await input.client.createAssignmentModeRun(assignmentId, {
			mode: stringValue(input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
			status: 'running',
			selectedInput: decisionPayload,
			capacityEnvelope,
			outputs: {
				status: 'message_recorded',
				summary: `Recorded provider assignment message ${message.id}.`,
				metadata: {
					source: 'provider_runner_message',
					message,
				},
			},
			metadata: {
				source: 'provider_runner_message',
				assignmentId,
				runnerId: input.runnerId,
				messageId: message.id,
			},
		}).catch(() => null);
		return {
			ok: true,
			model: 'message',
			action: 'create',
			payload: message,
		};
	};
	const sdk = {
		repoRoot: localSdk.repoRoot,
		listRawAgentSpecs: localSdk.listRawAgentSpecs.bind(localSdk),
		listAgentSpecs: localSdk.listAgentSpecs.bind(localSdk),
		scopeForAgent(agent: Parameters<AgentSdk['scopeForAgent']>[0]) {
			const scoped = localSdk.scopeForAgent(agent) as Record<PropertyKey, unknown>;
			const overrides: Record<PropertyKey, unknown> = {
				recordRun: providerNoop,
				ackMessage: providerNoop,
				upsertCursor: providerNoop,
				releaseAllLeases: providerNoop,
				createMessage: providerCreateMessage,
			};
			return new Proxy(scoped, {
				get(target, property, receiver) {
					if (property in overrides) return overrides[property];
					const value = Reflect.get(target, property, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		},
		recordRun: providerNoop,
		ackMessage: providerNoop,
		upsertCursor: providerNoop,
		releaseAllLeases: providerNoop,
		createMessage: providerCreateMessage,
	} as unknown as AgentSdk;
	const dryRun = decisionPayload.dryRun !== false && !input.config.codexAuthFile && !input.config.codexAuthJsonB64;
	const treeDxToolDescriptor = ['brokered_workspace', 'trusted_direct', 'context_only'].includes(workspaceMode ?? '')
		? createAssignmentTreeDxToolDescriptor({
			projectId,
			assignmentId,
			treedxProxyHandle: record(input.assignment.treedxProxyHandle),
			workspaceMode,
		})
		: null;
	const baseExecutionAdapter = input.executionAdapter ?? createAssignmentExecutionProviderAdapter({
		selection: executionProviderSelectionForAssignment(input.assignment, dryRun),
		repoRoot: project.repository.path,
		dryRun,
		jira: input.config.jira,
		githubIssues: input.config.githubIssues,
		discord: input.config.discord,
			workflow: {
				dispatchWorkflowOperation: input.client.dispatchAssignmentWorkflowOperation
					? async (workflowAssignmentId, operationId, body) => {
						const response = await input.client.dispatchAssignmentWorkflowOperation!(workflowAssignmentId, operationId, body);
						const responseRecord = record(response);
						return {
							ok: responseRecord.ok === undefined ? true : responseRecord.ok === true,
							payload: record(responseRecord.payload ?? responseRecord),
						};
					}
					: undefined,
			},
	});
	const execution = new LifecycleManagedExecutionProviderAdapter({
		adapter: baseExecutionAdapter,
		assignmentId,
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		leaseSeconds: input.leaseSeconds,
		renewLease: input.renewLease,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body),
		selectedInput: decisionPayload,
		capacityEnvelope,
		tools: treeDxToolDescriptor ? [treeDxToolDescriptor] : [],
		pollIntervalMs: input.executionLifecycle?.pollIntervalMs,
		maxPolls: input.executionLifecycle?.maxPolls,
	});
	const kernel = new AgentKernel(sdk, project.repository.path, {
		treeDx: ['brokered_workspace', 'trusted_direct', 'context_only'].includes(workspaceMode ?? '')
			? createAssignmentTreeDxAdapter({
				config: input.config,
				projectId,
				assignmentId,
				treedxProxyHandle: record(input.assignment.treedxProxyHandle),
			})
			: null,
		execution,
		mutations: {
			writeArtifact: async (artifact) => writeProviderContentArtifact({
				repoRoot: project.repository.path,
				relativePath: artifact.relativePath,
				content: artifact.content,
				commitMessage: artifact.commitMessage,
			}),
		},
		repository: {
			inspectBranch: async () => inspectProviderRepository(project.repository.path),
		},
		verification: {
			runChecks: async ({ commands, cwd }) => runProviderVerification({
				repoRoot: project.repository.path,
				commands,
				cwd,
			}),
		},
		notifications: {
			deliver: async ({ agent, runId, recipients, subject, body }) => {
				await providerCreateMessage({
					type: 'agent.notification',
					payload: {
						agentSlug: agent.slug,
						runId,
						recipients,
						subject,
						body,
					},
					relatedModel: 'agent',
					relatedId: agent.slug,
					actor: 'agent',
				});
				return {
					status: 'completed',
					summary: recipients.length
						? `Recorded notification for ${recipients.length} recipient(s).`
						: 'Recorded notification event without direct recipients.',
					deliveredCount: recipients.length,
				};
			},
		},
		research: {
				research: async ({ questionId, reason, runId }) => {
					const graphResult = record(await localSdk.queryGraph({
						query: questionId,
						options: { limit: 5 },
					}).catch(() => null));
					const items = Array.isArray(graphResult?.items) ? graphResult.items : [];
				return {
					status: 'completed',
					summary: `Prepared graph-backed research for ${questionId}.`,
					markdown: [
						'# Research Summary',
						'',
						`Question: ${questionId}`,
						`Reason: ${reason ?? 'not provided'}`,
						`Run: ${runId}`,
						'',
						items.length ? 'Relevant graph context:' : 'No ranked graph context was available. The question is recorded for follow-up.',
						...items.map((item: any) => `- ${String(item.title ?? item.id ?? 'context')}`),
					].join('\n'),
					sources: items.map((item: any) => String(item.id ?? item.title ?? '')).filter(Boolean),
				};
			},
		},
		operations: {
			runOperation: async ({ request }) => {
				const operationId = stringValue(record(request.input).workflowOperationId, record(request.input).operationId, request.operation);
				const handleId = stringValue(record(request.input).workflowOperationHandleId, record(request.input).handleId);
				const handle = workflowOperationHandles({ ...input.assignment, capabilityHandles })
					.find((entry) => stringValue(entry.operationId) === operationId && (!handleId || stringValue(entry.id) === handleId));
				if (!handle || !input.client.dispatchAssignmentWorkflowOperation) {
					return {
						operation: request.operation,
						status: 'waiting',
						summary: 'Provider assignment operation requires an assignment-scoped workflow operation handle.',
						changedPaths: [],
						stagedPaths: [],
						commandsRun: [],
						artifacts: [],
						error: {
							code: 'assignment_workflow_operation_denied',
							message: 'No active workflow operation handle is available for this assignment.',
							retryable: false,
						},
						metadata: { operationId, handleId },
					};
				}
					const result = record(await input.client.dispatchAssignmentWorkflowOperation(assignmentId, operationId ?? '', {
						leaseToken: input.leaseToken,
						handleId: stringValue(handle.id),
						inputs: record(request.input).inputs ?? record(request.input),
						wait: record(request.input).wait === true,
					}));
				return {
					operation: request.operation,
					status: 'completed',
					summary: `Dispatched workflow operation ${operationId}.`,
					changedPaths: [],
					stagedPaths: [],
					commandsRun: ['workflow_operation_dispatch'],
					artifacts: [],
					metadata: {
						workflowOperationId: operationId,
						workflowOperationHandleId: stringValue(handle.id),
							dispatch: record(result.payload ?? result),
					},
				};
			},
		},
	});
	const typedAssignment = {
		...input.assignment,
		id: assignmentId,
		teamId: stringValue(input.assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
		projectId,
		capacityProviderId: stringValue(input.assignment.capacityProviderId, capacityEnvelope.capacityProviderId) ?? '',
		projectAgentClassId: stringValue(input.assignment.projectAgentClassId, decisionInput.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
		mode: stringValue(input.assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
		status: stringValue(input.assignment.status) ?? 'leased',
		leaseState: stringValue(input.assignment.leaseState) ?? 'leased',
		agentId: agentSlug,
		handlerId: stringValue(input.assignment.handlerId, decisionInput.handlerId),
		capacityEnvelope: {
			...capacityEnvelope,
			teamId: stringValue(capacityEnvelope.teamId, input.assignment.teamId, decisionInput.teamId) ?? '',
			projectId,
			mode: stringValue(capacityEnvelope.mode, input.assignment.mode, decisionInput.mode) ?? 'planning',
			projectAgentClassId: stringValue(capacityEnvelope.projectAgentClassId, input.assignment.projectAgentClassId, decisionInput.projectAgentClassId) ?? agentSlug,
			capacityProviderId: stringValue(capacityEnvelope.capacityProviderId, input.assignment.capacityProviderId) ?? '',
		},
		decisionInput: {
			...decisionInput,
			teamId: stringValue(decisionInput.teamId, input.assignment.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			projectAgentClassId: stringValue(decisionInput.projectAgentClassId, input.assignment.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
			mode: stringValue(decisionInput.mode, input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
			agentId: agentSlug,
			input: {
				...decisionPayload,
				projectId,
				agentSlug,
				assignmentId,
			},
		},
		capabilityHandles,
		workspaceContext: {
			...record(input.assignment.workspaceContext),
			workspaceAccessMode: workspaceMode,
			capabilityHandles,
		},
	} as ProviderAssignment;
	let fallbackOutput: Record<string, unknown> | null = null;
	await input.client.createAssignmentModeRun(assignmentId, {
		mode: typedAssignment.mode,
		status: 'running',
		selectedInput: record(typedAssignment.decisionInput.input),
		capacityEnvelope: deriveAgentCapacityEnvelopeFromAssignment(typedAssignment),
		startedAt: new Date().toISOString(),
		validation: {
			mode: typedAssignment.mode,
			projectAgentClassId: typedAssignment.projectAgentClassId,
			phase: 'provider_runner_assignment_started',
		},
		metadata: {
			source: 'provider_runner_assignment_started',
			assignmentId,
			runnerId: input.runnerId,
			projectId,
			agentSlug,
			repositoryPath: project.repository.path,
		},
	}).catch(() => null);
	const modeResult = await kernel.runAssignment({
		assignment: typedAssignment,
		capacityEnvelope: deriveAgentCapacityEnvelopeFromAssignment(typedAssignment),
		decisionInput: deriveDecisionExecutionInputFromAssignment(typedAssignment),
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		readiness: record(input.assignment.readiness ?? record(decisionInput.metadata).readiness) as any,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body as unknown as Record<string, unknown>),
		recordFallbackOutput: async (output) => {
			fallbackOutput = output;
			return output;
		},
	});
	if (modeResult.status === 'completed') {
		return input.client.completeAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			output: {
				dryRun,
				liveCodex: !dryRun,
				projectId,
				agentSlug,
				mode: modeResult.mode,
				status: modeResult.status,
				summary: modeResult.summary,
					metadata: {
						...(modeResult.metadata ?? {}),
						...record(record(modeResult.outputs).metadata),
					},
				traceRefs: modeResult.traceRefs ?? {},
			},
			summary: {
				dryRun,
				liveCodex: !dryRun,
				summary: modeResult.summary,
				mode: modeResult.mode,
			},
		});
	}
	if (modeResult.status === 'returned' && input.client.returnAssignment) {
		return input.client.returnAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			reason: modeResult.fallback?.reason ?? modeResult.summary,
			code: modeResult.fallback?.code ?? 'provider_assignment_returned',
			retryable: modeResult.fallback?.retryable ?? true,
			output: modeResult.outputs ?? {},
			fallbackOutput: fallbackOutput ?? undefined,
		});
	}
	return input.client.failAssignment(assignmentId, {
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		code: modeResult.fallback?.code ?? 'provider_assignment_failed',
		message: modeResult.fallback?.reason ?? modeResult.summary,
		retryable: modeResult.fallback?.retryable ?? false,
		output: {
				...(modeResult.outputs ?? {}),
				metadata: {
					...record(record(modeResult.outputs).metadata),
					...(modeResult.metadata ?? {}),
				},
		},
		fallbackOutput: fallbackOutput ?? undefined,
	});
}
