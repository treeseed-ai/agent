#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import type { AgentContext, AgentHandler } from '../agents/runtime-types.ts';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import { loadCoreObjectiveContext } from '../agents/core-objective.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import { createControlPlaneReporter, shouldInterruptForCapacity } from '@treeseed/sdk';
import type { CapacityTaskExecutionEnvelope, TaskCheckpointArtifact } from '@treeseed/sdk';
import { isDirectEntrypoint } from '../entrypoint.ts';
import { buildTaskContext, createServiceSdk, resolveServiceRepoRoot, resolveWorkerConfig } from './common.ts';
import { researchHandler } from '../agents/handlers/research.ts';
import { knowledgeGeneratorHandler } from '../agents/handlers/knowledge-generator.ts';
import { knowledgeOptimizerHandler } from '../agents/handlers/knowledge-optimizer.ts';
import { createVerificationAdapter } from '../agents/adapters/verification.ts';
import { createExecutionProviderAdapter } from '../agents/adapters/execution.ts';
import { LocalBranchMutationAdapter } from '../agents/adapters/mutations.ts';
import { createNotificationAdapter } from '../agents/adapters/notification.ts';
import { createOperationsAdapter } from '../agents/adapters/operations.ts';
import { createRepositoryInspectionAdapter } from '../agents/adapters/repository.ts';
import { createResearchAdapter } from '../agents/adapters/research.ts';
import {
	normalizeCodexDocsMutationInput,
	runCodexDocsMutationLifecycle,
	type CodexDocsMutationDependencies,
} from '../agents/implementation/codex-docs-mutation.ts';
import type { KnowledgeDraft, OptimizationReport } from '../agents/contracts/knowledge.ts';
import type { ResearchNote } from '../agents/contracts/research.ts';
import {
	agentSpecForResearchKnowledgeHandler,
	followupTaskIdempotencyKey,
	graphVersionForTask,
	invocationForResearchKnowledgeTask,
	isResearchKnowledgeTaskKind,
	loadLatestCodebaseInventoryForWorkday,
	summarizeKnowledgeDraftArtifact,
	summarizeDocsMutationResultArtifact,
	summarizeOptimizationReportArtifact,
	summarizePromotionRequestArtifact,
	summarizeReleaseRequestArtifact,
	summarizeResearchNoteArtifact,
	taskPayload,
	taskRecordId,
	workDayIdForTask,
	type ResearchKnowledgeTaskKind,
	type ResearchKnowledgeTaskOutputEnvelope,
} from './research-knowledge-workday.ts';
import {
	defaultReleaseGrant,
	type KnowledgePromotionDependencies,
	normalizeKnowledgePromotionTaskInput,
	runKnowledgePromotionToStaging,
} from './knowledge-promotion.ts';
import { persistPromotionApprovalRequest } from './governance-approvals.ts';
import {
	CODEBASE_DOCUMENTATION_SCAN_TASK_KIND,
	scanCodebaseDocumentationSurface,
	summarizeCodebaseInventoryArtifact,
	type KnowledgeGap,
} from './codebase-documentation-scanner.ts';
import { admissionForTaskProposal } from './task-admission.ts';
import { buildPlanningProposalFromTask } from './task-planning.ts';
import type { WorkdayPolicy } from '@treeseed/sdk';
import { resolveRunnerRepositoryPaths, resolveRunnerWorkspaceRoot } from './runtime-paths.ts';

function parseTaskPayload(task: Record<string, unknown> | null) {
	const raw = typeof task?.payloadJson === 'string' ? task.payloadJson : '{}';
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function taskEnvelopeForTask(task: Record<string, unknown>) {
	return {
		taskId: String(task.id ?? ''),
		workDayId: String(task.workDayId ?? task.work_day_id ?? ''),
		agentId: String(task.agentId ?? task.agent_id ?? ''),
		taskType: String(task.type ?? ''),
		idempotencyKey: String(task.idempotencyKey ?? task.idempotency_key ?? ''),
		attempt: Number(task.attemptCount ?? task.attempt_count ?? 0) + 1,
		graphVersion:
			task.graphVersion !== undefined && task.graphVersion !== null
				? String(task.graphVersion)
				: task.graph_version !== undefined && task.graph_version !== null
					? String(task.graph_version)
					: null,
	};
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function docsMutationExecutionDisabled() {
	const mode = process.env.TREESEED_DOCS_AUTOMATION_MODE?.trim();
	return mode === 'dry-run' || mode === 'off';
}

function booleanFromEnv(name: string, fallback = false) {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value);
}

function readCapacityEnvelope(payload: Record<string, unknown>): CapacityTaskExecutionEnvelope | null {
	const envelope = asRecord(payload.capacityEnvelope);
	return Object.keys(envelope).length > 0 ? envelope as CapacityTaskExecutionEnvelope : null;
}

function readExecutionProfileId(payload: Record<string, unknown>, fallback = 'standard-code-model') {
	const direct = readString(payload.executionProfileId);
	if (direct) return direct;
	const profile = asRecord(payload.executionProfile);
	const profileId = readString(profile.id);
	if (profileId) return profileId;
	const envelope = asRecord(payload.capacityEnvelope);
	const envelopeMetadata = asRecord(envelope.metadata);
	const envelopeProfile = readString(envelopeMetadata.executionProfileId);
	if (envelopeProfile) return envelopeProfile;
	const capacity = asRecord(payload.capacity);
	const capacityProfile = readString(capacity.executionProfileId);
	return capacityProfile || fallback;
}

function readAttentionEstimate(payload: Record<string, unknown>) {
	const direct = asRecord(payload.attentionEstimate);
	const envelope = asRecord(payload.capacityEnvelope);
	const envelopeMetadata = asRecord(envelope.metadata);
	const envelopeAttention = asRecord(envelopeMetadata.attentionEstimate);
	const capacityRoute = asRecord(payload.capacityRoute);
	const routeAttention = asRecord(capacityRoute.attentionEstimate);
	const candidate = Object.keys(direct).length > 0
		? direct
		: Object.keys(envelopeAttention).length > 0
			? envelopeAttention
			: routeAttention;
	return Object.keys(candidate).length > 0 ? candidate : null;
}

function readUtilityEstimate(payload: Record<string, unknown>) {
	const direct = asRecord(payload.utilityEstimate);
	const envelope = asRecord(payload.capacityEnvelope);
	const envelopeMetadata = asRecord(envelope.metadata);
	const envelopeUtility = asRecord(envelopeMetadata.utilityEstimate);
	const capacityRoute = asRecord(payload.capacityRoute);
	const routeUtility = asRecord(capacityRoute.utilityEstimate);
	const candidate = Object.keys(direct).length > 0
		? direct
		: Object.keys(envelopeUtility).length > 0
			? envelopeUtility
			: routeUtility;
	return Object.keys(candidate).length > 0 ? candidate : null;
}

function readHybridExecutionPlan(payload: Record<string, unknown>) {
	const direct = asRecord(payload.hybridExecutionPlan);
	const envelope = asRecord(payload.capacityEnvelope);
	const envelopeMetadata = asRecord(envelope.metadata);
	const envelopeHybrid = asRecord(envelopeMetadata.hybridExecutionPlan);
	const capacityRoute = asRecord(payload.capacityRoute);
	const routeHybrid = asRecord(capacityRoute.hybridExecutionPlan);
	const candidate = Object.keys(direct).length > 0
		? direct
		: Object.keys(envelopeHybrid).length > 0
			? envelopeHybrid
			: routeHybrid;
	return Object.keys(candidate).length > 0 ? candidate : null;
}

function readCapacityMetadata(payload: Record<string, unknown>) {
	const capacity = asRecord(payload.capacity);
	const providerId = typeof capacity.providerId === 'string' ? capacity.providerId : null;
	const laneId = typeof capacity.laneId === 'string' ? capacity.laneId : null;
	if (!providerId || !laneId) return null;
	return {
		providerId,
		laneId,
		grantId: typeof capacity.grantId === 'string' ? capacity.grantId : null,
		reservationId: typeof capacity.reservationId === 'string' ? capacity.reservationId : null,
		routingDecisionId: typeof capacity.routingDecisionId === 'string' ? capacity.routingDecisionId : null,
		estimatedCreditsP50: Number.isFinite(Number(capacity.estimatedCreditsP50)) ? Number(capacity.estimatedCreditsP50) : null,
		estimatedCreditsP90: Number.isFinite(Number(capacity.estimatedCreditsP90)) ? Number(capacity.estimatedCreditsP90) : null,
		reservedCredits: Number.isFinite(Number(capacity.reservedCredits)) ? Number(capacity.reservedCredits) : null,
		executionProfileId: readExecutionProfileId(payload),
		attentionEstimate: readAttentionEstimate(payload),
		utilityEstimate: readUtilityEstimate(payload),
		hybridExecutionPlan: readHybridExecutionPlan(payload),
	};
}

async function emitKnowledgeGapMessages(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	inventoryId: string;
	gaps: KnowledgeGap[];
	maxMessages: number;
}) {
	const createMessage = (input.sdk as unknown as {
		createMessage?: (request: {
			type: string;
			payload: Record<string, unknown>;
			relatedModel?: string | null;
			relatedId?: string | null;
			priority?: number;
			maxAttempts?: number;
			actor: string;
		}) => Promise<unknown>;
	}).createMessage;
	if (typeof createMessage !== 'function') return 0;
	const selected = input.gaps
		.filter((gap) => gap.severity === 'high' || gap.severity === 'medium')
		.slice(0, Math.max(0, input.maxMessages));
	for (const gap of selected) {
		await createMessage.call(input.sdk, {
			type: 'knowledge_gap_detected',
			payload: {
				gapId: gap.id,
				surfacePath: gap.surfacePath,
				surfaceKind: gap.surfaceKind,
				severity: gap.severity,
				summary: gap.summary,
				recommendedTaskKind: gap.recommendedTaskKind,
				sourcePaths: gap.sourcePaths,
			},
			relatedModel: 'codebase_inventory',
			relatedId: input.inventoryId,
			priority: gap.severity === 'high' ? 90 : 70,
			maxAttempts: 3,
			actor: 'worker',
		});
	}
	return selected.length;
}

function lowConfidenceResult(output: Record<string, unknown>) {
	const result = asRecord(output.result);
	return result.insufficientConfidence === true
		|| result.confidence === 'low'
		|| asRecord(output.summary).confidence === 'low';
}

function defaultWorkerAdmissionPolicy(projectId: string): WorkdayPolicy {
	return {
		projectId: projectId || 'project',
		environment: 'local',
		enabled: true,
		schedule: { timezone: 'UTC', windows: [] },
		startCron: '0 9 * * 1-5',
		durationMinutes: 480,
		maxRunners: 1,
		maxWorkersPerRunner: 1,
		dailyCreditBudget: 100,
		closeoutGraceMinutes: 10,
		dailyTaskCreditBudget: 100,
		maxQueuedTasks: 10,
		maxQueuedCredits: 100,
		autoscale: { minWorkers: 0, maxWorkers: 1, targetQueueDepth: 1, cooldownSeconds: 60 },
		creditWeights: [],
		metadata: {
			reserveBufferPercent: 10,
			recoveryBudgetCredits: 5,
			planningThresholdCredits: 20,
			approvalThresholdCredits: 50,
			maxDownstreamTasks: 5,
		},
	};
}

async function createHybridEscalationTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	task: Record<string, unknown> | null;
	taskId: string;
	output: Record<string, unknown>;
	payload: Record<string, unknown>;
	workerId: string;
}) {
	if (!lowConfidenceResult(input.output)) return;
	const hybridPlan = readHybridExecutionPlan(input.payload);
	const phases = Array.isArray(hybridPlan?.phases) ? hybridPlan.phases.map(asRecord) : [];
	const phase = phases.find((entry) => entry.kind === 'review') ?? phases.find((entry) => entry.kind === 'human_escalation');
	if (!phase) return;
	const workDayId = readString(input.task?.workDayId ?? input.task?.work_day_id);
	if (!workDayId) return;
	const taskSignature = readString(phase.taskSignature) || (phase.kind === 'human_escalation' ? 'human.review_escalation' : 'review.verify');
	const executionProfileId = readString(phase.executionProfileId) || 'cheap-review-model';
	const payload = {
		taskSignature,
		executionProfileId,
		hybridExecutionPlan: hybridPlan,
		hybridPhase: phase,
		parentTaskId: input.taskId,
		sourceOutput: input.output,
		reason: 'insufficient_confidence',
		requiresApproval: phase.kind === 'human_escalation',
		createdBy: input.workerId,
	};
	const admission = admissionForTaskProposal({
		type: 'hybrid_escalation',
		payload,
		workDay: {
			id: workDayId,
			capacityBudget: Number(input.payload.capacityBudget ?? 100),
			capacityUsed: Number(input.payload.capacityUsed ?? 0),
		},
		policy: defaultWorkerAdmissionPolicy(String(process.env.TREESEED_PROJECT_ID ?? 'project')),
		capacityPlan: null,
		queuedCredits: 0,
		source: 'worker.hybrid_escalation',
	});
	const created = await input.sdk.createTask({
		workDayId,
		agentId: readString(input.payload.escalationAgentId) || 'reviewer',
		type: 'hybrid_escalation',
		state: admission.state,
		priority: Math.max(1, Number(input.task?.priority ?? 50)),
		idempotencyKey: `${workDayId}:hybrid_escalation:${input.taskId}:${String(phase.id ?? phase.kind ?? 'review')}`,
		payload: admission.payload,
		graphVersion: typeof input.task?.graphVersion === 'string' ? input.task.graphVersion : null,
		parentTaskId: input.taskId,
		actor: 'worker',
	});
	if (created.payload) {
		const createdTaskId = readString(created.payload.id);
		await input.sdk.recordTaskProgress({
			id: createdTaskId,
			state: admission.state,
			appendEvent: {
				kind: 'classified',
				data: admission.classification as unknown as Record<string, unknown>,
			},
			actor: 'worker',
		});
		await input.sdk.recordTaskProgress({
			id: createdTaskId,
			state: admission.state,
			appendEvent: {
				kind: 'admission_decided',
				data: admission.admission as unknown as Record<string, unknown>,
			},
			actor: 'worker',
		});
		if (admission.admission.outcome === 'budget_blocked' || admission.admission.outcome === 'deferred') {
			await input.sdk.recordTaskProgress({
				id: createdTaskId,
				state: admission.state,
				appendEvent: {
					kind: 'deferred_for_budget',
					data: admission.admission as unknown as Record<string, unknown>,
				},
				actor: 'worker',
			});
		}
		await input.sdk.recordTaskProgress({
			id: input.taskId,
			workerId: input.workerId,
			appendEvent: {
				kind: 'hybrid_escalation_created',
				data: {
					taskId: createdTaskId,
					taskSignature,
					executionProfileId,
					admissionOutcome: admission.admission.outcome,
					reason: 'insufficient_confidence',
				},
			},
			actor: 'worker',
		});
	}
}

function runnerRepositoryPath(volumeRoot: string, repositoryId: string, taskId: string) {
	return resolveRunnerRepositoryPaths({ volumeRoot, repositoryId, taskId });
}

function runnerComposedWorkspacePath(volumeRoot: string, hubId: string) {
	const workspaceRoot = resolveRunnerWorkspaceRoot(volumeRoot, hubId);
	return {
		root: workspaceRoot,
		parent: join(workspaceRoot, 'workspace-root'),
		site: join(workspaceRoot, 'site'),
		content: join(workspaceRoot, 'content'),
		manifest: join(workspaceRoot, '.treeseed', 'workspace.json'),
	};
}

async function ensureRunnerComposedWorkspace(volumeRoot: string, task: Record<string, unknown>) {
	const payload = parseTaskPayload(task);
	const workspace = asRecord(payload.workspace);
	const hubId = String(workspace.hubId ?? payload.projectId ?? task.projectId ?? '').trim();
	if (!hubId) return null;
	const paths = runnerComposedWorkspacePath(volumeRoot, hubId);
	await mkdir(paths.parent, { recursive: true });
	await mkdir(paths.site, { recursive: true });
	await mkdir(paths.content, { recursive: true });
	await mkdir(join(paths.root, '.treeseed'), { recursive: true });
	await writeFile(paths.manifest, `${JSON.stringify({
		schemaVersion: 1,
		kind: 'treeseed_composed_workspace',
		hubId,
		softwareRepository: workspace.softwareRepository ?? null,
		contentRepository: workspace.contentRepository ?? null,
		parentRepository: workspace.parentRepository ?? null,
		paths: {
			workspaceRoot: paths.parent,
			site: paths.site,
			content: paths.content,
		},
		allowedWriteTargets: Array.isArray(workspace.allowedWriteTargets) ? workspace.allowedWriteTargets : ['content'],
		credentialSessionScopes: workspace.credentialSessionScopes ?? {
			software: ['repository:software'],
			content: ['repository:content'],
			parentWorkspace: [],
		},
		credentialScopes: workspace.credentialScopes ?? {
			software: ['repository:software'],
			content: ['repository:content'],
			parentWorkspace: [],
		},
		contentOverlay: workspace.contentOverlay ?? 'src_content_when_present',
	}, null, 2)}\n`, 'utf8');
	return paths;
}

class WorkerPausedForApproval extends Error {
	constructor(readonly request: Record<string, unknown>) {
		super(String(request.summary ?? request.title ?? 'Task paused for approval.'));
	}
}

class WorkerCapacityInterrupted extends Error {
	constructor(readonly request: Record<string, unknown>) {
		super(String(request.summary ?? 'Task interrupted by capacity policy.'));
	}
}

function baseAgentContext(input: {
	runId: string;
	repoRoot: string;
	agent: AgentRuntimeSpec;
	sdk: ReturnType<typeof createServiceSdk>;
	trigger: AgentTriggerInvocation;
}): AgentContext {
	return {
		runId: input.runId,
		repoRoot: input.repoRoot,
		agent: input.agent,
		coreObjective: loadCoreObjectiveContext(input.repoRoot),
		sdk: input.sdk.scopeForAgent(input.agent),
		trigger: input.trigger,
		execution: createExecutionProviderAdapter(undefined, { repoRoot: input.repoRoot }),
		mutations: new LocalBranchMutationAdapter(input.repoRoot),
		repository: createRepositoryInspectionAdapter(),
		verification: createVerificationAdapter(),
		notifications: createNotificationAdapter(),
		research: createResearchAdapter(),
		operations: createOperationsAdapter(),
	};
}

function contextForResearchKnowledgeHandler(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	repoRoot: string;
	kind: 'research' | 'knowledge_draft' | 'knowledge_optimization';
	payload: Record<string, unknown>;
}) {
	const agent = agentSpecForResearchKnowledgeHandler(input.kind);
	return baseAgentContext({
		runId: `${input.kind}-${Date.now()}`,
		repoRoot: input.repoRoot,
		agent,
		trigger: invocationForResearchKnowledgeTask(
			input.kind === 'research'
				? 'research_question'
				: input.kind === 'knowledge_draft'
					? 'generate_knowledge_draft'
					: 'optimize_knowledge_draft',
			input.payload,
		),
		sdk: input.sdk,
	});
}

function contextForDocsMutationHandler(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	repoRoot: string;
	payload: Record<string, unknown>;
	taskId: string;
}) {
	const agent: AgentRuntimeSpec = {
		slug: 'treeseed-docs-engineer',
		handler: 'act',
		projectAgentClassId: 'implementation',
		projectAgentClassSlug: 'implementation',
		handlerConfig: { domain: 'documentation_mutation' },
		enabled: true,
		systemPrompt: 'Apply approved TreeSeed documentation mutations inside governed worktrees.',
		persona: 'Careful documentation engineer.',
		cli: {},
		triggers: [{ type: 'message', messageTypes: ['apply_approved_docs_mutation'] }],
		permissions: [
			{ model: 'approval', operations: ['get', 'update'] },
			{ model: 'task', operations: ['get', 'update', 'create'] },
			{ model: 'message', operations: ['create', 'update', 'pick'] },
		],
		execution: {
			maxConcurrency: 1,
			timeoutSeconds: 1800,
			cooldownSeconds: 0,
			leaseSeconds: 600,
			retryLimit: 0,
			branchPrefix: 'agent/docs-mutation',
			providerProfile: {
				requiredCapabilities: ['workspace.write', 'treedx.write', 'docs.mutate'],
				preferredLanes: [],
				acceptableFallbacks: [],
				fallbackPolicy: 'allow_substitution',
			},
		},
		outputs: { messageTypes: [], modelMutations: [] },
		context: {
			queries: [{
				id: 'docs-mutation',
				purpose: 'documentation mutation',
				query: 'approved documentation mutation',
				scope: '/',
				codeScopes: ['src/content', 'docs'],
			}],
		},
	};
	return baseAgentContext({
		runId: input.taskId,
		repoRoot: input.repoRoot,
		agent,
		trigger: invocationForResearchKnowledgeTask('apply_approved_docs_mutation', input.payload),
		sdk: input.sdk,
	});
}

async function runBuiltInHandler<TInputs, TResult>(
	handler: AgentHandler<TInputs, TResult>,
	context: AgentContext,
) {
	const inputs = await handler.resolveInputs(context);
	const result = await handler.execute(context, inputs);
	const output = await handler.emitOutputs(context, result);
	return { result, output };
}

async function createFollowupTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	workDayId: string;
	agentId: string;
	type: ResearchKnowledgeTaskKind;
	priority: number;
	idempotencyKey: string;
	payload: Record<string, unknown>;
	graphVersion: string | null;
	enqueue: boolean;
}) {
	const created = await input.sdk.createTask({
		workDayId: input.workDayId,
		agentId: input.agentId,
		type: input.type,
		priority: input.priority,
		idempotencyKey: input.idempotencyKey,
		payload: input.payload,
		graphVersion: input.graphVersion,
		state: input.enqueue ? undefined : 'waiting',
		actor: 'worker',
	});
	const createdTask = asRecord(created.payload);
	const createdTaskId = readString(createdTask.id);
	if (createdTaskId && input.enqueue) {
		await input.sdk.recordTaskProgress({
			id: createdTaskId,
			state: 'waiting',
			appendEvent: {
				kind: 'assignment_ready',
				data: { transport: 'api_assignment' },
			},
			actor: 'worker',
		});
	}
	return createdTaskId || null;
}

async function createRepairFollowupTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	workDayId: string;
	graphVersion: string | null;
	sourceTaskId: string;
	repairTask: Record<string, unknown>;
	failureKind: 'verification' | 'merge' | 'implementation';
	enqueue?: boolean;
}) {
	const idempotencyKey = `${input.workDayId}:create_repair_task:${input.failureKind}:${input.sourceTaskId}`;
	return await createFollowupTask({
		sdk: input.sdk,
		workDayId: input.workDayId,
		agentId: 'treeseed-docs-engineer',
		type: 'create_repair_task',
		priority: 70,
		idempotencyKey,
		payload: {
			executionKind: 'research_knowledge_pipeline',
			taskKind: 'create_repair_task',
			repairTask: input.repairTask,
			sourceTaskId: input.sourceTaskId,
			failureKind: input.failureKind,
		},
		graphVersion: input.graphVersion,
		enqueue: input.enqueue ?? false,
	});
}

function mutationSummaryStatus(status: unknown): ResearchKnowledgeTaskOutputEnvelope['summary']['status'] {
	if (status === 'staged' || status === 'completed') return 'completed';
	if (status === 'waiting') return 'waiting';
	return 'failed';
}

function envelope(input: Omit<ResearchKnowledgeTaskOutputEnvelope, 'summary'> & {
	status: ResearchKnowledgeTaskOutputEnvelope['summary']['status'];
	summary: string;
}) {
	return {
		...input,
		summary: {
			status: input.status,
			summary: input.summary,
		},
	};
}

function buildCheckpointArtifact(input: {
	taskId: string;
	reason: string;
	payload: Record<string, unknown>;
	output?: Record<string, unknown> | null;
	workerId: string;
}): TaskCheckpointArtifact {
	const output = asRecord(input.output);
	const summary = asRecord(output.summary);
	const capacityUsage = asRecord(output.capacityUsage);
	const changedPaths = Array.isArray(output.changedPaths)
		? output.changedPaths.filter((entry): entry is string => typeof entry === 'string')
		: Array.isArray(summary.changedPaths)
			? summary.changedPaths.filter((entry): entry is string => typeof entry === 'string')
			: [];
	const estimatedRemainingP50 = Number(input.payload.estimatedRemainingCreditsP50 ?? input.payload.estimatedRemainingP50 ?? 0);
	const estimatedRemainingP90 = Number(input.payload.estimatedRemainingCreditsP90 ?? input.payload.estimatedRemainingP90 ?? estimatedRemainingP50);
	return {
		taskId: input.taskId,
		checkpointId: `${input.taskId}:checkpoint:${Date.now()}`,
		branch: readString(input.payload.branchName) || readString(output.branchName) || null,
		baseCommit: readString(input.payload.baseCommit) || null,
		currentCommit: readString(output.commitSha) || null,
		currentGoal: readString(input.payload.currentGoal) || readString(input.payload.taskSignature) || null,
		currentPhase: 'capacity_interrupt',
		filesChanged: changedPaths,
		commandsRun: Array.isArray(output.commandsRun) ? output.commandsRun.filter((entry): entry is string => typeof entry === 'string') : [],
		testStatus: readString(output.testStatus) || 'unknown',
		knownFailures: Array.isArray(output.knownFailures) ? output.knownFailures.filter((entry): entry is string => typeof entry === 'string') : [],
		completedWork: [readString(summary.summary) || readString(output.summary) || 'Task interrupted before completion.'],
		remainingWorkEstimate: estimatedRemainingP50 > 0 || estimatedRemainingP90 > 0
			? { p50: Math.max(0, estimatedRemainingP50), p90: Math.max(estimatedRemainingP50, estimatedRemainingP90) }
			: null,
		rollbackStrategy: 'Preserve branch/worktree and revert to base commit if continuation is rejected.',
		continuationStrategy: 'Resume from checkpoint artifact and complete the remaining work through normal admission.',
		repositoryState: changedPaths.length > 0 || Number(capacityUsage.filesChanged ?? 0) > 0 ? 'checkpointed_dirty' : 'clean',
		createdAt: new Date().toISOString(),
		metadata: {
			reason: input.reason,
			workerId: input.workerId,
		},
	};
}

async function checkpointInterruptedTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	taskId: string;
	workerId: string;
	reason: string;
	payload: Record<string, unknown>;
	output?: Record<string, unknown> | null;
	request?: Record<string, unknown>;
}) {
	const checkpoint = buildCheckpointArtifact({
		taskId: input.taskId,
		reason: input.reason,
		payload: input.payload,
		output: input.output,
		workerId: input.workerId,
	});
	await input.sdk.recordTaskProgress({
		id: input.taskId,
		workerId: input.workerId,
		state: 'checkpointing',
		appendEvent: {
			kind: 'checkpoint_started',
			data: { reason: input.reason },
		},
		actor: 'worker',
	});
	await input.sdk.recordTaskProgress({
		id: input.taskId,
		workerId: input.workerId,
		state: 'checkpointed',
		appendEvent: {
			kind: 'checkpointed',
			data: checkpoint as unknown as Record<string, unknown>,
		},
		actor: 'worker',
	});
	await input.sdk.recordTaskProgress({
		id: input.taskId,
		workerId: input.workerId,
		state: 'continuation_required',
		appendEvent: {
			kind: 'continuation_required',
			data: {
				reason: input.reason,
				checkpoint,
				...(input.request ?? {}),
			},
		},
		actor: 'worker',
	});
	return checkpoint;
}

export async function executeResearchKnowledgeTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	task: Record<string, unknown>;
	taskKind: ResearchKnowledgeTaskKind;
	workerId: string;
	queueAttempt: number;
	enqueueFollowups?: boolean;
	promotionDependencies?: KnowledgePromotionDependencies;
	docsMutationDependencies?: CodexDocsMutationDependencies;
}) {
	const payload = taskPayload(input.task);
	const workDayId = workDayIdForTask(input.task);
	const graphVersion = graphVersionForTask(input.task);
	const taskId = taskRecordId(input.task);
	const repoRoot = resolveServiceRepoRoot();
	const enqueueFollowups = input.enqueueFollowups ?? true;

	if (input.taskKind === 'research_question') {
		const payloadInventory = asRecord(payload.codebaseInventory);
		const codebaseInventory = payloadInventory.kind === 'codebase_inventory'
			? payloadInventory
			: workDayId
				? await loadLatestCodebaseInventoryForWorkday({ sdk: input.sdk, workDayId })
				: null;
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'research',
			payload: {
				...payload,
				taskId,
				...(codebaseInventory ? { codebaseInventory } : {}),
			},
		});
		const { result, output } = await runBuiltInHandler(researchHandler, context);
		const note = result as ResearchNote | null;
		const generatedArtifacts = note ? [summarizeResearchNoteArtifact(note, taskId)] : [];
		const nextTaskId = note && workDayId
			? await createFollowupTask({
					sdk: input.sdk,
					workDayId,
					agentId: 'knowledge-generator-agent',
					type: 'generate_knowledge_draft',
					priority: 90,
					idempotencyKey: followupTaskIdempotencyKey(workDayId, 'generate_knowledge_draft', note.id),
					payload: {
						executionKind: 'research_knowledge_pipeline',
						researchNote: note,
						question: payload.question,
						sourceTaskId: taskId,
						taskKind: 'generate_knowledge_draft',
					},
					graphVersion,
					enqueue: enqueueFollowups,
				})
			: null;
		return envelope({
			artifactKind: 'research_note',
			researchNote: note ?? undefined,
			generatedArtifacts,
			nextTaskId,
			status: mutationSummaryStatus(output.status),
			summary: output.summary,
		});
	}

	if (input.taskKind === 'generate_knowledge_draft') {
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'knowledge_draft',
			payload: { ...payload, taskId },
		});
		const { result, output } = await runBuiltInHandler(knowledgeGeneratorHandler, context);
		const draft = result as KnowledgeDraft | null;
		const generatedArtifacts = draft ? [summarizeKnowledgeDraftArtifact(draft, taskId)] : [];
		const nextTaskId = draft && workDayId
			? await createFollowupTask({
					sdk: input.sdk,
					workDayId,
					agentId: 'knowledge-optimizer-agent',
					type: 'optimize_knowledge_draft',
					priority: 85,
					idempotencyKey: followupTaskIdempotencyKey(workDayId, 'optimize_knowledge_draft', draft.id),
					payload: {
						executionKind: 'research_knowledge_pipeline',
						researchNote: payload.researchNote,
						knowledgeDraft: draft,
						question: payload.question,
						sourceTaskId: taskId,
						taskKind: 'optimize_knowledge_draft',
					},
					graphVersion,
					enqueue: enqueueFollowups,
				})
			: null;
		return envelope({
			artifactKind: 'knowledge_draft',
			knowledgeDraft: draft ?? undefined,
			generatedArtifacts,
			nextTaskId,
			status: mutationSummaryStatus(output.status),
			summary: output.summary,
		});
	}

	if (input.taskKind === 'optimize_knowledge_draft') {
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'knowledge_optimization',
			payload: { ...payload, taskId },
		});
		const { result, output } = await runBuiltInHandler(knowledgeOptimizerHandler, context);
		const report = result as OptimizationReport | null;
		const generatedArtifacts = report ? [summarizeOptimizationReportArtifact(report, taskId)] : [];
		const draft = asRecord(payload.knowledgeDraft) as unknown as KnowledgeDraft;
		const note = asRecord(payload.researchNote) as unknown as ResearchNote;
		const revisionRequest = report?.recommendation === 'revise'
			? {
					executionKind: 'research_knowledge_pipeline',
					researchNote: note,
					question: payload.question,
					previousKnowledgeDraft: draft,
					optimizationReport: report,
					sourceTaskId: taskId,
					taskKind: 'generate_knowledge_draft',
					revisionOfDraftId: draft.id,
				}
			: null;
		const promotionRequest = report?.recommendation === 'promote'
			? {
					id: `promotion:${report.draftId}`,
					draftId: report.draftId,
					targetPath: draft.targetPath,
					recommendation: report.recommendation,
					totalScore: report.totalScore,
					sourceQuestionId: draft.sourceQuestionId,
					sourceResearchIds: draft.sourceResearchIds,
					sourceResearchNoteId: note.id,
					optimizationReportId: report.id,
					sourceTaskId: taskId,
				}
			: null;
		const nextTaskId = promotionRequest && report && workDayId
			? await createFollowupTask({
					sdk: input.sdk,
					workDayId,
					agentId: 'knowledge-reviewer-agent',
					type: 'promote_knowledge_draft_request',
					priority: 80,
					idempotencyKey: followupTaskIdempotencyKey(workDayId, 'promote_knowledge_draft_request', report.draftId),
					payload: {
						executionKind: 'research_knowledge_pipeline',
						promotionRequest,
						sourceTaskId: taskId,
						taskKind: 'promote_knowledge_draft_request',
					},
					graphVersion,
					enqueue: false,
				})
			: revisionRequest && report && workDayId
				? await createFollowupTask({
						sdk: input.sdk,
						workDayId,
						agentId: 'knowledge-generator-agent',
						type: 'generate_knowledge_draft',
						priority: 88,
						idempotencyKey: `${workDayId}:generate_knowledge_draft_revision:${report.id}`,
						payload: revisionRequest,
						graphVersion,
						enqueue: enqueueFollowups,
						})
			: null;
		if (promotionRequest && report && workDayId) {
			const config = resolveWorkerConfig();
			await persistPromotionApprovalRequest({
				sdk: input.sdk,
				projectId: typeof payload.projectId === 'string' ? payload.projectId : config.projectId,
				teamId: typeof payload.teamId === 'string' ? payload.teamId : null,
				workDayId,
				taskId,
				draft,
				report,
				note,
				promotionRequest,
				promotionTaskId: nextTaskId,
				policySnapshot: asRecord(payload.policySnapshot),
			});
		}
		return envelope({
			artifactKind: 'optimization_report',
			optimizationReport: report ?? undefined,
			promotionRequest: promotionRequest ?? undefined,
			generatedArtifacts: [
				...generatedArtifacts,
				...(promotionRequest ? [summarizePromotionRequestArtifact(promotionRequest, nextTaskId ?? undefined)] : []),
			],
			nextTaskId,
			status: mutationSummaryStatus(output.status),
			summary: output.summary,
		});
	}

	if (input.taskKind === 'promote_knowledge_to_staging') {
		if (docsMutationExecutionDisabled()) {
			return envelope({
				artifactKind: 'docs_mutation_result',
				generatedArtifacts: [],
				nextTaskId: null,
				status: 'waiting',
				summary: 'Docs automation is running without repository mutation; approved promotion was not applied.',
			});
		}
		const config = resolveWorkerConfig();
		const normalized = normalizeKnowledgePromotionTaskInput({
			task: input.task,
			payload,
			repoRoot,
			projectId: config.projectId,
			environment: config.environment,
		});
		if (!normalized) {
			return envelope({
				artifactKind: 'promotion_request',
				generatedArtifacts: [],
				nextTaskId: null,
				status: 'waiting',
				summary: 'Knowledge promotion is waiting for an approved draft and approval decision.',
			});
		}
		const promotion = await runKnowledgePromotionToStaging({
			task: normalized,
			sdk: input.sdk,
			dependencies: input.promotionDependencies,
		});
		const releaseRequest = 'releaseRequest' in promotion ? promotion.releaseRequest : undefined;
		const releaseTaskId = releaseRequest && workDayId
			? await createFollowupTask({
					sdk: input.sdk,
					workDayId,
					agentId: 'releaser-agent',
					type: 'release_staged_knowledge_request',
					priority: 75,
					idempotencyKey: followupTaskIdempotencyKey(workDayId, 'release_staged_knowledge_request', releaseRequest.id),
					payload: {
						executionKind: 'research_knowledge_pipeline',
						releaseRequest,
						sourceTaskId: taskId,
						taskKind: 'release_staged_knowledge_request',
						projectId: normalized.projectId,
						environment: normalized.environment,
						releaseInput: releaseRequest.releaseInput,
						operationGrants: [
							defaultReleaseGrant({
								taskId: `release:${taskId}`,
								projectId: normalized.projectId,
								environment: normalized.environment,
								approvalId: releaseRequest.id,
							}),
						],
					},
					graphVersion,
					enqueue: false,
				})
			: null;
		const repairTask = asRecord('repairTask' in promotion ? promotion.repairTask : null);
		const repairTaskId = !releaseRequest && workDayId && Object.keys(repairTask).length > 0
			? await createRepairFollowupTask({
					sdk: input.sdk,
					workDayId,
					graphVersion,
					sourceTaskId: taskId,
					repairTask,
					failureKind: ('error' in promotion && promotion.error?.code === 'verification_failed') ? 'verification' : 'merge',
				})
			: null;
		const nextTaskId = releaseTaskId ?? repairTaskId;
		return envelope({
			artifactKind: 'docs_mutation_result',
			promotionRequest: asRecord(payload.promotionRequest),
			releaseRequest: releaseRequest ?? undefined,
			docsMutationResult: promotion as unknown as Record<string, unknown>,
			promotionToStaging: promotion as unknown as Record<string, unknown>,
			changedPaths: promotion.changedPaths,
			verification: asRecord(promotion.verification),
			snapshots: promotion.snapshots as unknown as Record<string, unknown>[],
			repairTask: repairTaskId ? { ...repairTask, taskId: repairTaskId } : repairTask,
			mergedToStaging: promotion.mergedToStaging,
			generatedArtifacts: [
				summarizeDocsMutationResultArtifact(promotion as unknown as Record<string, unknown>, taskId),
				...(releaseRequest ? [summarizeReleaseRequestArtifact(releaseRequest, releaseTaskId ?? undefined)] : []),
			],
			nextTaskId,
			status: promotion.status === 'staged' ? 'completed' : promotion.status === 'waiting' ? 'waiting' : 'failed',
			summary: promotion.summary,
		} as unknown as Omit<ResearchKnowledgeTaskOutputEnvelope, 'summary'> & {
			status: ResearchKnowledgeTaskOutputEnvelope['summary']['status'];
			summary: string;
		});
	}

	if (input.taskKind === 'apply_approved_docs_mutation') {
		if (docsMutationExecutionDisabled()) {
			return envelope({
				artifactKind: 'docs_mutation_result',
				generatedArtifacts: [],
				nextTaskId: null,
				status: 'waiting',
				summary: 'Docs automation is running without repository mutation; approved docs mutation was not applied.',
			});
		}
		const approval = asRecord(payload.approval);
		if (readString(approval.state) !== 'approved') {
			return envelope({
				artifactKind: 'docs_mutation_result',
				generatedArtifacts: [],
				nextTaskId: null,
				status: 'waiting',
				summary: 'Approved docs mutation is waiting for approved approval metadata.',
			});
		}
		const allowedPaths = readStringArray(payload.allowedPaths);
		if (allowedPaths.length === 0) {
			return envelope({
				artifactKind: 'docs_mutation_result',
				generatedArtifacts: [],
				nextTaskId: null,
				status: 'waiting',
				summary: 'Approved docs mutation is waiting for explicit allowed paths.',
			});
		}
		const context = contextForDocsMutationHandler({
			sdk: input.sdk,
			repoRoot,
			payload: {
				...payload,
				taskId,
				workDayId,
				taskKind: 'apply_approved_docs_mutation',
			},
			taskId,
		});
		const task = normalizeCodexDocsMutationInput({
			...payload,
			taskId,
			workDayId,
			taskKind: 'apply_approved_docs_mutation',
		}, context);
		const result = await runCodexDocsMutationLifecycle(context, task, input.docsMutationDependencies);
		const repairTask = asRecord(result.repairTask);
		const repairTaskId = workDayId && Object.keys(repairTask).length > 0
			? await createRepairFollowupTask({
					sdk: input.sdk,
					workDayId,
					graphVersion,
					sourceTaskId: taskId,
					repairTask,
					failureKind: 'implementation',
				})
			: null;
		return envelope({
			artifactKind: 'docs_mutation_result',
			docsMutationResult: result as unknown as Record<string, unknown>,
			implementationResult: result as unknown as Record<string, unknown>,
			changedPaths: result.changedPaths,
			verification: asRecord(result.verification),
			snapshots: result.snapshots as unknown as Record<string, unknown>[],
			repairTask: repairTaskId ? { ...repairTask, taskId: repairTaskId } : repairTask,
			mergedToStaging: result.mergedToStaging,
			generatedArtifacts: [summarizeDocsMutationResultArtifact(result as unknown as Record<string, unknown>, taskId)],
			nextTaskId: repairTaskId,
			status: mutationSummaryStatus(result.status),
			summary: result.summary,
		});
	}

	if (input.taskKind === 'create_repair_task') {
		const repairTask = asRecord(payload.repairTask);
		return envelope({
			artifactKind: 'docs_mutation_result',
			docsMutationResult: {
				taskId,
				status: 'waiting',
				summary: 'Repair task is visible and waiting for a later repair executor.',
				repairTask,
			},
			repairTask,
			generatedArtifacts: [],
			nextTaskId: null,
			status: 'waiting',
			summary: 'Repair task is visible and waiting for a later repair executor.',
		});
	}

	if (input.taskKind === 'release_staged_knowledge_request') {
		const releaseRequest = asRecord(payload.releaseRequest);
		return envelope({
			artifactKind: 'release_request',
			releaseRequest,
			generatedArtifacts: [summarizeReleaseRequestArtifact(releaseRequest, taskId)],
			nextTaskId: null,
			status: 'waiting',
			summary: 'Staged knowledge release is waiting for explicit human release approval.',
		});
	}

	const promotionRequest = asRecord(payload.promotionRequest);
	return envelope({
		artifactKind: 'promotion_request',
		promotionRequest,
		generatedArtifacts: [summarizePromotionRequestArtifact(promotionRequest, taskId)],
		nextTaskId: null,
		status: 'waiting',
		summary: 'Knowledge draft promotion is waiting for an approval decision.',
	});
}

async function executeQueuedTask(options: {
	sdk: ReturnType<typeof createServiceSdk>;
	kernel: AgentKernel;
	taskId: string;
	workerId: string;
	queueAttempt: number;
	volumeRoot: string;
}) {
	const context = await buildTaskContext(options.sdk, options.taskId);
	const task = context.task as Record<string, unknown> | null;
	const payload = parseTaskPayload(task);
	await ensureRunnerComposedWorkspace(options.volumeRoot, {
		...(task ?? {}),
		payloadJson: JSON.stringify(payload),
	});
	const capacityEnvelope = readCapacityEnvelope(payload);
	const capacityMetadata = readCapacityMetadata(payload);
	const attentionEstimate = readAttentionEstimate(payload);
	const utilityEstimate = readUtilityEstimate(payload);
	const hybridExecutionPlan = readHybridExecutionPlan(payload);
	const explicitApproval = asRecord(payload.approvalRequest);
	if (Object.keys(explicitApproval).length > 0 || capacityEnvelope?.maxCredits === 0) {
		throw new WorkerPausedForApproval({
			kind: String(explicitApproval.kind ?? 'capacity_boundary'),
			title: String(explicitApproval.title ?? 'Task paused for approval'),
			summary: String(explicitApproval.summary ?? 'The task reached a boundary outside its approved execution envelope.'),
			severity: explicitApproval.severity ?? 'medium',
			workDayId: task?.workDayId ?? task?.work_day_id ?? null,
			taskId: options.taskId,
			options: Array.isArray(explicitApproval.options) ? explicitApproval.options : [],
			recommendation: asRecord(explicitApproval.recommendation),
			policySnapshot: {
				capacityEnvelope,
				...asRecord(explicitApproval.policySnapshot),
			},
		});
	}
	const explicitInterrupt = asRecord(payload.capacityInterrupt);
	if (Object.keys(explicitInterrupt).length > 0 || payload.providerAvailable === false) {
		const interruption = shouldInterruptForCapacity({
			reservedCredits: Number(capacityMetadata?.reservedCredits ?? capacityEnvelope?.maxCredits ?? 0),
			consumedCredits: Number(explicitInterrupt.consumedCredits ?? payload.consumedCredits ?? 0),
			estimatedRemainingCreditsP50: Number(explicitInterrupt.estimatedRemainingP50 ?? payload.estimatedRemainingCreditsP50 ?? 0),
			estimatedRemainingCreditsP90: Number(explicitInterrupt.estimatedRemainingP90 ?? payload.estimatedRemainingCreditsP90 ?? 0),
			providerAvailable: payload.providerAvailable === false ? false : explicitInterrupt.providerAvailable as boolean | undefined,
			recoveryBudgetRemainingCredits: Number(explicitInterrupt.recoveryBudgetRemainingCredits ?? payload.recoveryBudgetRemainingCredits ?? Number.NaN),
		});
		if (interruption.interrupt) {
			throw new WorkerCapacityInterrupted({
				reason: interruption.reasons[0] ?? 'capacity_interrupt',
				summary: 'Task interrupted by capacity policy before execution.',
				interruption,
				capacityEnvelope,
				capacityMetadata,
			});
		}
	}
	const executionKind = typeof payload.executionKind === 'string' ? payload.executionKind : null;
	const taskKind = String(task?.type ?? task?.taskType ?? '');
	if (executionKind === 'planning' || taskKind === 'planning_task') {
		const planningProposal = buildPlanningProposalFromTask({
			task: task ?? {},
			payload,
		});
		await options.sdk.recordTaskProgress({
			id: options.taskId,
			workerId: options.workerId,
			state: 'running',
			appendEvent: {
				kind: 'plan_proposed',
				data: planningProposal as unknown as Record<string, unknown>,
			},
			actor: 'worker',
		});
		return {
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
			executionKind: 'planning',
			planningProposal,
			summary: {
				status: 'completed',
				workerId: options.workerId,
				summary: `Proposed ${planningProposal.tasks.length} downstream task${planningProposal.tasks.length === 1 ? '' : 's'}.`,
			},
		};
	}
	if (isResearchKnowledgeTaskKind(taskKind)) {
		const output = await executeResearchKnowledgeTask({
			sdk: options.sdk,
			task: task ?? {},
			taskKind,
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
		});
		return {
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
			executionKind: 'research_knowledge_pipeline',
			taskKind,
			...output,
		};
	}
	if (taskKind === 'refresh_project_graph') {
		const config = resolveWorkerConfig();
		const projectId = typeof payload.projectId === 'string' ? payload.projectId : config.projectId;
		const repositoryId = typeof payload.repositoryId === 'string' ? payload.repositoryId : projectId;
		const paths = runnerRepositoryPath(config.volumeRoot, repositoryId, options.taskId);
		await mkdir(paths.bareGit, { recursive: true });
		await mkdir(paths.worktree, { recursive: true });
		const graphRefresh = asRecord(await options.sdk.refreshGraph());
		const graphVersion = readString(graphRefresh.snapshotRoot);
		await options.sdk.create({
			model: 'graph_run',
			data: {
				id: `${options.taskId}:graph`,
				workDayId: String(task?.workDayId ?? task?.work_day_id ?? ''),
				corpusHash: graphVersion,
				graphVersion,
				statsJson: JSON.stringify(graphRefresh),
				snapshotRef: graphVersion,
			},
			actor: 'worker',
		});
		if (typeof options.sdk.updateWorkDayGraph === 'function') {
			await options.sdk.updateWorkDayGraph({
				id: String(task?.workDayId ?? task?.work_day_id ?? ''),
				graphVersion,
				summaryPatch: {
					graphRefresh: {
						state: 'completed',
						graphVersion,
						snapshotRef: graphVersion,
						runnerId: config.workerId,
					},
				},
			});
		}
		if (typeof options.sdk.recordRepositoryClaim === 'function') {
			await options.sdk.recordRepositoryClaim({
				projectId,
				repositoryId,
				runnerId: config.workerId,
				runnerServiceName: config.runnerServiceName,
				volumeIdentity: config.volumeIdentity,
				lastSeenCommit: typeof payload.commitSha === 'string' ? payload.commitSha : null,
				metadata: {
					bareGit: paths.bareGit,
					worktree: paths.worktree,
				},
			});
		}
		return {
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
			graphVersion,
			snapshotRef: graphVersion,
			repositoryId,
			paths,
			summary: {
				status: 'completed',
				workerId: options.workerId,
				summary: `Refreshed project graph ${graphVersion}`,
			},
		};
	}

	if (taskKind === CODEBASE_DOCUMENTATION_SCAN_TASK_KIND) {
		const inventory = scanCodebaseDocumentationSurface({
			repoRoot: resolveServiceRepoRoot(),
			graphVersion: graphVersionForTask(task ?? {}) ?? (typeof payload.graphVersion === 'string' ? payload.graphVersion : null),
			repoRef: typeof payload.repoRef === 'string' ? payload.repoRef : typeof payload.commitSha === 'string' ? payload.commitSha : undefined,
		});
		const taskId = taskRecordId(task ?? {}) || options.taskId;
		const emittedGapMessages = await emitKnowledgeGapMessages({
			sdk: options.sdk,
			inventoryId: inventory.id,
			gaps: inventory.knowledgeGaps,
			maxMessages: Number.isFinite(Number(payload.maxKnowledgeGapMessages)) ? Number(payload.maxKnowledgeGapMessages) : 8,
		});
		const appendTaskEvent = (options.sdk as unknown as {
			appendTaskEvent?: (request: { taskId: string; kind: string; data?: Record<string, unknown>; actor: string }) => Promise<unknown>;
		}).appendTaskEvent;
		await appendTaskEvent?.call(options.sdk, {
			taskId: options.taskId,
			kind: 'codebase_inventory_completed',
			data: {
				inventoryId: inventory.id,
				packageCount: inventory.packages.length,
				moduleCount: inventory.packages.reduce((count, item) => count + item.modules.length, 0),
				knowledgeGapCount: inventory.knowledgeGaps.length,
				emittedGapMessages,
			},
			actor: 'worker',
		});
		return {
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
			executionKind: 'codebase_documentation_scan',
			artifactKind: 'codebase_inventory',
			codebaseInventory: inventory,
			generatedArtifacts: [summarizeCodebaseInventoryArtifact(inventory, taskId)],
			summary: {
				status: 'completed',
				workerId: options.workerId,
				summary: `Scanned ${inventory.packages.length} package surfaces and found ${inventory.knowledgeGaps.length} documentation gap${inventory.knowledgeGaps.length === 1 ? '' : 's'}.`,
			},
		};
	}

	if (executionKind === 'workflow_dispatch' || executionKind === 'sdk_dispatch') {
		const namespace = typeof payload.namespace === 'string' ? payload.namespace : 'workflow';
		const operation = typeof payload.operation === 'string' ? payload.operation : '';
		if (!operation) {
			throw new Error(`Task ${options.taskId} does not define a dispatch operation.`);
		}
		const input = payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown> : {};
		const result = await options.sdk.dispatch({
			namespace: namespace as 'sdk' | 'workflow',
			operation,
			input,
			preferredMode: 'prefer_local',
		});
		return {
			workerId: options.workerId,
			queueAttempt: options.queueAttempt,
			executionKind,
			namespace,
			operation,
			result,
			summary: {
				status: 'completed',
				workerId: options.workerId,
				summary: `Executed ${namespace}:${operation}`,
			},
		};
	}

	const agentSlug =
		typeof payload.agentSlug === 'string' && payload.agentSlug
			? payload.agentSlug
			: typeof context.agent?.slug === 'string' && context.agent.slug
				? context.agent.slug
				: typeof task?.agentId === 'string' && task.agentId
					? task.agentId
					: typeof task?.agent_id === 'string' && task.agent_id
						? task.agent_id
						: '';
	if (!agentSlug) {
		throw new Error(`Task ${options.taskId} does not resolve to an agent slug.`);
	}
	const invocation =
		payload.invocation && typeof payload.invocation === 'object'
			? payload.invocation as AgentTriggerInvocation
			: null;
	const agentResult = await options.kernel.runAgent(agentSlug, invocation ? 'manual' : 'auto', invocation);
	return {
		workerId: options.workerId,
		queueAttempt: options.queueAttempt,
		agentSlug,
		result: agentResult,
		summary: {
			status: agentResult.status,
			workerId: options.workerId,
			summary: agentResult.summary,
		},
		capacityUsage: capacityEnvelope?.providerId && capacityEnvelope?.laneId
			? {
				capacityProviderId: capacityEnvelope.providerId,
				laneId: capacityEnvelope.laneId,
				reservationId: capacityEnvelope.reservationIds?.[0] ?? null,
				credits: Number(payload.estimatedCredits ?? capacityEnvelope.maxCredits ?? 1),
				source: 'worker',
				taskSignature: typeof payload.taskSignature === 'string' ? payload.taskSignature : String(task?.type ?? task?.taskType ?? 'agent_trigger'),
				executionProfileId: readExecutionProfileId(payload),
				attentionEstimate,
				utilityEstimate,
				hybridExecutionPlan,
			}
			: capacityMetadata
				? {
					capacityProviderId: capacityMetadata.providerId,
					laneId: capacityMetadata.laneId,
					reservationId: capacityMetadata.reservationId,
					credits: Number(payload.actualCredits ?? capacityMetadata.estimatedCreditsP50 ?? capacityMetadata.reservedCredits ?? 1),
					source: 'worker',
					taskSignature: typeof payload.taskSignature === 'string' ? payload.taskSignature : String(task?.type ?? task?.taskType ?? 'agent_trigger'),
					reservedCredits: capacityMetadata.reservedCredits,
					executionProfileId: capacityMetadata.executionProfileId,
					attentionEstimate: capacityMetadata.attentionEstimate,
					utilityEstimate: capacityMetadata.utilityEstimate,
					hybridExecutionPlan: capacityMetadata.hybridExecutionPlan,
				}
				: null,
	};
}

function createLocalTaskQueue(sdk: ReturnType<typeof createServiceSdk>, config: ReturnType<typeof resolveWorkerConfig>) {
	return {
		async pull(input: { batchSize?: number; visibilityTimeoutMs?: number } = {}) {
			const envelope = await sdk.searchTasks({
				state: ['waiting', 'queued', 'pending'],
				limit: input.batchSize ?? config.batchSize,
			});
			const tasks = Array.isArray(envelope.payload) ? envelope.payload as Array<Record<string, unknown>> : [];
			return {
				messages: tasks.map((task) => ({
					leaseId: `local:${String(task.id ?? '')}`,
					attempts: Number(task.attemptCount ?? task.attempt_count ?? 0) + 1,
					body: taskEnvelopeForTask(task),
				})),
			};
		},
		async ack(_leaseIds: string[]) {
			return undefined;
		},
		async retry(_messages: Array<{ leaseId: string; delaySeconds: number }>) {
			return undefined;
		},
	};
}

async function recordWorkerRunnerHeartbeat(
	sdk: ReturnType<typeof createServiceSdk>,
	config: ReturnType<typeof resolveWorkerConfig>,
	state: 'active' | 'idle' | 'draining' | 'offline',
	activeLocalWorkers: number,
	metadata: Record<string, unknown> = {},
) {
	if (typeof sdk.recordWorkerRunner !== 'function') {
		return;
	}
	await sdk.recordWorkerRunner({
		projectId: config.projectId,
		environment: config.environment as 'local' | 'staging' | 'prod',
		runnerId: config.workerId,
		runnerServiceName: config.runnerServiceName,
		volumeIdentity: config.volumeIdentity,
		state,
		maxLocalWorkers: config.maxLocalWorkers,
		activeLocalWorkers,
		metadata: {
			volumeRoot: config.volumeRoot,
			pid: process.pid,
			...metadata,
		},
	}).catch(() => null);
}

export async function runWorkerCycle() {
	const sdk = createServiceSdk();
	const config = resolveWorkerConfig();
	const kernel = new AgentKernel(sdk, resolveServiceRepoRoot());
	await recordWorkerRunnerHeartbeat(sdk, config, 'active', 0, { phase: 'polling' });
	const queue = createLocalTaskQueue(sdk, config);

	const pulled = await queue.pull({
		batchSize: config.batchSize,
		visibilityTimeoutMs: config.visibilityTimeoutMs,
	});
	if (pulled.messages.length === 0) {
		await recordWorkerRunnerHeartbeat(sdk, config, 'idle', 0, { phase: 'idle' });
		return { ok: true, processed: 0 };
	}

	const maxLocalWorkers = Number.isFinite(Number(config.maxLocalWorkers)) ? Math.max(1, Number(config.maxLocalWorkers)) : 1;
	const selectedMessages = pulled.messages.slice(0, maxLocalWorkers);
	await recordWorkerRunnerHeartbeat(sdk, config, 'active', selectedMessages.length, {
		phase: 'processing',
		pulledMessageCount: pulled.messages.length,
		selectedMessageCount: selectedMessages.length,
	});
	const results = await Promise.all(selectedMessages.map(async (message) => {
		try {
			await sdk.claimTask({
				id: message.body.taskId,
				workerId: config.workerId,
				leaseSeconds: config.leaseSeconds,
				actor: 'worker',
			});

			await sdk.recordTaskProgress({
				id: message.body.taskId,
				workerId: config.workerId,
				state: 'running',
				appendEvent: {
					kind: 'worker_started',
					data: { workerId: config.workerId, queueAttempt: message.attempts },
				},
				actor: 'worker',
			});

			const startContext = await buildTaskContext(sdk, message.body.taskId);
			const startPayload = parseTaskPayload(startContext.task as Record<string, unknown> | null);
			const startCapacity = readCapacityMetadata(startPayload);
			if (startCapacity?.reservationId) {
				const reporter = createControlPlaneReporter();
				await reporter.reportCapacityUsage({
					capacityProviderId: startCapacity.providerId,
					laneId: startCapacity.laneId,
					reservationId: startCapacity.reservationId,
					teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
					projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
					workDayId: message.body.workDayId,
					taskId: message.body.taskId,
					phase: 'task_started',
					credits: 0,
					source: 'worker',
					metadata: {
						workerId: config.workerId,
						queueAttempt: message.attempts,
					},
				}).catch(() => null);
			}

			let output;
			try {
				output = await executeQueuedTask({
					sdk,
					kernel,
					taskId: message.body.taskId,
					workerId: config.workerId,
					queueAttempt: message.attempts,
					volumeRoot: config.volumeRoot,
				});
			} catch (error) {
				if (error instanceof WorkerCapacityInterrupted) {
					const context = await buildTaskContext(sdk, message.body.taskId);
					const task = context.task as Record<string, unknown> | null;
					const payload = parseTaskPayload(task);
					const checkpoint = await checkpointInterruptedTask({
						sdk,
						taskId: message.body.taskId,
						workerId: config.workerId,
						reason: String(error.request.reason ?? 'capacity_interrupt'),
						payload,
						request: error.request,
					});
					const reporter = createControlPlaneReporter();
					const capacityMetadata = readCapacityMetadata(payload);
					const attentionEstimate = readAttentionEstimate(payload);
					const utilityEstimate = readUtilityEstimate(payload);
					const hybridExecutionPlan = readHybridExecutionPlan(payload);
					if (capacityMetadata?.providerId && capacityMetadata.laneId) {
						await reporter.reportCapacityUsage({
							capacityProviderId: capacityMetadata.providerId,
							laneId: capacityMetadata.laneId,
							reservationId: capacityMetadata.reservationId,
							teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
							projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
							workDayId: message.body.workDayId,
							taskId: message.body.taskId,
							phase: 'overrun_hold',
							credits: Number(asRecord(error.request.interruption).consumedCredits ?? 0),
							source: 'worker',
							metadata: {
								interrupted: true,
								reason: error.request.reason ?? 'capacity_interrupt',
								checkpointId: checkpoint.checkpointId,
								attentionEstimate,
								utilityEstimate,
								hybridExecutionPlan,
							},
								usageActual: {
									taskSignature: typeof payload.taskSignature === 'string' ? payload.taskSignature : String(task?.type ?? 'unknown'),
									executionProfileId: capacityMetadata.executionProfileId,
									actualCredits: Number(asRecord(error.request.interruption).consumedCredits ?? 0),
								metadata: {
									interrupted: true,
									partial: true,
									attentionEstimate,
									utilityEstimate,
									hybridExecutionPlan,
								},
							},
						}).catch(() => null);
					}
					const projectId = String(process.env.TREESEED_PROJECT_ID ?? '');
					await reporter.createApprovalRequest({
						projectId,
						teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
						workDayId: message.body.workDayId,
						taskId: message.body.taskId,
						kind: 'continuation_required',
						severity: 'medium',
						requestedByType: 'worker',
						requestedById: config.workerId,
						title: 'Continuation required',
						summary: String(error.request.summary ?? 'Task was checkpointed and needs a continuation decision.'),
						options: [
							{ id: 'continue_later', label: 'Continue later' },
							{ id: 'split_remaining_work', label: 'Split remaining work' },
							{ id: 'rollback', label: 'Rollback' },
						],
						recommendation: { optionId: 'continue_later' },
						policySnapshot: {
							...error.request,
							checkpoint,
						},
					}).catch(() => null);
					await queue.ack([message.leaseId]);
					return 1;
				}
				if (error instanceof WorkerPausedForApproval) {
					const reporter = createControlPlaneReporter();
					const context = await buildTaskContext(sdk, message.body.taskId);
					const task = context.task as Record<string, unknown> | null;
					const projectId = String(process.env.TREESEED_PROJECT_ID ?? '');
					await reporter.createApprovalRequest({
						projectId,
						teamId: String(error.request.teamId ?? process.env.TREESEED_TEAM_ID ?? ''),
						workDayId: typeof error.request.workDayId === 'string' ? error.request.workDayId : String(task?.workDayId ?? task?.work_day_id ?? ''),
						taskId: message.body.taskId,
						kind: String(error.request.kind ?? 'capacity_boundary'),
						severity: error.request.severity === 'high' || error.request.severity === 'low' ? error.request.severity : 'medium',
						requestedByType: 'worker',
						requestedById: config.workerId,
						title: String(error.request.title ?? 'Task paused for approval'),
						summary: String(error.request.summary ?? error.message),
						options: Array.isArray(error.request.options) ? error.request.options as Record<string, unknown>[] : [],
						recommendation: asRecord(error.request.recommendation),
						policySnapshot: asRecord(error.request.policySnapshot),
					}).catch(() => null);
					await sdk.recordTaskProgress({
						id: message.body.taskId,
						workerId: config.workerId,
						state: 'paused_for_approval',
						appendEvent: {
							kind: 'paused_for_approval',
							data: error.request,
						},
						actor: 'worker',
					});
					await queue.ack([message.leaseId]);
					return 1;
				}
				throw error;
			}

			const outputCapacity = asRecord(output.capacityUsage);
			const reservedCredits = Number(outputCapacity.reservedCredits ?? 0);
			const consumedCredits = Number(outputCapacity.credits ?? 0);
			const postExecutionInterrupt = shouldInterruptForCapacity({
				reservedCredits,
				consumedCredits,
				estimatedRemainingCreditsP50: Number(outputCapacity.estimatedRemainingP50 ?? 0),
				estimatedRemainingCreditsP90: Number(outputCapacity.estimatedRemainingP90 ?? 0),
				reservationUsedPercentThreshold: 100,
			});
			if (postExecutionInterrupt.interrupt || (reservedCredits > 0 && consumedCredits > reservedCredits)) {
				const context = await buildTaskContext(sdk, message.body.taskId);
				const payload = parseTaskPayload(context.task as Record<string, unknown> | null);
				const checkpoint = await checkpointInterruptedTask({
					sdk,
					taskId: message.body.taskId,
					workerId: config.workerId,
					reason: 'reservation_exhaustion_risk',
					payload,
					output,
					request: {
						interruption: postExecutionInterrupt,
						consumedCredits,
						reservedCredits,
					},
				});
				const reporter = createControlPlaneReporter();
				const outputProviderId = typeof outputCapacity.capacityProviderId === 'string' ? outputCapacity.capacityProviderId : null;
				const outputLaneId = typeof outputCapacity.laneId === 'string' ? outputCapacity.laneId : null;
				const attentionEstimate = asRecord(outputCapacity.attentionEstimate);
				const utilityEstimate = asRecord(outputCapacity.utilityEstimate);
				const hybridExecutionPlan = asRecord(outputCapacity.hybridExecutionPlan);
				if (outputProviderId && outputLaneId) {
					await reporter.reportCapacityUsage({
						capacityProviderId: outputProviderId,
						laneId: outputLaneId,
						reservationId: typeof outputCapacity.reservationId === 'string' ? outputCapacity.reservationId : null,
						teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
						projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
						workDayId: message.body.workDayId,
						taskId: message.body.taskId,
						phase: 'overrun_hold',
						credits: consumedCredits,
						source: 'worker',
						metadata: {
							interrupted: true,
							reason: 'reservation_exhaustion_risk',
							reservedCredits,
							checkpointId: checkpoint.checkpointId,
							attentionEstimate,
							utilityEstimate,
							hybridExecutionPlan,
						},
							usageActual: {
								taskSignature: typeof outputCapacity.taskSignature === 'string' ? outputCapacity.taskSignature : 'unknown',
								executionProfileId: typeof outputCapacity.executionProfileId === 'string' ? outputCapacity.executionProfileId : readExecutionProfileId(payload),
								actualCredits: consumedCredits,
							metadata: {
								interrupted: true,
								partial: true,
								attentionEstimate,
								utilityEstimate,
								hybridExecutionPlan,
							},
						},
					}).catch(() => null);
				}
				await reporter.createApprovalRequest({
					projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
					teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
					workDayId: message.body.workDayId,
					taskId: message.body.taskId,
					kind: 'continuation_required',
					severity: 'medium',
					requestedByType: 'worker',
					requestedById: config.workerId,
					title: 'Continuation required',
					summary: 'Task used more capacity than reserved and was checkpointed for continuation.',
					options: [
						{ id: 'continue_with_more_budget', label: 'Continue with more budget' },
						{ id: 'split_remaining_work', label: 'Split remaining work' },
						{ id: 'rollback', label: 'Rollback' },
					],
					recommendation: { optionId: 'continue_with_more_budget' },
					policySnapshot: {
						interruption: postExecutionInterrupt,
						checkpoint,
					},
				}).catch(() => null);
				await queue.ack([message.leaseId]);
				return 1;
			}

			await sdk.completeTask({
				id: message.body.taskId,
				output,
				summary: output.summary,
				actor: 'worker',
			});
			if (lowConfidenceResult(output as Record<string, unknown>)) {
				const context = await buildTaskContext(sdk, message.body.taskId);
				const task = context.task as Record<string, unknown> | null;
				await createHybridEscalationTask({
					sdk,
					task,
					taskId: message.body.taskId,
					output: output as Record<string, unknown>,
					payload: parseTaskPayload(task),
					workerId: config.workerId,
				}).catch(() => null);
			}
			if (output.capacityUsage?.capacityProviderId && output.capacityUsage?.laneId) {
				const reporter = createControlPlaneReporter();
				await reporter.reportCapacityUsage({
					capacityProviderId: output.capacityUsage.capacityProviderId,
					laneId: output.capacityUsage.laneId,
					reservationId: output.capacityUsage.reservationId,
					teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
					projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
					workDayId: message.body.workDayId,
					taskId: message.body.taskId,
					phase: output.capacityUsage.reservationId ? 'task_completed_actual_settlement' : 'consume',
					credits: output.capacityUsage.credits,
					source: 'worker',
					metadata: {
						workerId: config.workerId,
						queueAttempt: message.attempts,
						reservedCredits: output.capacityUsage.reservedCredits ?? null,
						attentionEstimate: output.capacityUsage.attentionEstimate ?? null,
						utilityEstimate: output.capacityUsage.utilityEstimate ?? null,
						hybridExecutionPlan: output.capacityUsage.hybridExecutionPlan ?? null,
					},
						usageActual: {
							taskSignature: output.capacityUsage.taskSignature ?? String(output.agentSlug ?? 'agent_trigger'),
							executionProfileId: output.capacityUsage.executionProfileId ?? 'standard-code-model',
							actualCredits: output.capacityUsage.credits,
						retryCount: Math.max(0, message.attempts - 1),
						metadata: {
							workerId: config.workerId,
							attentionEstimate: output.capacityUsage.attentionEstimate ?? null,
							utilityEstimate: output.capacityUsage.utilityEstimate ?? null,
							hybridExecutionPlan: output.capacityUsage.hybridExecutionPlan ?? null,
							confidenceOutcome: asRecord(output.result).confidence ?? null,
							escalationReason: asRecord(output.result).insufficientConfidence === true ? 'insufficient_confidence' : null,
						},
					},
				}).catch(() => null);
			}

			await queue.ack([message.leaseId]);
			return 1;
		} catch (error) {
			const failureContext = await buildTaskContext(sdk, message.body.taskId).catch(() => null);
			const failurePayload = parseTaskPayload(failureContext?.task as Record<string, unknown> | null);
			const failureCapacity = readCapacityMetadata(failurePayload);
			if (failureCapacity?.reservationId) {
				const reporter = createControlPlaneReporter();
				await reporter.reportCapacityUsage({
					capacityProviderId: failureCapacity.providerId,
					laneId: failureCapacity.laneId,
					reservationId: failureCapacity.reservationId,
					teamId: String(process.env.TREESEED_TEAM_ID ?? ''),
					projectId: String(process.env.TREESEED_PROJECT_ID ?? ''),
					workDayId: message.body.workDayId,
					taskId: message.body.taskId,
					phase: 'task_failed_refund',
					credits: -Number(failureCapacity.reservedCredits ?? 0),
					source: 'worker',
					metadata: {
						workerId: config.workerId,
						message: error instanceof Error ? error.message : String(error),
					},
				}).catch(() => null);
			}
			const retryDelaySeconds = Math.min(300, Math.max(15, message.attempts * 30));
			await sdk.failTask({
				id: message.body.taskId,
				errorMessage: error instanceof Error ? error.message : String(error),
				retryable: true,
				nextVisibleAt: new Date(Date.now() + retryDelaySeconds * 1000).toISOString(),
				actor: 'worker',
			}).catch(() => null);
			await queue.retry([{ leaseId: message.leaseId, delaySeconds: retryDelaySeconds }]);
			return 0;
		}
	}));

	const processed = results.reduce<number>((sum, value) => sum + value, 0);
	await recordWorkerRunnerHeartbeat(sdk, config, processed > 0 ? 'idle' : 'active', 0, { phase: 'cycle_complete', processed });
	return { ok: true, processed };
}

export function shouldExitWorkerLoopAfterIdle(options: {
	idleExitMs?: number | null;
	idleSince: number | null;
	now: number;
	processed: number;
}) {
	const idleExitMs = Number(options.idleExitMs ?? 0);
	if (!Number.isFinite(idleExitMs) || idleExitMs <= 0) {
		return false;
	}
	if (options.processed > 0 || options.idleSince === null) {
		return false;
	}
	return options.now - options.idleSince >= idleExitMs;
}

async function recordWorkerLoopExitState(config: ReturnType<typeof resolveWorkerConfig>) {
	const sdk = createServiceSdk();
	await recordWorkerRunnerHeartbeat(sdk, config, 'offline', 0, {
		phase: 'loop_exit',
		reason: 'idle_exit',
	});
}

export async function startWorkerLoop() {
	const config = resolveWorkerConfig();
	let idleSince: number | null = null;
	let idleCycleCount = 0;
	const logCycles = booleanFromEnv('TREESEED_WORKER_CONSOLE_SUMMARY', false);
	for (;;) {
		try {
			const result = await runWorkerCycle();
			const processed = Number((result as { processed?: unknown }).processed ?? 0);
			if (processed > 0) {
				idleSince = null;
				idleCycleCount = 0;
				if (logCycles) {
					process.stdout.write(`[worker] cycle processed=${processed} state=active\n`);
				}
			} else {
				idleSince ??= Date.now();
				idleCycleCount += 1;
				if (logCycles && (idleCycleCount === 1 || idleCycleCount % 6 === 0)) {
					const idleForSeconds = Math.max(0, Math.round((Date.now() - idleSince) / 1000));
					process.stdout.write(`[worker] cycle processed=0 state=idle idleFor=${idleForSeconds}s\n`);
				}
				if (shouldExitWorkerLoopAfterIdle({
					idleExitMs: config.idleExitMs,
					idleSince,
					now: Date.now(),
					processed,
				})) {
					await recordWorkerLoopExitState(config);
					return;
				}
			}
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
	}
}

if (isDirectEntrypoint(import.meta.url, 'worker.ts')) {
	await startWorkerLoop();
}
