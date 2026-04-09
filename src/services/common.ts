import { AgentSdk } from '@treeseed/sdk/sdk';
import { TreeseedGatewayClient, CloudflareQueuePullClient } from '@treeseed/sdk/remote';

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

export function createGatewayClient() {
	const baseUrl = process.env.TREESEED_GATEWAY_BASE_URL?.trim();
	const bearerToken = process.env.TREESEED_GATEWAY_BEARER_TOKEN?.trim();
	if (!baseUrl || !bearerToken) {
		return null;
	}
	return new TreeseedGatewayClient({ baseUrl, bearerToken });
}

export function createQueueClient() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const queueId = process.env.TREESEED_QUEUE_ID?.trim();
	const token = process.env.TREESEED_QUEUE_PULL_TOKEN?.trim();
	if (!accountId || !queueId || !token) {
		return null;
	}
	return new CloudflareQueuePullClient({
		accountId,
		queueId,
		token,
		apiBaseUrl: process.env.TREESEED_QUEUE_API_BASE_URL?.trim() || undefined,
	});
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
		batchSize: integerFromEnv('TREESEED_QUEUE_BATCH_SIZE', 1),
		visibilityTimeoutMs: integerFromEnv('TREESEED_QUEUE_VISIBILITY_TIMEOUT_MS', 120000),
		pollIntervalMs: integerFromEnv('TREESEED_WORKER_POLL_INTERVAL_MS', 5000),
		leaseSeconds: integerFromEnv('TREESEED_TASK_LEASE_SECONDS', 120),
		managerBaseUrl:
			process.env.TREESEED_MANAGER_BASE_URL?.trim()
			|| `http://${process.env.TREESEED_MANAGER_HOST?.trim() || 'manager.railway.internal'}:${integerFromEnv('TREESEED_MANAGER_PORT', 3100)}`,
	};
}
