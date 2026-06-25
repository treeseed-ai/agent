import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CapacityGrant } from '@treeseed/sdk';
import type { ProviderRuntimeConfig } from './config.ts';
import { discoverProviderBudgets } from './budgets.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { fetchProviderPortfolio, summarizeProviderPortfolio } from './portfolio.ts';
import { createProviderMarketClient } from './client.ts';
import { processProviderPortfolio } from './portfolio-processing.ts';

function normalizeCapacityGrant(value: unknown): CapacityGrant | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const grant = value as Partial<CapacityGrant> & { grantId?: unknown; providerId?: unknown; scope?: unknown };
	const id = typeof grant.id === 'string' ? grant.id : typeof grant.grantId === 'string' ? grant.grantId : '';
	if (!id) return null;
	return {
		...grant,
		id,
		capacityProviderId: typeof grant.capacityProviderId === 'string'
			? grant.capacityProviderId
			: typeof grant.providerId === 'string'
				? grant.providerId
				: '',
		laneId: typeof grant.laneId === 'string' ? grant.laneId : '',
		grantScope: typeof grant.grantScope === 'string'
			? grant.grantScope
			: typeof grant.scope === 'string'
				? grant.scope
				: '',
		state: typeof grant.state === 'string' ? grant.state : 'active',
		projectId: typeof grant.projectId === 'string' ? grant.projectId : null,
	} as CapacityGrant;
}

function capacityGrantsFromPortfolio(value: unknown): CapacityGrant[] {
	return Array.isArray(value) ? value.map(normalizeCapacityGrant).filter((grant): grant is CapacityGrant => Boolean(grant)) : [];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function okPayload(role: string, payload: Record<string, unknown> = {}) {
	return {
		ok: true,
		role,
		...payload,
	};
}

export async function checkProviderHealth(config: ProviderRuntimeConfig) {
	let dataDirWritable = false;
	try {
		await mkdir(config.dataDir, { recursive: true });
		await access(config.dataDir, constants.W_OK);
		dataDirWritable = true;
	} catch {
		dataDirWritable = false;
	}
	return okPayload('healthcheck', {
		status: dataDirWritable ? 'ok' : 'degraded',
		environment: config.environment,
		dataDir: config.dataDir,
		dataDirWritable,
		marketConfigured: Boolean(config.marketUrl),
		apiKeyConfigured: Boolean(config.apiKey),
		codexReady: Boolean(config.codexAuthFile || config.codexAuthJsonB64),
	});
}

export async function buildProviderPlan(config: ProviderRuntimeConfig, options: { dryRun?: boolean } = {}) {
	const base = {
		environment: config.environment,
		marketUrl: config.marketUrl || null,
		marketId: config.marketId || null,
		dataDir: config.dataDir,
		capabilities: discoverProviderCapabilities(config),
		budgets: discoverProviderBudgets(config),
		redactedEnv: config.redactedEnv,
	};
	if (options.dryRun || !config.apiKey || !config.marketUrl) {
		return okPayload('plan', {
			...base,
			portfolio: null,
			dryRun: true,
		});
	}
	const portfolio = await fetchProviderPortfolio(config);
	return okPayload('plan', {
		...base,
		portfolio: summarizeProviderPortfolio(portfolio),
		dryRun: false,
	});
}

export async function runManagerSkeleton(config: ProviderRuntimeConfig, options: { dryRun?: boolean } = {}) {
	if (!options.dryRun && config.apiKey && config.marketUrl) {
		const client = createProviderMarketClient(config);
		const portfolio = await client.portfolio().catch(() => null);
		const portfolioGrants = capacityGrantsFromPortfolio(portfolio?.grants);
		const capabilities = [...new Set(discoverProviderCapabilities(config).flatMap((capability) => [
			capability.id,
			...(Array.isArray(capability.metadata?.capabilityAliases)
				? capability.metadata.capabilityAliases.map((entry) => String(entry ?? '').trim()).filter(Boolean)
				: []),
		]).filter(Boolean))];
		const checkIn = await client.checkIn({
			environment: config.environment,
			status: 'open',
			capabilities,
			nativeLimits: {
				budgets: discoverProviderBudgets(config),
			},
			runnerPressure: {
				activeRunners: 0,
				maxConcurrentRunners: config.maxConcurrentRunners,
				maxConcurrentWorkdays: config.maxConcurrentWorkdays,
			},
			grants: portfolioGrants,
			constraints: {
				outboundOnly: true,
				dataDir: config.dataDir,
			},
			metadata: {
				source: '@treeseed/agent/provider-manager',
			},
		});
		const result = await processProviderPortfolio({
			config,
			client,
			...(portfolio ? { portfolio } : {}),
			...(config.treeDx ? { treeDx: config.treeDx } : {}),
		});
		return okPayload('manager', {
			action: 'portfolio-processing',
			dryRun: false,
			checkIn: checkIn.payload,
			result,
		});
	}
	const plan = await buildProviderPlan(config, options);
	return okPayload('manager', {
		action: 'portfolio-plan',
		dryRun: options.dryRun === true,
		plan,
	});
}

type BackgroundRunnerState = {
	active: Map<string, { startedAt: string }>;
	completed: Array<Record<string, unknown>>;
};

const backgroundRunnerState: BackgroundRunnerState = {
	active: new Map(),
	completed: [],
};

function rememberCompletedRunner(result: Record<string, unknown>) {
	backgroundRunnerState.completed.push(result);
	if (backgroundRunnerState.completed.length > 100) {
		backgroundRunnerState.completed.splice(0, backgroundRunnerState.completed.length - 100);
	}
}

export async function runRunnerSkeleton(config: ProviderRuntimeConfig, options: { dryRun?: boolean; background?: boolean } = {}) {
	const flow = [
		'request next leased assignment from Market provider endpoint',
		'record provider-local mode-run telemetry',
		'complete or fail assignment without widening scope',
	];
	if (options.dryRun || !config.apiKey || !config.marketUrl) {
		return okPayload('runner', {
			dryRun: true,
			flow,
			assignmentRequest: {
				capabilities: discoverProviderCapabilities(config).map((capability) => capability.id),
			},
		});
	}
	const client = createProviderMarketClient(config);
	const { runProviderRunnerOnce } = await import('./runner.ts');
	const runnerCount = Math.max(1, Math.min(config.maxConcurrentRunners, 8));
	const startedAt = new Date().toISOString();
	if (options.background) {
		const completedSinceLastTick = backgroundRunnerState.completed.splice(0);
		const startedRunners: Array<{ runnerId: string; startedAt: string }> = [];
		for (let index = 0; index < runnerCount; index += 1) {
			const runnerId = `provider-runner-${index + 1}`;
			if (backgroundRunnerState.active.has(runnerId)) continue;
			const runnerStartedAt = new Date().toISOString();
			backgroundRunnerState.active.set(runnerId, { startedAt: runnerStartedAt });
			startedRunners.push({ runnerId, startedAt: runnerStartedAt });
			void runProviderRunnerOnce({
				config,
				client,
				runnerId,
				...(config.treeDx ? { treeDx: config.treeDx } : {}),
			})
				.then((result) => {
					rememberCompletedRunner({
						runnerId,
						startedAt: runnerStartedAt,
						completedAt: new Date().toISOString(),
						...record(result),
					});
				})
				.catch((error) => {
					rememberCompletedRunner({
						ok: false,
						role: 'runner',
						runnerId,
						startedAt: runnerStartedAt,
						completedAt: new Date().toISOString(),
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					backgroundRunnerState.active.delete(runnerId);
				});
		}
		return okPayload('runner', {
			dryRun: false,
			flow,
			startedAt,
			completedAt: new Date().toISOString(),
			concurrency: runnerCount,
			background: true,
			active: Array.from(backgroundRunnerState.active.entries()).map(([runnerId, state]) => ({
				runnerId,
				startedAt: state.startedAt,
			})),
			startedRunners,
			completedSinceLastTick,
		});
	}
	const results = await Promise.all(Array.from({ length: runnerCount }, (_, index) => runProviderRunnerOnce({
		config,
		client,
		runnerId: `provider-runner-${index + 1}`,
		...(config.treeDx ? { treeDx: config.treeDx } : {}),
	}).catch((error) => ({
		ok: false,
		role: 'runner',
		runnerId: `provider-runner-${index + 1}`,
		error: error instanceof Error ? error.message : String(error),
	}))));
	return okPayload('runner', {
		dryRun: false,
		flow,
		startedAt,
		completedAt: new Date().toISOString(),
		concurrency: runnerCount,
		results,
		result: results[0] ?? null,
	});
}
