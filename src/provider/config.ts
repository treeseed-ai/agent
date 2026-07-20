import {
	redactCapacityProviderEnv,
	type CapacityProviderManifestV2,
} from '@treeseed/sdk/capacity-provider';
import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import { mintTreeDxHs256Token } from '@treeseed/sdk/treedx/auth';
import { existsSync } from 'node:fs';
import { resolveCodexAuthFile } from '../agents/adapters/codex-auth.ts';
import {
	resolveJiraExecutionProviderConfig,
	type JiraExecutionProviderConfig,
} from '../agents/adapters/execution-jira.ts';
import {
	resolveGitHubIssuesExecutionProviderConfig,
	type GitHubIssuesExecutionProviderConfig,
} from '../agents/adapters/execution-github-issues.ts';
import {
	resolveDiscordExecutionProviderConfig,
	type DiscordExecutionProviderConfig,
} from '../agents/adapters/execution-discord.ts';

export type ProviderRole = 'manager' | 'runner' | 'doctor' | 'healthcheck' | 'plan' | 'version';

export interface JiraProviderRuntimeConfig extends JiraExecutionProviderConfig {}
export interface GitHubIssuesProviderRuntimeConfig extends GitHubIssuesExecutionProviderConfig {}
export interface DiscordProviderRuntimeConfig extends DiscordExecutionProviderConfig {}

export interface ProviderHostRuntimeConfig {
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
	jira: JiraProviderRuntimeConfig | null;
	githubIssues: GitHubIssuesProviderRuntimeConfig | null;
	discord: DiscordProviderRuntimeConfig | null;
	treeDx: AgentSdkTreeDxOptions | null;
	env: Record<string, string>;
	redactedEnv: Record<string, string>;
	manifestPath?: string | null;
}

export interface ProviderConnectionRuntimeContext extends ProviderHostRuntimeConfig {
	connectionId: string;
	marketUrl: string;
	marketAudience: string;
	teamId: string;
	providerId: string;
	membershipId: string;
	accessToken: string;
	executionProviders?: CapacityProviderManifestV2['executionProviders'];
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

function arrayEnvValue(env: NodeJS.ProcessEnv, name: string, fallback: string[]) {
	const raw = envValue(env, name);
	if (!raw) return fallback;
	return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function optionalEnvEntries(env: NodeJS.ProcessEnv, names: string[]) {
	return Object.fromEntries(
		names
			.map((name) => [name, envValue(env, name)] as const)
			.filter(([, value]) => value),
	);
}

function mintLocalTreeDxJwt(env: NodeJS.ProcessEnv) {
	const secret = envValue(env, 'TREESEED_TREEDX_JWT_HS256_SECRET');
	const issuer = envValue(env, 'TREESEED_TREEDX_JWT_ISSUER') || envValue(env, 'TREEDX_JWT_ISSUER');
	const audience = envValue(env, 'TREESEED_TREEDX_JWT_AUDIENCE') || envValue(env, 'TREEDX_JWT_AUDIENCE');
	if (!secret || !issuer || !audience) return '';
	const actorId = envValue(env, 'TREESEED_TREEDX_PROXY_ACTOR_ID') || envValue(env, 'TREESEED_TREEDX_ACTOR_ID') || 'treeseed-provider';
	const tenantId = envValue(env, 'TREESEED_TREEDX_PROXY_TENANT_ID') || envValue(env, 'TREESEED_TREEDX_TENANT_ID') || 'treeseed-control-plane';
	return mintTreeDxHs256Token({
		secret, issuer, audience, actorId, tenantId,
		repoIds: arrayEnvValue(env, 'TREESEED_TREEDX_REPO_IDS', ['*']),
		capabilities: arrayEnvValue(env, 'TREESEED_TREEDX_CAPABILITIES', ['*']),
		refs: arrayEnvValue(env, 'TREESEED_TREEDX_REFS', ['*']),
		paths: arrayEnvValue(env, 'TREESEED_TREEDX_PATHS', ['**']),
		ttlSeconds: 3600,
	});
}

export function resolveProviderTreeDxOptions(env: NodeJS.ProcessEnv = process.env): AgentSdkTreeDxOptions | null {
	const baseUrl = envValue(env, 'TREESEED_TREEDX_BASE_URL') || envValue(env, 'TREESEED_TREEDX_URL');
	if (!baseUrl) return null;
	const token = envValue(env, 'TREESEED_TREEDX_TOKEN') || mintLocalTreeDxJwt(env);
	return {
		baseUrl,
		...(token ? { token } : {}),
		...(envValue(env, 'TREESEED_TREEDX_REPO_ID') ? { repoId: envValue(env, 'TREESEED_TREEDX_REPO_ID') } : {}),
		...(envValue(env, 'TREESEED_TREEDX_REF') ? { ref: envValue(env, 'TREESEED_TREEDX_REF') } : {}),
		...(envValue(env, 'TREESEED_TREEDX_WORKSPACE_ID') ? { workspaceId: envValue(env, 'TREESEED_TREEDX_WORKSPACE_ID') } : {}),
	};
}

function configuredCodexAuthFile(env: NodeJS.ProcessEnv) {
	const explicit = envValue(env, 'TREESEED_CODEX_AUTH_FILE') || envValue(env, 'CODEX_AUTH_FILE');
	const resolved = resolveCodexAuthFile(env);
	if (explicit) return resolved;
	return existsSync(resolved) ? resolved : '';
}

export function resolveProviderEnvironmentInput(env: NodeJS.ProcessEnv = process.env) {
	const codexAuthFile = configuredCodexAuthFile(env);
	const providerApiPort = envValue(env, 'TREESEED_PROVIDER_API_PORT') || envValue(env, 'PORT') || '3100';
	return {
		providerDataDir: envValue(env, 'TREESEED_PROVIDER_DATA_DIR') || '/data',
		providerApiPort,
		providerEnvironment: envValue(env, 'TREESEED_PROVIDER_ENVIRONMENT') || envValue(env, 'TREESEED_ENVIRONMENT') || 'local',
		capabilitiesFile: envValue(env, 'TREESEED_PROVIDER_CAPABILITIES_FILE') || undefined,
		budgetFile: envValue(env, 'TREESEED_PROVIDER_BUDGET_FILE') || undefined,
		maxConcurrentWorkdays: envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_WORKDAYS') || undefined,
		maxConcurrentRunners: envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS') || undefined,
		dailyCreditBudget: envValue(env, 'TREESEED_PROVIDER_DAILY_CREDIT_BUDGET') || undefined,
		monthlyCreditBudget: envValue(env, 'TREESEED_PROVIDER_MONTHLY_CREDIT_BUDGET') || undefined,
		codexAuthFile: codexAuthFile || undefined,
		codexAuthJsonB64: envValue(env, 'TREESEED_CODEX_AUTH_JSON_B64') || undefined,
		codexAuthOverwrite: envValue(env, 'TREESEED_CODEX_AUTH_OVERWRITE') || undefined,
	};
}

export function resolveProviderConfig(options: {
	env?: NodeJS.ProcessEnv;
	requireConnection?: boolean;
} = {}): ProviderHostRuntimeConfig {
	const env = options.env ?? process.env;
	const input = resolveProviderEnvironmentInput(env);
	const codexAuthFile = configuredCodexAuthFile(env);
	const jira = resolveJiraExecutionProviderConfig(env);
	const githubIssues = resolveGitHubIssuesExecutionProviderConfig(env);
	const discord = resolveDiscordExecutionProviderConfig(env);
	const treeDx = resolveProviderTreeDxOptions(env);
	const configuredManifestPath = envValue(env, 'TREESEED_CAPACITY_PROVIDER_MANIFEST');
	const manifestPath = configuredManifestPath || (existsSync('treeseed.capacity-provider.yaml') ? 'treeseed.capacity-provider.yaml' : null);
	const missing = [!manifestPath ? 'TREESEED_CAPACITY_PROVIDER_MANIFEST' : null]
		.filter((entry): entry is string => Boolean(entry));
	if (options.requireConnection && missing.length > 0) {
		throw new Error(`Capacity provider connection is missing: ${missing.join(', ')}.`);
	}
	const resolvedEnv = {
		TREESEED_PROVIDER_DATA_DIR: input.providerDataDir ?? '/data',
			TREESEED_PROVIDER_API_PORT: String(input.providerApiPort ?? '3100'),
			TREESEED_PROVIDER_ENVIRONMENT: String(input.providerEnvironment ?? 'local'),
		};
	resolvedEnv.TREESEED_PROVIDER_API_PORT ??= String(input.providerApiPort ?? '3100');
	Object.assign(resolvedEnv, optionalEnvEntries(env, [
		'TREESEED_PROVIDER_WORKSPACE_ROOT',
		'TREESEED_PROVIDER_WORKSPACE_ABSOLUTE_CONTAINER',
		'TREESEED_PROVIDER_WORKSPACE_GITDIR_CONTAINER',
		'TREESEED_MARKET_GIT_COMMON_DIR_ABSOLUTE_CONTAINER',
		'TREESEED_MARKET_GIT_COMMON_DIR_ROOT_CONTAINER',
	]));
	const redactedEnv = {
		...redactCapacityProviderEnv(resolvedEnv),
		...(jira ? {
			TREESEED_JIRA_BASE_URL: jira.baseUrl,
			TREESEED_JIRA_EMAIL: jira.email,
			TREESEED_JIRA_API_TOKEN: '<redacted>',
			TREESEED_JIRA_PROJECT_KEY: jira.projectKey,
			TREESEED_JIRA_ISSUE_TYPE: jira.issueType,
			TREESEED_JIRA_DONE_STATUSES: jira.doneStatuses.join(','),
			TREESEED_JIRA_BLOCKED_STATUSES: jira.blockedStatuses.join(','),
			TREESEED_JIRA_CANCELLED_STATUSES: jira.cancelledStatuses.join(','),
			TREESEED_JIRA_IN_PROGRESS_STATUSES: jira.inProgressStatuses.join(','),
			...(jira.storyPointsField ? { TREESEED_JIRA_STORY_POINTS_FIELD: jira.storyPointsField } : {}),
		} : {}),
		...(githubIssues ? {
			TREESEED_GITHUB_ISSUES_TOKEN: '<redacted>',
			TREESEED_GITHUB_ISSUES_REPOSITORY: githubIssues.repository,
			TREESEED_GITHUB_ISSUES_LABELS: githubIssues.labels.join(','),
			TREESEED_GITHUB_ISSUES_IN_PROGRESS_LABELS: githubIssues.inProgressLabels.join(','),
			TREESEED_GITHUB_ISSUES_BLOCKED_LABELS: githubIssues.blockedLabels.join(','),
			TREESEED_GITHUB_ISSUES_CANCELLED_LABELS: githubIssues.cancelledLabels.join(','),
		} : {}),
		...(discord ? {
			TREESEED_DISCORD_BOT_TOKEN: '<redacted>',
			TREESEED_DISCORD_CHANNEL_ID: discord.channelId,
			...(discord.guildId ? { TREESEED_DISCORD_GUILD_ID: discord.guildId } : {}),
			TREESEED_DISCORD_THREAD_PREFIX: discord.threadPrefix,
		} : {}),
	};
	return {
		dataDir: resolvedEnv.TREESEED_PROVIDER_DATA_DIR ?? '/data',
		apiPort: intValue(resolvedEnv.TREESEED_PROVIDER_API_PORT ?? '', 3100),
		environment: resolvedEnv.TREESEED_PROVIDER_ENVIRONMENT ?? 'local',
		capabilitiesFile: envValue(env, 'TREESEED_PROVIDER_CAPABILITIES_FILE') || null,
		budgetFile: envValue(env, 'TREESEED_PROVIDER_BUDGET_FILE') || null,
		maxConcurrentWorkdays: intValue(envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_WORKDAYS'), 1),
		maxConcurrentRunners: intValue(envValue(env, 'TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS'), 4),
		dailyCreditBudget: optionalIntValue(envValue(env, 'TREESEED_PROVIDER_DAILY_CREDIT_BUDGET')),
		monthlyCreditBudget: optionalIntValue(envValue(env, 'TREESEED_PROVIDER_MONTHLY_CREDIT_BUDGET')),
		codexAuthFile: codexAuthFile || null,
		codexAuthJsonB64: envValue(env, 'TREESEED_CODEX_AUTH_JSON_B64') || null,
		codexAuthOverwrite: booleanValue(envValue(env, 'TREESEED_CODEX_AUTH_OVERWRITE')),
		jira,
		githubIssues,
		discord,
		treeDx,
		env: resolvedEnv,
		redactedEnv,
		manifestPath,
	};
}

export function providerRuntimeVersion(env: NodeJS.ProcessEnv = process.env) {
	return envValue(env, 'TREESEED_PROVIDER_RUNTIME_VERSION') || '0.9.0';
}
