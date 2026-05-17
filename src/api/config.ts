import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApiConfig } from './types.ts';

const LOCAL_DEV_AUTH_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_AUTH_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

function parseInteger(value: string | undefined, fallback: number) {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveLocalWranglerConfigPath(repoRoot: string, env: NodeJS.ProcessEnv) {
	const explicit = env.TREESEED_API_D1_WRANGLER_CONFIG?.trim() || env.TREESEED_LOCAL_WRANGLER_CONFIG?.trim();
	if (explicit) return resolve(repoRoot, explicit);
	const generated = resolve(repoRoot, '.treeseed', 'generated', 'environments', 'local', 'wrangler.toml');
	return existsSync(generated) ? generated : undefined;
}

function normalizeUrl(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isLoopbackUrl(value: string) {
	try {
		const url = new URL(value);
		return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
	} catch {
		return false;
	}
}

function parseCsv(value: string | undefined) {
	return (value ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function resolveBaseUrl(env: NodeJS.ProcessEnv, host: string, port: number) {
	if (env.TREESEED_API_BASE_URL?.trim()) {
		return normalizeUrl(env.TREESEED_API_BASE_URL.trim());
	}

	if (env.RAILWAY_PUBLIC_DOMAIN?.trim()) {
		return normalizeUrl(`https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}`);
	}

	return normalizeUrl(`http://${host}:${port}`);
}

function resolveAuthApprovalBaseUrl(env: NodeJS.ProcessEnv, baseUrl: string) {
	const explicit = env.TREESEED_API_AUTH_APPROVAL_BASE_URL?.trim()
		|| env.TREESEED_SITE_URL?.trim()
		|| env.BETTER_AUTH_URL?.trim();
	const explicitIsLoopback = explicit ? isLoopbackUrl(explicit) : false;
	try {
		const url = new URL(baseUrl);
		const isLocalApi = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
		if (!isLocalApi && explicit && explicitIsLoopback) {
			throw new Error(`Refusing loopback device approval URL "${explicit}" for remote API "${baseUrl}".`);
		}
		if (explicit) {
			return normalizeUrl(explicit);
		}
		if (isLocalApi && url.port === '3000') {
			url.port = '4321';
			return normalizeUrl(url.toString());
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes('Refusing loopback device approval URL')) {
			throw error;
		}
		if (explicit && /^https?:\/\//u.test(explicit)) {
			throw new Error(`Invalid device approval URL configuration for API "${baseUrl}".`);
		}
	}
	return baseUrl;
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const host = env.HOST?.trim() || '0.0.0.0';
	const port = parseInteger(env.PORT, 3000);
	const baseUrl = resolveBaseUrl(env, host === '0.0.0.0' ? '127.0.0.1' : host, port);
	const issuer = normalizeUrl(env.TREESEED_API_ISSUER?.trim() || baseUrl);
	const repoRoot = resolve(env.TREESEED_API_REPO_ROOT?.trim() || process.cwd());
	const localDevAuth = env.TREESEED_LOCAL_DEV_MODE === 'cloudflare' || isLoopbackUrl(baseUrl);
	const defaultAccessTokenTtl = localDevAuth ? LOCAL_DEV_AUTH_TTL_SECONDS : DEFAULT_AUTH_TTL_SECONDS;
	const defaultRefreshTokenTtl = localDevAuth ? LOCAL_DEV_AUTH_TTL_SECONDS : DEFAULT_REFRESH_TTL_SECONDS;

	return {
		name: env.TREESEED_API_NAME?.trim() || '@treeseed/agent/api',
		host,
		port,
		baseUrl,
		authApprovalBaseUrl: resolveAuthApprovalBaseUrl(env, baseUrl),
		issuer,
		repoRoot,
		projectId: env.TREESEED_PROJECT_ID?.trim() || 'treeseed-project',
		authSecret: env.TREESEED_API_AUTH_SECRET?.trim() || 'treeseed-api-dev-secret',
		projectApiKey: env.TREESEED_API_PROJECT_KEY?.trim() || undefined,
		projectApiLabel: env.TREESEED_API_PROJECT_LABEL?.trim() || 'Project API Key',
		projectApiPermissions: parseCsv(env.TREESEED_API_PROJECT_KEY_PERMISSIONS)
			.length > 0
			? parseCsv(env.TREESEED_API_PROJECT_KEY_PERMISSIONS)
			: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
		cloudflareApiToken: env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
		d1DatabaseId: env.TREESEED_API_D1_DATABASE_ID?.trim() || undefined,
		d1DatabaseName: env.TREESEED_API_D1_DATABASE_NAME?.trim() || env.SITE_DATA_DB?.trim() || undefined,
		d1LocalPersistTo: env.TREESEED_API_D1_LOCAL_PERSIST_TO?.trim() || resolve(repoRoot, '.wrangler/state/v3/d1'),
		d1WranglerConfigPath: resolveLocalWranglerConfigPath(repoRoot, env),
		webServiceId: env.TREESEED_API_WEB_SERVICE_ID?.trim() || 'web',
		webServiceSecret: env.TREESEED_API_WEB_SERVICE_SECRET?.trim() || 'treeseed-web-service-dev-secret',
		webAssertionSecret: env.TREESEED_API_WEB_ASSERTION_SECRET?.trim() || env.TREESEED_API_AUTH_SECRET?.trim() || 'treeseed-web-assertion-dev-secret',
		webExchangeTtlSeconds: parseInteger(env.TREESEED_API_WEB_EXCHANGE_TTL, 300),
		bootstrapAdminAllowlist: parseCsv(env.TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST),
		accessTokenTtlSeconds: parseInteger(env.TREESEED_API_ACCESS_TOKEN_TTL, defaultAccessTokenTtl),
		refreshTokenTtlSeconds: parseInteger(env.TREESEED_API_REFRESH_TOKEN_TTL, defaultRefreshTokenTtl),
		deviceCodeTtlSeconds: parseInteger(env.TREESEED_API_DEVICE_CODE_TTL, 10 * 60),
		deviceCodePollIntervalSeconds: parseInteger(env.TREESEED_API_DEVICE_CODE_POLL_INTERVAL, 5),
		templateCatalogPath: env.TREESEED_API_TEMPLATE_CATALOG_PATH?.trim() || undefined,
		providers: {
			auth: env.TREESEED_API_PROVIDER_AUTH?.trim() || 'd1',
			agents: {
				execution: env.TREESEED_API_PROVIDER_AGENT_EXECUTION?.trim() || 'stub',
				queue: env.TREESEED_API_PROVIDER_AGENT_QUEUE?.trim() || 'memory',
				notification: env.TREESEED_API_PROVIDER_AGENT_NOTIFICATION?.trim() || 'stub',
				repository: env.TREESEED_API_PROVIDER_AGENT_REPOSITORY?.trim() || 'stub',
				verification: env.TREESEED_API_PROVIDER_AGENT_VERIFICATION?.trim() || 'stub',
			},
		},
	};
}
