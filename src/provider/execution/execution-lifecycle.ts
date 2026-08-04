import type {
	AgentHandlerOutput,
	ExecutionProviderAdapter,
	ExecutionProviderInvocation,
	ExecutionPreparationResult,
	ExecutionProviderToolDescriptor,
} from '../../agents/runtime/runtime-types.ts';
import type {
	ExecutionArtifactRef,
	ExecutionProviderObserveInput,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { AgentModeRunStatus } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import type { AssignmentToolCatalog } from '../commerce/catalog/assignment-tool-catalog.ts';
import { record } from '../configuration/value-utils.ts';

const DEFAULT_ASYNC_POLL_INTERVAL_MS = 250;
const DEFAULT_ASYNC_MAX_POLLS = 20;

function waitingResult(summary: string): AgentHandlerOutput {
	return {
		status: 'waiting',
		summary,
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

interface LifecycleManagedExecutionProviderAdapterOptions {
	adapter: ExecutionProviderAdapter;
	assignmentId: string;
	leaseToken: string | null;
	runnerId: string;
	leaseSeconds: number;
	renewLease: () => Promise<void>;
	recordModeRun: (body: Record<string, unknown>) => Promise<unknown>;
	modeRunId: string;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	tools?: ExecutionProviderToolDescriptor[];
	agentToolCatalog?: Omit<AssignmentToolCatalog, 'descriptors'>;
	pollIntervalMs?: number;
	maxPolls?: number;
}

export class LifecycleManagedExecutionProviderAdapter implements ExecutionProviderAdapter {
	private readonly phaseIdSeed = randomUUID();
	private phaseCounter = 0;

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

		await this.recordSnapshot({
			status: 'running',
			summary: 'Execution provider invocation started.',
			runId: typeof invocation.metadata?.runId === 'string' ? invocation.metadata.runId : invocation.assignment.id,
			metadata: {
				source: 'execution_provider_starting',
				provider: invocation.assignment.executionProviderId ?? null,
				toolCount: invocation.tools?.length ?? 0,
				tools: invocation.tools ?? [],
				agentToolCatalog: this.options.agentToolCatalog ?? null,
				workPackage: invocation.workPackage,
				agent: {
					slug: invocation.agent.slug,
					name: invocation.agent.slug,
					handler: invocation.agent.handler,
					execution: invocation.agent.execution,
					contextQueryCount: invocation.agent.context?.queries?.length ?? 0,
				},
				workspace: invocation.workspace,
				projectAgentClass: invocation.projectAgentClass ?? null,
				redactedParameters: {
					assignmentId: invocation.assignment.id,
					projectId: invocation.assignment.projectId,
					mode: invocation.capacityEnvelope.mode,
					executionProviderId: invocation.assignment.executionProviderId ?? null,
					runnerId: invocation.runnerId ?? null,
					leaseTokenPresent: Boolean(invocation.leaseToken),
				},
			},
		}, 'start');

		let snapshot = await this.options.adapter.start(invocation);
		await this.recordSnapshot(snapshot, 'start');

		if (isRetryableReturnedSnapshot(snapshot) || !isAsyncExecutionStatus(snapshot.status) || !this.options.adapter.poll) {
			return this.withCollectedDetails(snapshot);
		}

		const ref = this.snapshotRef(invocation, snapshot);
		const maxPolls = this.options.maxPolls ?? DEFAULT_ASYNC_MAX_POLLS;
		const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_ASYNC_POLL_INTERVAL_MS;
		try {
			await this.options.renewLease();
		} catch (error) {
			snapshot = {
				status: 'failed',
				summary: 'Assignment lease renewal failed after execution provider work was accepted.',
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
		return this.options.adapter.collectUsage?.(input) ?? Promise.resolve([{
			kind: 'execution_provider_usage',
			unit: 'unsupported',
			amount: 0,
			source: 'provider_runner',
			partial: true,
			metadata: {
				supported: false,
				reason: 'adapter_collect_usage_not_implemented',
			},
		}]);
	}

	collectArtifacts(input: ExecutionRunRef) {
		return this.options.adapter.collectArtifacts?.(input) ?? Promise.resolve([{
			kind: 'execution_provider_artifacts',
			name: 'artifact-collection-not-implemented',
			metadata: {
				supported: false,
				reason: 'adapter_collect_artifacts_not_implemented',
			},
		}]);
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
		this.phaseCounter += 1;
		const source = snapshot.metadata?.source === 'execution_provider_starting'
			? 'execution_provider_starting'
			: 'execution_provider_adapter_lifecycle';
		const lifecyclePhase = snapshot.metadata?.source === 'execution_provider_starting'
			? 'starting'
			: `${phase}_${snapshot.status}`;
		await this.options.recordModeRun({
			id: `${this.options.modeRunId}:${source}:${this.phaseIdSeed}:${this.phaseCounter}`,
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
				recordKind: 'telemetry',
				source,
				assignmentId: this.options.assignmentId,
				runnerId: this.options.runnerId,
				leaseSeconds: this.options.leaseSeconds,
				executionStatus: snapshot.status,
				executionRunId: snapshot.runId ?? null,
				externalRef: snapshot.externalRef ?? null,
				externalUrl: snapshot.externalUrl ?? null,
				phase,
				lifecyclePhase,
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
			this.collectUsage(ref).catch((error): ExecutionUsageActual[] => [{
				kind: 'execution_provider_usage',
				unit: 'unsupported',
				amount: 0,
				source: 'provider_runner',
				partial: true,
				metadata: {
					supported: false,
					reason: 'collect_usage_failed',
					error: error instanceof Error ? error.message : String(error),
				},
			}]),
			this.collectArtifacts(ref).catch((error): ExecutionArtifactRef[] => [{
				kind: 'execution_provider_artifacts',
				name: 'artifact-collection-unavailable',
				metadata: {
					supported: false,
					reason: 'collect_artifacts_failed',
					error: error instanceof Error ? error.message : String(error),
				},
			}]),
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
