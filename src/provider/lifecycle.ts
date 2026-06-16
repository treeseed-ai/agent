import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ProviderRuntimeConfig } from './config.ts';
import { discoverProviderBudgets } from './budgets.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { fetchProviderPortfolio, summarizeProviderPortfolio } from './portfolio.ts';
import { createProviderMarketClient } from './client.ts';
import { processProviderPortfolio } from './portfolio-processing.ts';
import { runProviderRunnerOnce } from './runner.ts';

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
		const checkIn = await client.checkIn({
			environment: config.environment,
			status: 'open',
			capabilities: discoverProviderCapabilities(config).map((capability) => capability.id),
			nativeLimits: {
				budgets: discoverProviderBudgets(config),
			},
			runnerPressure: {
				activeRunners: 0,
				maxConcurrentRunners: config.maxConcurrentRunners,
				maxConcurrentWorkdays: config.maxConcurrentWorkdays,
			},
			constraints: {
				outboundOnly: true,
				dataDir: config.dataDir,
			},
			metadata: {
				source: '@treeseed/agent/provider-manager',
			},
		});
		const result = await processProviderPortfolio({ config, client });
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
	return okPayload('runner', {
		dryRun: false,
		flow,
		result: await runProviderRunnerOnce({ config, client }),
	});
}
