import crypto from 'node:crypto';
import { AgentSdk } from '@treeseed/sdk';
import { CloudflareQueuePullClient } from '@treeseed/sdk/remote';
import type { SdkQueueMessageEnvelope } from '@treeseed/sdk';

function integerFromEnv(name: string, fallback: number) {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveServiceRepoRoot() {
	return process.env.TREESEED_AGENT_REPO_ROOT?.trim() || process.cwd();
}

export function createServiceSdk() {
	return AgentSdk.createLocal({
		repoRoot: resolveServiceRepoRoot(),
		databaseName: process.env.TREESEED_AGENT_D1_DATABASE ?? 'karyon-docs-site-data',
		persistTo: process.env.TREESEED_AGENT_D1_PERSIST_TO ?? undefined,
	});
}

function createQueueClientConfig(token: string) {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const queueId = process.env.TREESEED_QUEUE_ID?.trim();
	if (!accountId || !queueId || !token) {
		return null;
	}
	return {
		accountId,
		queueId,
		token,
		apiBaseUrl: process.env.TREESEED_QUEUE_API_BASE_URL?.trim() || undefined,
	};
}

export function createQueueClient() {
	const config = createQueueClientConfig(process.env.TREESEED_QUEUE_PULL_TOKEN?.trim() || '');
	if (!config) {
		return null;
	}
	return new CloudflareQueuePullClient(config);
}

export function createQueuePushClient() {
	const config = createQueueClientConfig(
		process.env.TREESEED_QUEUE_PUSH_TOKEN?.trim()
		|| process.env.CLOUDFLARE_API_TOKEN?.trim()
		|| '',
	);
	if (!config) {
		return null;
	}
	const apiBaseUrl = config.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4/accounts';
	const baseUrl = `${apiBaseUrl.replace(/\/$/u, '')}/${config.accountId}/queues/${config.queueId}`;
	return {
		async enqueue(request: { message: SdkQueueMessageEnvelope; delaySeconds?: number }) {
			const response = await fetch(`${baseUrl}/messages`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${config.token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					body: request.message,
					content_type: 'json',
					delay_seconds: request.delaySeconds ?? 0,
				}),
			});
			const payload = await response.json().catch(() => ({})) as {
				success?: boolean;
				errors?: Array<{ message?: string }>;
			};
			if (!response.ok || payload.success === false) {
				throw new Error(payload.errors?.[0]?.message ?? `Queue request failed with ${response.status}.`);
			}
		},
	};
}

export function queueEnvelopeForTask(task: Record<string, unknown>): SdkQueueMessageEnvelope {
	return {
		messageId: crypto.randomUUID(),
		taskId: String(task.id ?? ''),
		workDayId: String(task.workDayId ?? task.work_day_id ?? ''),
		agentId: String(task.agentId ?? task.agent_id ?? ''),
		taskType: String(task.type ?? ''),
		idempotencyKey: String(task.idempotencyKey ?? task.idempotency_key ?? ''),
		attempt: Number(task.attemptCount ?? task.attempt_count ?? 0) + 1,
		payloadRef: `d1:tasks/${String(task.id ?? '')}`,
		graphVersion:
			task.graphVersion !== undefined && task.graphVersion !== null
				? String(task.graphVersion)
				: task.graph_version !== undefined && task.graph_version !== null
					? String(task.graph_version)
					: null,
		budgetHint: 1,
	};
}

export async function enqueueTaskFromSdk(
	sdk: AgentSdk,
	request: {
		taskId: string;
		queueName?: string;
		deliveryDelaySeconds?: number;
		actor?: string;
	},
) {
	const queue = createQueuePushClient();
	if (!queue) {
		throw new Error('Queue push client not configured.');
	}
	const task = await sdk.get({ model: 'task', id: request.taskId });
	if (!task.payload) {
		throw new Error('Unknown task.');
	}
	await queue.enqueue({
		message: queueEnvelopeForTask(task.payload as Record<string, unknown>),
		delaySeconds: request.deliveryDelaySeconds ?? 0,
	});
	await sdk.recordTaskProgress({
		id: request.taskId,
		state: 'queued',
		appendEvent: { kind: 'queued', data: { queueName: request.queueName ?? null } },
		actor: request.actor,
	});
	return { ok: true, taskId: request.taskId, queued: true };
}

export async function buildTaskContext(sdk: AgentSdk, taskId: string) {
	const context = await sdk.getManagerContext(taskId);
	const task = context.payload.task;
	const agent = task
		? (await sdk.get({ model: 'agent', slug: String(task.agentId) })).payload
		: null;
	return {
		...context.payload,
		agent,
	};
}

export async function seedRootTasks(sdk: AgentSdk, workDayId: string) {
	const specs = await sdk.listAgentSpecs({ enabled: true });
	const created = [];
	for (const spec of specs) {
		const hasStartTrigger = spec.triggers.some((trigger) => trigger.type === 'startup' || trigger.type === 'schedule');
		if (!hasStartTrigger) continue;
		created.push(await sdk.createTask({
			workDayId,
			agentId: spec.slug,
			type: 'agent_root',
			priority: 100,
			idempotencyKey: `${workDayId}:${spec.slug}:root`,
			payload: {
				agentSlug: spec.slug,
				handler: spec.handler,
				triggerKinds: spec.triggers.map((entry) => entry.type),
			},
			graphVersion: null,
			actor: 'manager',
		}));
	}
	return created;
}

export async function seedGraphRefreshTask(
	sdk: AgentSdk,
	request: {
		workDayId: string;
		projectId: string;
		repositoryId?: string | null;
		actor?: string;
	},
) {
	const task = await sdk.createTask({
		workDayId: request.workDayId,
		agentId: 'system',
		type: 'refresh_project_graph',
		priority: 1000,
		idempotencyKey: `${request.workDayId}:refresh_project_graph`,
		payload: {
			projectId: request.projectId,
			repositoryId: request.repositoryId ?? request.projectId,
		},
		graphVersion: null,
		actor: request.actor ?? 'manager',
	});
	return task.payload;
}

export async function startAndSeedWorkday(
	sdk: AgentSdk,
	request: {
		id?: string;
		projectId: string;
		capacityBudget: number;
		actor?: string;
	},
) {
	const workDay = await sdk.startWorkDay({
		id: request.id,
		projectId: request.projectId,
		capacityBudget: request.capacityBudget,
		graphVersion: null,
		summary: { graphRefresh: { state: 'queued' } },
		actor: request.actor ?? 'manager',
	});
	const graphTask = workDay.payload
		? await seedGraphRefreshTask(sdk, {
			workDayId: String(workDay.payload.id),
			projectId: request.projectId,
			actor: request.actor ?? 'manager',
		})
		: null;
	const tasks = workDay.payload ? await seedRootTasks(sdk, String(workDay.payload.id)) : [];
	return {
		ok: true,
		workDay: workDay.payload,
		seededTasks: [graphTask, ...tasks.map((entry) => entry.payload).filter(Boolean)].filter(Boolean),
	};
}

export function resolveManagerConfig() {
	return {
		host: process.env.HOST?.trim() || '0.0.0.0',
		port: integerFromEnv('PORT', 3100),
		projectId: process.env.TREESEED_PROJECT_ID?.trim() || 'treeseed-market',
		defaultCapacityBudget: integerFromEnv('TREESEED_WORKDAY_CAPACITY_BUDGET', 100),
	};
}

export function resolveWorkerConfig() {
	return {
		workerId: process.env.TREESEED_WORKER_ID?.trim() || `worker-${process.pid}`,
		batchSize: integerFromEnv('TREESEED_QUEUE_BATCH_SIZE', integerFromEnv('TREESEED_RUNNER_MAX_LOCAL_WORKERS', 4)),
		maxLocalWorkers: integerFromEnv('TREESEED_RUNNER_MAX_LOCAL_WORKERS', 4),
		runnerServiceName: process.env.TREESEED_RUNNER_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_NAME?.trim() || `worker-runner-${process.pid}`,
		volumeRoot: process.env.TREESEED_RUNNER_VOLUME_ROOT?.trim() || process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || '.treeseed-runner',
		volumeIdentity: process.env.TREESEED_RUNNER_VOLUME_ID?.trim() || process.env.RAILWAY_VOLUME_ID?.trim() || process.env.RAILWAY_VOLUME_NAME?.trim() || 'local-runner-volume',
		projectId: process.env.TREESEED_PROJECT_ID?.trim() || 'treeseed-market',
		environment: process.env.TREESEED_DEPLOY_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'prod' : 'local'),
		visibilityTimeoutMs: integerFromEnv('TREESEED_QUEUE_VISIBILITY_TIMEOUT_MS', 120000),
		pollIntervalMs: integerFromEnv('TREESEED_WORKER_POLL_INTERVAL_MS', 5000),
		idleExitMs: integerFromEnv('TREESEED_WORKER_IDLE_EXIT_MS', 0),
		leaseSeconds: integerFromEnv('TREESEED_TASK_LEASE_SECONDS', 120),
	};
}
