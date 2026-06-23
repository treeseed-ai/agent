import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { CapacityGrant } from '@treeseed/sdk';
import type { ProviderRuntimeConfig } from './config.ts';
import { discoverProviderBudgets } from './budgets.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { fetchProviderPortfolio, summarizeProviderPortfolio } from './portfolio.ts';
import { createProviderMarketClient } from './client.ts';
import { processProviderPortfolio } from './portfolio-processing.ts';

function isCapacityGrant(value: unknown): value is CapacityGrant {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const grant = value as Partial<CapacityGrant>;
	return typeof grant.id === 'string'
		&& typeof grant.capacityProviderId === 'string'
		&& typeof grant.laneId === 'string'
		&& typeof grant.grantScope === 'string'
		&& typeof grant.state === 'string'
		&& typeof grant.projectId === 'string';
}

function capacityGrantsFromPortfolio(value: unknown): CapacityGrant[] {
	return Array.isArray(value) ? value.filter(isCapacityGrant) : [];
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
		apiPort: config.apiPort,
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

export async function runRunnerSkeleton(config: ProviderRuntimeConfig, options: { dryRun?: boolean } = {}) {
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
	return okPayload('runner', {
		dryRun: false,
		flow,
		result: await runProviderRunnerOnce({
			config,
			client,
			...(config.treeDx ? { treeDx: config.treeDx } : {}),
		}),
	});
}
