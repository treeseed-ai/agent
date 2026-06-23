import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSdk } from '@treeseed/sdk';
import { CODEBASE_DOCUMENTATION_SCAN_TASK_KIND } from './codebase-documentation-scanner.ts';
import { HostedControlPlaneAgentSdk, HostedRunnerControlPlaneClient } from './hosted-control-plane-sdk.ts';
import { resolveProcessingDataDir } from './runtime-paths.ts';

function integerFromEnv(name: string, fallback: number) {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveServiceRepoRoot() {
	return process.env.TREESEED_AGENT_REPO_ROOT?.trim() || process.cwd();
}

function resolveLocalD1PersistTo() {
	const explicit = process.env.TREESEED_AGENT_D1_PERSIST_TO?.trim();
	if (explicit) return explicit;
	const d1Root = resolve(resolveServiceRepoRoot(), '.treeseed/generated/environments/local/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
	if (!existsSync(d1Root)) return undefined;
	const candidates = readdirSync(d1Root)
		.filter((entry) => entry.endsWith('.sqlite') && entry !== 'metadata.sqlite')
		.map((entry) => {
			const path = resolve(d1Root, entry);
			return { path, size: statSync(path).size };
		})
		.sort((left, right) => right.size - left.size);
	return candidates[0]?.path;
}

export type AgentServiceRuntimeMode = 'local' | 'hosted';

export function resolveAgentServiceRuntimeMode(): AgentServiceRuntimeMode {
	const explicit = process.env.TREESEED_AGENT_RUNTIME_MODE?.trim().toLowerCase();
	if (explicit === 'hosted' || explicit === 'local') return explicit;
	if (
		(process.env.TREESEED_MARKET_API_BASE_URL?.trim() || process.env.TREESEED_API_BASE_URL?.trim())
		&& process.env.TREESEED_PROJECT_RUNNER_TOKEN?.trim()
	) {
		return 'hosted';
	}
	return 'local';
}

function createLocalServiceSdk() {
	return AgentSdk.createLocal({
		repoRoot: resolveServiceRepoRoot(),
		databaseName: process.env.TREESEED_AGENT_D1_DATABASE ?? 'docs-site-data',
		persistTo: resolveLocalD1PersistTo(),
	});
}

export function createServiceSdk() {
	const localSdk = createLocalServiceSdk();
	if (resolveAgentServiceRuntimeMode() !== 'hosted') {
		return localSdk;
	}
	const baseUrl = process.env.TREESEED_MARKET_API_BASE_URL?.trim() || process.env.TREESEED_API_BASE_URL?.trim();
	const runnerToken = process.env.TREESEED_PROJECT_RUNNER_TOKEN?.trim();
	const projectId = process.env.TREESEED_PROJECT_ID?.trim();
	if (!baseUrl || !runnerToken || !projectId) {
		return localSdk;
	}
	return new HostedControlPlaneAgentSdk({
		projectId,
		environment: process.env.TREESEED_DEPLOY_ENVIRONMENT?.trim() || process.env.TREESEED_ENVIRONMENT?.trim() || 'staging',
		client: new HostedRunnerControlPlaneClient({
			baseUrl,
			accessToken: runnerToken,
		}),
		localSdk,
	}) as unknown as AgentSdk;
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

export async function seedCodebaseDocumentationScanTask(
	sdk: AgentSdk,
	request: {
		workDayId: string;
		projectId: string;
		repositoryId?: string | null;
		actor?: string;
	},
) {
	const idempotencyKey = `${request.workDayId}:${CODEBASE_DOCUMENTATION_SCAN_TASK_KIND}`;
	const searchTasks = (sdk as unknown as {
		searchTasks?: (query: { workDayId?: string; limit?: number; state?: string | string[] }) => Promise<{ payload: unknown }>;
	}).searchTasks;
	if (typeof searchTasks === 'function') {
		const existing = await searchTasks.call(sdk, { workDayId: request.workDayId, limit: 1000 });
		const tasks = Array.isArray(existing.payload) ? existing.payload as Array<Record<string, unknown>> : [];
		const found = tasks.find((task) => {
			const key = typeof task.idempotencyKey === 'string' ? task.idempotencyKey : typeof task.idempotency_key === 'string' ? task.idempotency_key : '';
			return key === idempotencyKey;
		});
		if (found) return found;
	}
	const task = await sdk.createTask({
		workDayId: request.workDayId,
		agentId: 'treeseed-codebase-cartographer',
		type: CODEBASE_DOCUMENTATION_SCAN_TASK_KIND,
		priority: 990,
		idempotencyKey,
		payload: {
			executionKind: 'codebase_documentation_scan',
			projectId: request.projectId,
			repositoryId: request.repositoryId ?? request.projectId,
			maxKnowledgeGapMessages: 8,
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
	const scanTask = workDay.payload
		? await seedCodebaseDocumentationScanTask(sdk, {
			workDayId: String(workDay.payload.id),
			projectId: request.projectId,
			actor: request.actor ?? 'manager',
		})
		: null;
	const tasks = workDay.payload ? await seedRootTasks(sdk, String(workDay.payload.id)) : [];
	return {
		ok: true,
		workDay: workDay.payload,
		seededTasks: [graphTask, scanTask, ...tasks.map((entry) => entry.payload).filter(Boolean)].filter(Boolean),
	};
}

export function resolveManagerConfig() {
	const capacityBudget = integerFromEnv(
		'TREESEED_CAPACITY_BUDGET',
		integerFromEnv('TREESEED_WORKDAY_TASK_CREDIT_BUDGET', 100),
	);
	return {
		host: process.env.HOST?.trim() || '0.0.0.0',
		port: integerFromEnv('PORT', 3100),
		projectId: process.env.TREESEED_PROJECT_ID?.trim() || 'treeseed-market',
		defaultCapacityBudget: capacityBudget,
		workDayId: process.env.TREESEED_WORKDAY_ID?.trim() || null,
		docsAutomationMode: process.env.TREESEED_DOCS_AUTOMATION_MODE?.trim() || 'on',
		approvalPolicy: process.env.TREESEED_APPROVAL_POLICY?.trim() || 'manual',
	};
}

export function resolveWorkerConfig() {
	return {
		workerId: process.env.TREESEED_WORKER_ID?.trim() || `worker-${process.pid}`,
		batchSize: integerFromEnv('TREESEED_WORKER_BATCH_SIZE', integerFromEnv('TREESEED_RUNNER_MAX_LOCAL_WORKERS', 4)),
		maxLocalWorkers: integerFromEnv('TREESEED_RUNNER_MAX_LOCAL_WORKERS', 4),
		runnerServiceName: process.env.TREESEED_RUNNER_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_NAME?.trim() || `worker-runner-${process.pid}`,
		volumeRoot: resolveProcessingDataDir(),
		volumeIdentity: process.env.TREESEED_RUNNER_VOLUME_ID?.trim() || process.env.RAILWAY_VOLUME_ID?.trim() || process.env.RAILWAY_VOLUME_NAME?.trim() || 'local-runner-volume',
		projectId: process.env.TREESEED_PROJECT_ID?.trim() || 'treeseed-market',
		environment: process.env.TREESEED_DEPLOY_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'prod' : 'local'),
		visibilityTimeoutMs: integerFromEnv('TREESEED_WORKER_VISIBILITY_TIMEOUT_MS', 120000),
		pollIntervalMs: integerFromEnv('TREESEED_WORKER_POLL_INTERVAL_MS', 5000),
		idleExitMs: integerFromEnv('TREESEED_WORKER_IDLE_EXIT_MS', 0),
		leaseSeconds: integerFromEnv('TREESEED_TASK_LEASE_SECONDS', 120),
	};
}
