#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import type { AgentContext, AgentHandler } from '../agents/runtime-types.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import { createControlPlaneReporter } from '@treeseed/sdk';
import type { CapacityTaskExecutionEnvelope } from '@treeseed/sdk';
import { isDirectEntrypoint } from '../entrypoint.ts';
import { buildTaskContext, createQueueClient, createQueuePushClient, createServiceSdk, queueEnvelopeForTask, resolveServiceRepoRoot, resolveWorkerConfig } from './common.ts';
import { researcherHandler } from '../agents/handlers/researcher.ts';
import { knowledgeGeneratorHandler } from '../agents/handlers/knowledge-generator.ts';
import { knowledgeOptimizerHandler } from '../agents/handlers/knowledge-optimizer.ts';
import type { KnowledgeDraft, OptimizationReport } from '../agents/contracts/knowledge.ts';
import type { ResearchNote } from '../agents/contracts/research.ts';
import {
	agentSpecForResearchKnowledgeHandler,
	followupTaskIdempotencyKey,
	graphVersionForTask,
	invocationForResearchKnowledgeTask,
	isResearchKnowledgeTaskKind,
	summarizeKnowledgeDraftArtifact,
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

function readCapacityEnvelope(payload: Record<string, unknown>): CapacityTaskExecutionEnvelope | null {
	const envelope = asRecord(payload.capacityEnvelope);
	return Object.keys(envelope).length > 0 ? envelope as CapacityTaskExecutionEnvelope : null;
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
	};
}

function runnerRepositoryPath(volumeRoot: string, repositoryId: string, taskId: string) {
	const repositoryRoot = join(volumeRoot, 'repositories', repositoryId);
	return {
		repositoryRoot,
		bareGit: join(repositoryRoot, 'bare.git'),
		worktree: join(repositoryRoot, 'worktrees', taskId),
	};
}

function runnerComposedWorkspacePath(volumeRoot: string, hubId: string) {
	const workspaceRoot = join(volumeRoot, 'workspaces', hubId);
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

function scopedSdkForHandler(sdk: ReturnType<typeof createServiceSdk>, agent: ReturnType<typeof agentSpecForResearchKnowledgeHandler>) {
	const maybeScoped = sdk as unknown as {
		scopeForAgent?: (agent: ReturnType<typeof agentSpecForResearchKnowledgeHandler>) => unknown;
		buildContextPack?: unknown;
		createMessage?: (request: Record<string, unknown>) => Promise<unknown>;
		appendTaskEvent?: (request: Record<string, unknown>) => Promise<unknown>;
	};
	if (typeof maybeScoped.scopeForAgent === 'function') {
		return maybeScoped.scopeForAgent(agent);
	}
	return {
		buildContextPack: maybeScoped.buildContextPack?.bind(sdk),
		createMessage: (request: Record<string, unknown>) => maybeScoped.createMessage?.({ ...request, actor: agent.slug }),
		appendTaskEvent: maybeScoped.appendTaskEvent?.bind(sdk),
	};
}

function contextForResearchKnowledgeHandler(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	repoRoot: string;
	kind: 'researcher' | 'knowledge_generator' | 'knowledge_optimizer';
	payload: Record<string, unknown>;
}) {
	const agent = agentSpecForResearchKnowledgeHandler(input.kind);
	return {
		runId: `${input.kind}-${Date.now()}`,
		repoRoot: input.repoRoot,
		agent,
		sdk: scopedSdkForHandler(input.sdk, agent),
		trigger: invocationForResearchKnowledgeTask(
			input.kind === 'researcher'
				? 'research_question'
				: input.kind === 'knowledge_generator'
					? 'generate_knowledge_draft'
					: 'optimize_knowledge_draft',
			input.payload,
		),
		execution: {},
		mutations: {},
		repository: {},
		verification: {},
		notifications: {},
		research: {},
		operations: {},
	} as AgentContext;
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
		const queue = createQueuePushClient();
		if (queue) {
			await queue.enqueue({
				message: queueEnvelopeForTask(createdTask),
				delaySeconds: 0,
			});
			await input.sdk.recordTaskProgress({
				id: createdTaskId,
				state: 'queued',
				appendEvent: {
					kind: 'queued',
					data: { queueName: process.env.TREESEED_QUEUE_ID ?? null },
				},
				actor: 'worker',
			});
		}
	}
	return createdTaskId || null;
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

export async function executeResearchKnowledgeTask(input: {
	sdk: ReturnType<typeof createServiceSdk>;
	task: Record<string, unknown>;
	taskKind: ResearchKnowledgeTaskKind;
	workerId: string;
	queueAttempt: number;
	enqueueFollowups?: boolean;
	promotionDependencies?: KnowledgePromotionDependencies;
}) {
	const payload = taskPayload(input.task);
	const workDayId = workDayIdForTask(input.task);
	const graphVersion = graphVersionForTask(input.task);
	const taskId = taskRecordId(input.task);
	const repoRoot = resolveServiceRepoRoot();
	const enqueueFollowups = input.enqueueFollowups ?? true;

	if (input.taskKind === 'research_question') {
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'researcher',
			payload: { ...payload, taskId },
		});
		const { result, output } = await runBuiltInHandler(researcherHandler, context);
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
			status: output.status,
			summary: output.summary,
		});
	}

	if (input.taskKind === 'generate_knowledge_draft') {
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'knowledge_generator',
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
			status: output.status,
			summary: output.summary,
		});
	}

	if (input.taskKind === 'optimize_knowledge_draft') {
		const context = contextForResearchKnowledgeHandler({
			sdk: input.sdk,
			repoRoot,
			kind: 'knowledge_optimizer',
			payload: { ...payload, taskId },
		});
		const { result, output } = await runBuiltInHandler(knowledgeOptimizerHandler, context);
		const report = result as OptimizationReport | null;
		const generatedArtifacts = report ? [summarizeOptimizationReportArtifact(report, taskId)] : [];
		const draft = asRecord(payload.knowledgeDraft) as unknown as KnowledgeDraft;
		const note = asRecord(payload.researchNote) as unknown as ResearchNote;
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
		const nextTaskId = promotionRequest && workDayId
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
			: null;
		return envelope({
			artifactKind: 'optimization_report',
			optimizationReport: report ?? undefined,
			promotionRequest: promotionRequest ?? undefined,
			generatedArtifacts: [
				...generatedArtifacts,
				...(promotionRequest ? [summarizePromotionRequestArtifact(promotionRequest, nextTaskId ?? undefined)] : []),
			],
			nextTaskId,
			status: output.status,
			summary: output.summary,
		});
	}

	if (input.taskKind === 'promote_knowledge_to_staging') {
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
		const releaseRequest = promotion.releaseRequest;
		const nextTaskId = releaseRequest && workDayId
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
		return envelope({
			artifactKind: releaseRequest ? 'release_request' : 'promotion_request',
			promotionRequest: asRecord(payload.promotionRequest),
			releaseRequest: releaseRequest ?? undefined,
			generatedArtifacts: [
				...(releaseRequest ? [summarizeReleaseRequestArtifact(releaseRequest, nextTaskId ?? undefined)] : []),
			],
			nextTaskId,
			status: promotion.status === 'staged' ? 'completed' : promotion.status === 'waiting' ? 'waiting' : 'failed',
			summary: promotion.summary,
			promotionToStaging: promotion,
		} as unknown as Omit<ResearchKnowledgeTaskOutputEnvelope, 'summary'> & {
			status: ResearchKnowledgeTaskOutputEnvelope['summary']['status'];
			summary: string;
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
	const executionKind = typeof payload.executionKind === 'string' ? payload.executionKind : null;
	const taskKind = String(task?.type ?? task?.taskType ?? '');
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
		const graphRefresh = await options.sdk.refreshGraph();
		const graphVersion = graphRefresh.snapshotRoot;
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
				}
				: null,
	};
}

export async function runWorkerCycle() {
	const sdk = createServiceSdk();
	const queue = createQueueClient();
	const config = resolveWorkerConfig();
	const kernel = new AgentKernel(sdk, resolveServiceRepoRoot());
	if (typeof sdk.recordWorkerRunner === 'function') {
		await sdk.recordWorkerRunner({
			projectId: config.projectId,
			environment: config.environment as 'local' | 'staging' | 'prod',
			runnerId: config.workerId,
			runnerServiceName: config.runnerServiceName,
			volumeIdentity: config.volumeIdentity,
			state: 'active',
			maxLocalWorkers: config.maxLocalWorkers,
			activeLocalWorkers: 0,
			metadata: {
				volumeRoot: config.volumeRoot,
			},
		}).catch(() => null);
	}
	if (!queue) {
		if (process.env.TREESEED_LOCAL_DEV_MODE?.trim()) {
			return { ok: true, processed: 0, idle: true, reason: 'queue_unconfigured' };
		}
		throw new Error('Worker requires CLOUDFLARE_ACCOUNT_ID, TREESEED_QUEUE_ID, and TREESEED_QUEUE_PULL_TOKEN.');
	}

	const pulled = await queue.pull({
		batchSize: config.batchSize,
		visibilityTimeoutMs: config.visibilityTimeoutMs,
	});
	if (pulled.messages.length === 0) {
		return { ok: true, processed: 0 };
	}

	const maxLocalWorkers = Number.isFinite(Number(config.maxLocalWorkers)) ? Math.max(1, Number(config.maxLocalWorkers)) : 1;
	const selectedMessages = pulled.messages.slice(0, maxLocalWorkers);
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

			await sdk.completeTask({
				id: message.body.taskId,
				output,
				summary: output.summary,
				actor: 'worker',
			});
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
					},
					usageActual: {
						taskSignature: output.capacityUsage.taskSignature ?? String(output.agentSlug ?? 'agent_trigger'),
						actualCredits: output.capacityUsage.credits,
						retryCount: Math.max(0, message.attempts - 1),
						metadata: {
							workerId: config.workerId,
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

	return { ok: true, processed: results.reduce((sum, value) => sum + value, 0) };
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
	if (typeof sdk.recordWorkerRunner !== 'function') {
		return;
	}
	await sdk.recordWorkerRunner({
		projectId: config.projectId,
		environment: config.environment as 'local' | 'staging' | 'prod',
		runnerId: config.workerId,
		runnerServiceName: config.runnerServiceName,
		volumeIdentity: config.volumeIdentity,
		state: 'sleeping',
		maxLocalWorkers: config.maxLocalWorkers,
		activeLocalWorkers: 0,
		metadata: {
			volumeRoot: config.volumeRoot,
			reason: 'idle_exit',
		},
	}).catch(() => null);
}

export async function startWorkerLoop() {
	const config = resolveWorkerConfig();
	let idleSince: number | null = null;
	for (;;) {
		try {
			const result = await runWorkerCycle();
			const processed = Number((result as { processed?: unknown }).processed ?? 0);
			if (processed > 0) {
				idleSince = null;
			} else {
				idleSince ??= Date.now();
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
