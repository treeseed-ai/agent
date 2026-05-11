#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import { createControlPlaneReporter } from '@treeseed/sdk';
import type { CapacityTaskExecutionEnvelope } from '@treeseed/sdk';
import { buildTaskContext, createQueueClient, createServiceSdk, resolveServiceRepoRoot, resolveWorkerConfig } from './common.ts';

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

function readCapacityEnvelope(payload: Record<string, unknown>): CapacityTaskExecutionEnvelope | null {
	const envelope = asRecord(payload.capacityEnvelope);
	return Object.keys(envelope).length > 0 ? envelope as CapacityTaskExecutionEnvelope : null;
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
	if (String(task?.type ?? task?.taskType ?? '') === 'refresh_project_graph') {
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
					phase: 'consume',
					credits: output.capacityUsage.credits,
					source: 'worker',
					metadata: {
						workerId: config.workerId,
						queueAttempt: message.attempts,
					},
				}).catch(() => null);
			}

			await queue.ack([message.leaseId]);
			return 1;
		} catch (error) {
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

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	await startWorkerLoop();
}
