import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import { createExecutionProviderAdapter } from '../adapters/execution.ts';
import { LocalBranchMutationAdapter } from '../adapters/mutations.ts';
import { createNotificationAdapter } from '../adapters/notification.ts';
import { createOperationsAdapter } from '../adapters/operations.ts';
import { createRepositoryInspectionAdapter } from '../adapters/repository.ts';
import { createResearchAdapter } from '../adapters/research.ts';
import { createVerificationAdapter } from '../adapters/verification.ts';
import { resolveAgentHandler } from '../registry.ts';
import type {
	AgentContext,
	ExecutionProviderAdapter,
	AgentHandlerOutput,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentOperationsAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentTreeDxAdapter,
	AgentTriggerInvocation,
	AgentVerificationAdapter,
} from '../runtime-types.ts';
import {
	createAgentKernelModeFallback,
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
	normalizeAgentExecutionMode,
	validateAgentKernelModeExecutionInput,
	type AgentCapacityEnvelope,
	type AgentKernelModeDecision,
	type AgentKernelModeExecutionInput,
	type AgentKernelModeExecutionResult,
	type AgentKernelModeFallback,
	type AgentKernelQueueObservation,
	type AgentModeRunStatus,
	type DecisionExecutionInput,
} from '@treeseed/sdk/agent-capacity';
import type { AgentRunTrace, AgentErrorCategory } from '../contracts/run.ts';
import { AgentSdk } from '@treeseed/sdk/sdk';
import { followCursorKey, resolveTriggerDecision } from './trigger-resolver.ts';
import { loadActiveAgentSpecs, loadAllAgentSpecs, summarizeAgentSpec } from '../spec-loader.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { loadTreeseedDeployConfigFromPath } from '@treeseed/sdk/platform/deploy-config';
import { resolveAgentRuntimeProviders } from '../../agent-runtime.ts';
import { loadCoreObjectiveContext } from '../core-objective.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function nowIso() {
	return new Date().toISOString();
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateAssignmentOutputs(input: {
	mode: string;
	outputs?: Record<string, unknown> | null;
	allowedOutputs?: Record<string, unknown> | null;
}) {
	const allowed = record(input.allowedOutputs);
	if (!Object.keys(allowed).length) return { ok: true };
	const outputs = record(input.outputs);
	const allowedStatuses = Array.isArray(allowed.statuses) ? allowed.statuses.map(String) : [];
	const status = typeof outputs.status === 'string' ? outputs.status : null;
	if (allowedStatuses.length && (!status || !allowedStatuses.includes(status))) {
		return { ok: false, reason: `Output status ${status ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { status, allowedStatuses } };
	}
	const allowedTypes = Array.isArray(allowed.types) ? allowed.types.map(String) : [];
	const metadata = record(outputs.metadata);
	const outputType = typeof metadata.type === 'string'
		? metadata.type
		: typeof metadata.kind === 'string'
			? metadata.kind
			: null;
	if (allowedTypes.length && (!outputType || !allowedTypes.includes(outputType))) {
		return { ok: false, reason: `Output type ${outputType ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { outputType, allowedTypes } };
	}
	return { ok: true };
}

export interface AgentKernelModeRunTelemetryInput {
	status: AgentModeRunStatus;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: AgentCapacityEnvelope;
	outputs?: Record<string, unknown>;
	traceRefs?: Record<string, unknown>;
	usageActual?: Record<string, unknown> | null;
	validation?: Record<string, unknown>;
	fallbackReason?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	failedAt?: string | null;
	metadata?: Record<string, unknown>;
}

export interface AgentKernelAssignmentRunOptions extends AgentKernelModeExecutionInput {
	recordModeRun?: (run: AgentKernelModeRunTelemetryInput) => Promise<unknown>;
	recordFallbackOutput?: (output: Record<string, unknown>) => Promise<unknown>;
}

export class QueueObserver {
	observe(input: AgentKernelQueueObservation): AgentKernelQueueObservation {
		return {
			planningReady: Number(input.planningReady ?? 0),
			actingReady: Number(input.actingReady ?? 0),
			fallbackReady: Number(input.fallbackReady ?? 0),
			planningBudgetCredits: input.planningBudgetCredits ?? null,
			actingBudgetCredits: input.actingBudgetCredits ?? null,
			modePreference: input.modePreference ?? null,
			metadata: input.metadata ?? {},
		};
	}
}

export class PriorityResolver {
	resolve(observation: AgentKernelQueueObservation): AgentKernelQueueObservation {
		return observation;
	}
}

function selectKernelModeDecisionLocal(observation: AgentKernelQueueObservation): AgentKernelModeDecision {
	const planningReady = Math.max(0, Number(observation.planningReady ?? 0));
	const actingReady = Math.max(0, Number(observation.actingReady ?? 0));
	const fallbackReady = Math.max(0, Number(observation.fallbackReady ?? 0));
	const planningBudget = Number(observation.planningBudgetCredits ?? 0);
	const actingBudget = Number(observation.actingBudgetCredits ?? 0);
	const hasPlanningBudget = !Number.isFinite(planningBudget) || planningBudget > 0;
	const hasActingBudget = !Number.isFinite(actingBudget) || actingBudget > 0;
	if (observation.modePreference === 'planning' && planningReady > 0 && hasPlanningBudget) {
		return { kind: 'mode', mode: 'planning', reason: 'preferred_planning_ready', metadata: observation.metadata ?? {} };
	}
	if (observation.modePreference === 'acting' && actingReady > 0 && hasActingBudget) {
		return { kind: 'mode', mode: 'acting', reason: 'preferred_acting_ready', metadata: observation.metadata ?? {} };
	}
	if (actingReady > 0 && hasActingBudget) {
		return { kind: 'mode', mode: 'acting', reason: 'acting_queue_ready', metadata: observation.metadata ?? {} };
	}
	if (planningReady > 0 && hasPlanningBudget) {
		return { kind: 'mode', mode: 'planning', reason: 'planning_queue_ready', metadata: observation.metadata ?? {} };
	}
	if (fallbackReady > 0) {
		return { kind: 'fallback', mode: null, reason: 'fallback_queue_ready', metadata: observation.metadata ?? {} };
	}
	return { kind: 'idle', mode: null, reason: 'no_eligible_work', metadata: observation.metadata ?? {} };
}

export class ModeScheduler {
	constructor(
		private readonly observer = new QueueObserver(),
		private readonly priorityResolver = new PriorityResolver(),
	) {}

	decide(observation: AgentKernelQueueObservation): AgentKernelModeDecision {
		return selectKernelModeDecisionLocal(this.priorityResolver.resolve(this.observer.observe(observation)));
	}
}

export class FallbackController {
	buildOutput(input: { assignmentId: string; mode: string; fallback: AgentKernelModeFallback; projectId: string; metadata?: Record<string, unknown> }) {
		return {
			assignmentId: input.assignmentId,
			projectId: input.projectId,
			mode: input.mode,
			code: input.fallback.code,
			status: input.fallback.retryable ? 'draft' : 'suppressed',
			output: {
				summary: input.fallback.reason,
				type: input.mode === 'planning' ? 'planning_documentation_draft' : 'weakness_proposal_draft',
			},
			provenance: {
				source: 'agent_kernel_fallback',
				assignmentId: input.assignmentId,
			},
			quota: input.fallback.metadata?.quota ? { quota: input.fallback.metadata.quota } : {},
			metadata: input.metadata ?? {},
		};
	}
}

export class OutputValidator {
	validate(input: { mode: string; outputs?: Record<string, unknown> | null; allowedOutputs?: Record<string, unknown> | null }) {
		return validateAssignmentOutputs(input);
	}
}

function resolveExecutionRoot(tenantRoot: string) {
	const configPath = resolve(tenantRoot, 'treeseed.site.yaml');
	if (!existsSync(configPath)) {
		return tenantRoot;
	}
	const deployConfig = loadTreeseedDeployConfigFromPath(configPath) as {
		__projectRoot?: string;
	};
	return deployConfig.__projectRoot ?? tenantRoot;
}

export class AgentKernel {
	private readonly execution;
	private readonly executionOverride;
	private readonly providerSelections;
	private readonly mutations;
	private readonly repository;
	private readonly verification;
	private readonly notifications;
	private readonly research;
	private readonly operations;
	private readonly treeDx;
	private readonly scheduler;
	private readonly fallbackController;
	private readonly outputValidator;
	private readonly activeRuns = new Set<string>();
	private readonly lastRunAt = new Map<string, number>();
	private readonly tenantRoot;
	private readonly executionRoot;

	constructor(
		private readonly sdk: AgentSdk,
		repoRoot: string,
		options?: {
			executionRoot?: string;
			execution?: ExecutionProviderAdapter;
			mutations?: AgentMutationAdapter;
			repository?: AgentRepositoryInspectionAdapter;
			verification?: AgentVerificationAdapter;
			notifications?: AgentNotificationAdapter;
			research?: AgentResearchAdapter;
			operations?: AgentOperationsAdapter;
			treeDx?: AgentTreeDxAdapter | null;
			scheduler?: ModeScheduler;
			fallbackController?: FallbackController;
			outputValidator?: OutputValidator;
		},
	) {
		this.tenantRoot = repoRoot;
		this.executionRoot = options?.executionRoot ?? resolveExecutionRoot(repoRoot);
		this.providerSelections = getTreeseedAgentProviderSelections();
		const runtimeProviders = resolveAgentRuntimeProviders(this.executionRoot, this.providerSelections);
		this.executionOverride = options?.execution;
		this.execution = options?.execution ?? runtimeProviders.execution ?? createExecutionProviderAdapter(undefined, {
			repoRoot: this.executionRoot,
		});
		this.mutations = options?.mutations ?? runtimeProviders.mutations ?? new LocalBranchMutationAdapter(this.executionRoot);
		this.repository = options?.repository ?? runtimeProviders.repository ?? createRepositoryInspectionAdapter();
		this.verification = options?.verification ?? runtimeProviders.verification ?? createVerificationAdapter();
		this.notifications = options?.notifications ?? runtimeProviders.notifications ?? createNotificationAdapter();
		this.research = options?.research ?? runtimeProviders.research ?? createResearchAdapter();
		this.operations = options?.operations ?? createOperationsAdapter();
		this.treeDx = options?.treeDx ?? null;
		this.scheduler = options?.scheduler ?? new ModeScheduler();
		this.fallbackController = options?.fallbackController ?? new FallbackController();
		this.outputValidator = options?.outputValidator ?? new OutputValidator();
	}

	decideMode(observation: AgentKernelQueueObservation): AgentKernelModeDecision {
		return this.scheduler.decide(observation);
	}

	private executionForAgent(agent: AgentRuntimeSpec) {
		if (this.executionOverride) {
			return this.executionOverride;
		}
		const provider = agent.execution.provider ?? this.providerSelections.execution;
		if (provider === this.providerSelections.execution) {
			return this.execution;
		}
		return resolveAgentRuntimeProviders(this.executionRoot, {
			...this.providerSelections,
			execution: provider,
		}).execution;
	}

	async doctor() {
		const { specs, diagnostics } = await loadAllAgentSpecs(this.sdk);
		for (const agent of specs.filter((entry) => entry.enabled)) {
			await resolveAgentHandler(agent.handler, { tenantRoot: this.tenantRoot });
		}
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		return {
			agents: specs.map(summarizeAgentSpec),
			diagnostics,
		};
	}

	private sortAgents(agents: AgentRuntimeSpec[]) {
		const priority: Record<string, number> = {
			planner: 10,
			researcher: 20,
			architect: 30,
			engineer: 40,
			reviewer: 50,
			releaser: 60,
			notifier: 70,
		};
		return [...agents].sort(
			(left, right) => (priority[left.handler] ?? 100) - (priority[right.handler] ?? 100),
		);
	}

	private async resolveTrigger(agent: AgentRuntimeSpec, mode: 'auto' | 'manual' = 'auto') {
		const decision = await resolveTriggerDecision({
			agent,
			mode,
			isRunning: this.activeRuns.has(agent.slug),
			lastRunAt: this.lastRunAt.get(agent.slug),
			sdk: this.sdk.scopeForAgent(agent),
		});
		return decision.kind === 'ready' ? decision.invocation ?? null : null;
	}

	private async recordRunTrace(trace: AgentRunTrace) {
		await this.sdk.recordRun({ run: trace });
	}

	private buildTrace(
		agent: AgentRuntimeSpec,
		runId: string,
		trigger: AgentTriggerInvocation,
		overrides: Partial<AgentRunTrace>,
	): AgentRunTrace {
		return {
			runId,
			agentSlug: agent.slug,
			handlerKind: agent.handler,
			triggerKind: trigger.kind,
			triggerSource: trigger.source,
			claimedMessageId: trigger.message?.id ?? null,
			selectedItemKey: null,
			branchName: null,
			commitSha: null,
			changedPaths: [],
			summary: null,
			error: null,
			errorCategory: null,
			startedAt: nowIso(),
			finishedAt: null,
			status: 'running',
			...overrides,
		};
	}

	private categorizeError(error: unknown): AgentErrorCategory {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('not allowed')) {
			return 'permission_error';
		}
		if (message.includes('message')) {
			return 'message_claim_error';
		}
		if (message.includes('lease')) {
			return 'lease_error';
		}
		if (message.includes('commit') || message.includes('worktree') || message.includes('artifact')) {
			return 'mutation_error';
		}
		if (message.includes('Copilot') || message.includes('execution')) {
			return 'execution_error';
		}
		return 'sdk_error';
	}

	private async executeAgentInternal(
		agent: AgentRuntimeSpec,
		trigger: AgentTriggerInvocation,
		options: { capacity?: AgentContext['capacity']; treeDx?: AgentContext['treeDx'] } = {},
	): Promise<{ runId: string; output: AgentHandlerOutput }> {
		if (this.activeRuns.has(agent.slug)) {
			return {
				runId: '',
				output: {
					status: 'waiting',
					summary: `Agent ${agent.slug} is already running.`,
				},
			};
		}
		this.activeRuns.add(agent.slug);

		const runId = crypto.randomUUID();
		const handler = await resolveAgentHandler(agent.handler, { tenantRoot: this.tenantRoot });
		const scopedSdk = this.sdk.scopeForAgent(agent);
		const context: AgentContext = {
			runId,
			repoRoot: this.executionRoot,
			agent,
			capacity: options.capacity,
			coreObjective: loadCoreObjectiveContext(this.executionRoot),
			sdk: scopedSdk,
			trigger,
			execution: this.executionForAgent(agent),
			mutations: this.mutations,
			repository: this.repository,
			verification: this.verification,
			notifications: this.notifications,
			research: this.research,
			operations: this.operations,
			treeDx: options.treeDx ?? null,
		};

		await this.recordRunTrace(this.buildTrace(agent, runId, trigger, {}));

		try {
			const inputs = await handler.resolveInputs(context);
			const result = await handler.execute(context, inputs);
			const output = await handler.emitOutputs(context, result);

			if (trigger.message) {
				await scopedSdk.ackMessage({
					id: trigger.message.id,
					status:
						output.status === 'completed'
							? 'completed'
							: output.status === 'waiting'
								? 'pending'
								: 'failed',
				});
			}

			await this.recordRunTrace(
				this.buildTrace(agent, runId, trigger, {
					status: output.status,
					branchName: (output.metadata?.branchName as string | undefined) ?? null,
					commitSha: (output.metadata?.commitSha as string | undefined) ?? null,
					changedPaths: (output.metadata?.changedPaths as string[] | undefined) ?? [],
					summary: output.summary,
					error: output.status === 'failed' ? output.stderr ?? output.summary : null,
					errorCategory: output.status === 'failed' ? output.errorCategory ?? 'execution_error' : null,
					finishedAt: nowIso(),
				}),
			);
			await this.sdk.upsertCursor({
				agentSlug: agent.slug,
				cursorKey: 'last_run_at',
				cursorValue: nowIso(),
			});
			if (trigger.kind === 'follow') {
				await this.sdk.upsertCursor({
					agentSlug: agent.slug,
					cursorKey: followCursorKey(trigger.followModels),
					cursorValue: nowIso(),
				});
			}
			this.lastRunAt.set(agent.slug, Date.now());
			return { runId, output };
		} catch (error) {
			if (trigger.message) {
				await scopedSdk.ackMessage({
					id: trigger.message.id,
					status: 'failed',
				});
			}
			await this.recordRunTrace(
				this.buildTrace(agent, runId, trigger, {
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					errorCategory: this.categorizeError(error),
					finishedAt: nowIso(),
				}),
			);
			throw error;
		} finally {
			this.activeRuns.delete(agent.slug);
		}
	}

	private async executeAgent(agent: AgentRuntimeSpec, trigger: AgentTriggerInvocation) {
		return (await this.executeAgentInternal(agent, trigger)).output;
	}

	private async recordAssignmentModeRun(
		options: AgentKernelAssignmentRunOptions,
		run: AgentKernelModeRunTelemetryInput,
	) {
		if (!options.recordModeRun) return null;
		return options.recordModeRun(run);
	}

	private async boundedAssignmentResult(
		options: AgentKernelAssignmentRunOptions,
		fallback: AgentKernelModeFallback,
		status: AgentKernelModeExecutionResult['status'] = fallback.retryable ? 'returned' : 'failed',
	): Promise<AgentKernelModeExecutionResult> {
		const assignment = options.assignment;
		const mode = normalizeAgentExecutionMode(assignment.mode);
		const capacityEnvelope = options.capacityEnvelope ?? deriveAgentCapacityEnvelopeFromAssignment(assignment);
		const decisionInput = options.decisionInput ?? deriveDecisionExecutionInputFromAssignment(assignment);
		const selectedInput = decisionInput.input;
		const timestamp = nowIso();
		await this.recordAssignmentModeRun(options, {
			status: status === 'failed' ? 'failed' : 'cancelled',
			selectedInput,
			capacityEnvelope,
			outputs: {
				status,
				summary: fallback.reason,
			},
			validation: {
				code: fallback.code,
				retryable: fallback.retryable,
				...(fallback.metadata ?? {}),
			},
			fallbackReason: fallback.reason,
			failedAt: status === 'failed' ? timestamp : null,
			completedAt: status !== 'failed' ? timestamp : null,
			metadata: {
				source: 'agent_kernel_mode_runtime',
				assignmentId: assignment.id,
				runnerId: options.runnerId ?? null,
			},
		});
		if (options.recordFallbackOutput) {
			await options.recordFallbackOutput(this.fallbackController.buildOutput({
				assignmentId: assignment.id,
				projectId: assignment.projectId,
				mode,
				fallback,
				metadata: {
					status,
					runnerId: options.runnerId ?? null,
				},
			}));
		}
		return {
			status,
			mode,
			assignmentId: assignment.id,
			projectId: assignment.projectId,
			projectAgentClassId: assignment.projectAgentClassId,
			agentId: decisionInput.agentId ?? assignment.agentId ?? null,
			handlerId: decisionInput.handlerId ?? assignment.handlerId ?? null,
			summary: fallback.reason,
			outputs: {
				status,
				summary: fallback.reason,
			},
			selectedInput,
			capacityEnvelope,
			traceRefs: {},
			fallback,
			metadata: {
				source: 'agent_kernel_mode_runtime',
			},
		};
	}

	private isAssignmentReadyForActing(readiness: Record<string, unknown> | null | undefined): boolean {
		if (!readiness) return false;
		const executionReadiness = readiness.executionReadiness;
		const planningInputsStatus = readiness.planningInputsStatus;
		return (executionReadiness === 'ready' || executionReadiness === 'waived')
			&& (planningInputsStatus === 'complete' || planningInputsStatus === 'waived');
	}

	async runAssignment(options: AgentKernelAssignmentRunOptions): Promise<AgentKernelModeExecutionResult> {
		const assignment = options.assignment;
		const mode = normalizeAgentExecutionMode(assignment.mode);
		const capacityEnvelope = options.capacityEnvelope ?? deriveAgentCapacityEnvelopeFromAssignment(assignment);
		const decisionInput = options.decisionInput ?? deriveDecisionExecutionInputFromAssignment(assignment);
		const validationFallback = validateAgentKernelModeExecutionInput({
			...options,
			capacityEnvelope,
			decisionInput,
			readiness: options.readiness ?? null,
			treedxProxyHandle: options.treedxProxyHandle ?? assignment.treedxProxyHandle ?? null,
		});
		if (validationFallback) {
			return this.boundedAssignmentResult(options, validationFallback);
		}
		if (mode === 'acting' && options.readiness && !this.isAssignmentReadyForActing(options.readiness as Record<string, unknown>)) {
			return this.boundedAssignmentResult(options, createAgentKernelModeFallback(
				'assignment_decision_not_ready',
				`Assignment ${assignment.id} is not ready for acting execution.`,
				{ retryable: true, metadata: { readiness: options.readiness } },
			));
		}

		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			return this.boundedAssignmentResult(options, createAgentKernelModeFallback(
				'assignment_agent_not_found',
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
				{ retryable: false },
			), 'failed');
		}
		const agents = this.sortAgents(specs);
		const agentSlug = decisionInput.agentId ?? assignment.agentId;
		const agent = agentSlug ? agents.find((entry) => entry.slug === agentSlug) : null;
		if (!agent) {
			return this.boundedAssignmentResult(options, createAgentKernelModeFallback(
				'assignment_agent_not_found',
				`Agent ${agentSlug ?? '<missing>'} is not enabled or was not found in project ${assignment.projectId}.`,
				{ retryable: false },
			), 'failed');
		}

		const trigger: AgentTriggerInvocation = {
			kind: 'manual',
			source: `capacity-provider-assignment:${mode}`,
			trigger: { type: 'startup' },
		};
		const startedAt = nowIso();
		await this.recordAssignmentModeRun(options, {
			status: 'running',
			selectedInput: decisionInput.input,
			capacityEnvelope,
			startedAt,
			validation: {
				mode,
				projectAgentClassId: assignment.projectAgentClassId,
			},
			metadata: {
				source: 'agent_kernel_mode_runtime',
				assignmentId: assignment.id,
				runnerId: options.runnerId ?? null,
			},
		});

		try {
			const executed = await this.executeAgentInternal(agent, trigger, {
				capacity: {
					assignmentId: assignment.id,
					providerId: assignment.capacityProviderId,
					mode,
					envelope: capacityEnvelope,
					decisionInput,
					projectAgentClass: options.projectAgentClass ?? null,
					kernelProfile: options.kernelProfile ?? options.projectAgentClass?.kernelProfile ?? null,
					kernelPolicy: options.kernelPolicy ?? options.projectAgentClass?.kernelPolicy ?? null,
					assignment,
					readiness: options.readiness ?? null,
					treedxProxyHandle: options.treedxProxyHandle ?? assignment.treedxProxyHandle ?? null,
					capabilityHandles: assignment.capabilityHandles ?? assignment.workspaceContext?.capabilityHandles ?? null,
					workspaceAccessMode: assignment.capabilityHandles?.workspaceAccessMode ?? assignment.workspaceContext?.workspaceAccessMode ?? null,
					fallbackReason: null,
				},
				treeDx: this.treeDx,
			});
			const outputValidation = this.outputValidator.validate({
				mode,
				outputs: {
					status: executed.output.status,
					metadata: executed.output.metadata ?? {},
				},
				allowedOutputs: assignment.allowedOutputs ?? null,
			});
			if (!outputValidation.ok) {
				return this.boundedAssignmentResult(options, createAgentKernelModeFallback(
					'assignment_output_invalid',
					outputValidation.reason ?? 'Agent output is not allowed for this assignment.',
					{ retryable: false, metadata: outputValidation.metadata },
				), 'failed');
			}
			const completedAt = nowIso();
			const outputStatus = executed.output.status;
			const modeRunStatus: AgentModeRunStatus = outputStatus === 'completed'
				? 'succeeded'
				: outputStatus === 'failed'
					? 'failed'
					: 'cancelled';
			const fallback = outputStatus === 'waiting'
				? createAgentKernelModeFallback(
					'assignment_missing_decision_input',
					executed.output.summary,
					{ retryable: true },
				)
				: null;
			await this.recordAssignmentModeRun(options, {
				status: modeRunStatus,
				selectedInput: decisionInput.input,
				capacityEnvelope,
				outputs: {
					status: outputStatus,
					summary: executed.output.summary,
					stdout: executed.output.stdout ?? null,
					stderr: executed.output.stderr ?? null,
					metadata: executed.output.metadata ?? {},
				},
				traceRefs: {
					agentRunId: executed.runId,
					agentSlug: agent.slug,
					handlerKind: agent.handler,
				},
				fallbackReason: fallback?.reason ?? null,
				completedAt: modeRunStatus === 'succeeded' ? completedAt : null,
				failedAt: modeRunStatus === 'failed' ? completedAt : null,
				metadata: {
					source: 'agent_kernel_mode_runtime',
					assignmentId: assignment.id,
					runnerId: options.runnerId ?? null,
				},
			});
			return {
				status: outputStatus === 'completed'
					? 'completed'
					: outputStatus === 'failed'
						? 'failed'
						: 'returned',
				mode,
				assignmentId: assignment.id,
				projectId: assignment.projectId,
				projectAgentClassId: assignment.projectAgentClassId,
				agentId: agent.slug,
				handlerId: String(agent.handler),
				summary: executed.output.summary,
				outputs: {
					status: outputStatus,
					summary: executed.output.summary,
					stdout: executed.output.stdout ?? null,
					stderr: executed.output.stderr ?? null,
					metadata: executed.output.metadata ?? {},
				},
				selectedInput: decisionInput.input,
				capacityEnvelope,
				traceRefs: {
					agentRunId: executed.runId,
					agentSlug: agent.slug,
					handlerKind: agent.handler,
				},
				fallback,
				metadata: {
					source: 'agent_kernel_mode_runtime',
					startedAt,
					completedAt,
				},
			};
		} catch (error) {
			return this.boundedAssignmentResult(options, createAgentKernelModeFallback(
				'assignment_handler_failed',
				error instanceof Error ? error.message : String(error),
				{ retryable: false },
			), 'failed');
		}
	}

	async runAgent(slug: string, mode: 'auto' | 'manual' = 'manual', invocation?: AgentTriggerInvocation | null) {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const agent = agents.find((entry) => entry.slug === slug);
		if (!agent) {
			throw new Error(`Unknown or disabled agent "${slug}".`);
		}
		const trigger = invocation ?? await this.resolveTrigger(agent, mode);
		if (!trigger) {
			return {
				status: 'waiting',
				summary: `No runnable trigger found for ${slug}.`,
			};
		}
		return this.executeAgent(agent, trigger);
	}

	async runCycle() {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const results = [];
		for (const agent of agents) {
			const runsThisCycle = agent.triggerPolicy?.maxRunsPerCycle ?? 1;
			for (let index = 0; index < runsThisCycle; index += 1) {
				const trigger = await this.resolveTrigger(agent, 'auto');
				if (!trigger) {
					break;
				}
				results.push({
					slug: agent.slug,
					result: await this.executeAgent(agent, trigger),
				});
			}
		}
		return results;
	}

	async start(intervalMs = Number(process.env.TREESEED_AGENT_SUPERVISOR_INTERVAL_MS ?? 60000)) {
		await this.runCycle();
		setInterval(() => {
			void this.runCycle();
		}, intervalMs);
	}

	async drainMessages() {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const messageAgents = agents.filter((agent) =>
			agent.triggers.some((trigger) => trigger.type === 'message'),
		);
		const results = [];
		for (const agent of messageAgents) {
			results.push({
				slug: agent.slug,
				result: await this.runAgent(agent.slug, 'auto'),
			});
		}
		return results;
	}

	releaseLeases() {
		return this.sdk.releaseAllLeases();
	}

	async replayMessage(id: number) {
		await this.sdk.ackMessage({
			id,
			status: 'pending',
		});
		return {
			id,
			status: 'pending',
		};
	}
}
