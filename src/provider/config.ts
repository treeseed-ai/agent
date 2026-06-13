import {
	redactCapacityProviderEnv,
	resolveCapacityProviderEnvironment,
	type CapacityProviderEnvironmentInput,
} from '@treeseed/sdk/capacity-provider';

export type ProviderRole = 'api' | 'manager' | 'runner' | 'doctor' | 'healthcheck' | 'register' | 'plan' | 'version';

export interface ProviderRuntimeConfig {
	marketUrl: string;
	marketId: string;
	apiKey: string;
	dataDir: string;
	apiPort: number;
	environment: string;
	capabilitiesFile: string | null;
	budgetFile: string | null;
	maxConcurrentWorkdays: number;
	maxConcurrentRunners: number;
	dailyCreditBudget: number | null;
	monthlyCreditBudget: number | null;
	codexAuthFile: string | null;
	codexAuthJsonB64: string | null;
	codexAuthOverwrite: boolean;
	env: Record<string, string>;
	redactedEnv: Record<string, string>;
}

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

function intValue(value: string, fallback: number) {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalIntValue(value: string) {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: string) {
	return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function resolveProviderEnvironmentInput(env: NodeJS.ProcessEnv = process.env): CapacityProviderEnvironmentInput {
	return {
		marketUrl: envValue(env, 'TREESEED_MARKET_URL'),
		marketId: envValue(env, 'TREESEED_MARKET_ID'),
		apiKey: envValue(env, 'TREESEED_CAPACITY_PROVIDER_API_KEY'),
		providerDataDir: envValue(env, 'TREESEED_PROVIDER_DATA_DIR') || '/data',
		providerApiPort: envValue(env, 'TREESEED_PROVIDER_API_PORT') || '3100',
		providerEnvironment: envValue(env, 'TREESEED_PROVIDER_ENVIRONMENT') || envValue(env, 'TREESEED_ENVIRONMENT') || 'local',
		capabilitiesFile: envValue(env, 'TREESEED_PROVIDER_CAPABILITIES_FILE') || undefined,
		budgetFile: envValue(env, 'TREESEED_PROVIDER_BUDGET_FILE') || undefined,
		maxConcurrentWorkdays: envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_WORKDAYS') || undefined,
		maxConcurrentRunners: envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS') || undefined,
		dailyCreditBudget: envValue(env, 'TREESEED_PROVIDER_DAILY_CREDIT_BUDGET') || undefined,
		monthlyCreditBudget: envValue(env, 'TREESEED_PROVIDER_MONTHLY_CREDIT_BUDGET') || undefined,
		codexAuthFile: envValue(env, 'TREESEED_CODEX_AUTH_FILE') || undefined,
		codexAuthJsonB64: envValue(env, 'TREESEED_CODEX_AUTH_JSON_B64') || undefined,
		codexAuthOverwrite: envValue(env, 'TREESEED_CODEX_AUTH_OVERWRITE') || undefined,
	};
}

export function resolveProviderConfig(options: {
	env?: NodeJS.ProcessEnv;
	requireConnection?: boolean;
} = {}): ProviderRuntimeConfig {
	const env = options.env ?? process.env;
	const input = resolveProviderEnvironmentInput(env);
	const missing = [
		!input.apiKey ? 'TREESEED_CAPACITY_PROVIDER_API_KEY' : null,
	].filter((entry): entry is string => Boolean(entry));
	if (options.requireConnection && missing.length > 0) {
		throw new Error(`Capacity provider connection is missing: ${missing.join(', ')}.`);
	}
	const resolvedEnv = input.marketUrl && input.apiKey
		? resolveCapacityProviderEnvironment(input)
		: {
			TREESEED_MARKET_URL: input.marketUrl || '',
			TREESEED_MARKET_ID: input.marketId || '',
			TREESEED_CAPACITY_PROVIDER_API_KEY: input.apiKey || '',
			TREESEED_PROVIDER_DATA_DIR: input.providerDataDir ?? '/data',
			TREESEED_PROVIDER_API_PORT: String(input.providerApiPort ?? '3100'),
			TREESEED_PROVIDER_ENVIRONMENT: String(input.providerEnvironment ?? 'local'),
		};
	return {
		marketUrl: resolvedEnv.TREESEED_MARKET_URL ?? '',
		marketId: resolvedEnv.TREESEED_MARKET_ID ?? '',
		apiKey: resolvedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY ?? '',
		dataDir: resolvedEnv.TREESEED_PROVIDER_DATA_DIR ?? '/data',
		apiPort: intValue(resolvedEnv.TREESEED_PROVIDER_API_PORT ?? '', 3100),
		environment: resolvedEnv.TREESEED_PROVIDER_ENVIRONMENT ?? 'local',
		capabilitiesFile: envValue(env, 'TREESEED_PROVIDER_CAPABILITIES_FILE') || null,
		budgetFile: envValue(env, 'TREESEED_PROVIDER_BUDGET_FILE') || null,
		maxConcurrentWorkdays: intValue(envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_WORKDAYS'), 1),
		maxConcurrentRunners: intValue(envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS'), 4),
		dailyCreditBudget: optionalIntValue(envValue(env, 'TREESEED_PROVIDER_DAILY_CREDIT_BUDGET')),
		monthlyCreditBudget: optionalIntValue(envValue(env, 'TREESEED_PROVIDER_MONTHLY_CREDIT_BUDGET')),
		codexAuthFile: envValue(env, 'TREESEED_CODEX_AUTH_FILE') || null,
		codexAuthJsonB64: envValue(env, 'TREESEED_CODEX_AUTH_JSON_B64') || null,
		codexAuthOverwrite: booleanValue(envValue(env, 'TREESEED_CODEX_AUTH_OVERWRITE')),
		env: resolvedEnv,
		redactedEnv: redactCapacityProviderEnv(resolvedEnv),
	};
}

export function providerRuntimeVersion(env: NodeJS.ProcessEnv = process.env) {
	return envValue(env, 'TREESEED_PROVIDER_RUNTIME_VERSION') || '0.9.0';
}
