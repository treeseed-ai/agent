import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSdk } from '@treeseed/sdk';
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
