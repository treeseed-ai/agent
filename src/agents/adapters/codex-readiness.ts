import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolveCodexAuthFile } from './codex-auth.ts';

export type CodexSubscriptionPlan = 'plus' | 'pro' | 'business' | 'edu' | 'enterprise' | 'unknown';
export type CodexApprovalPolicy = 'never' | 'on_request' | 'always';
export type CodexSandboxMode = 'read_only' | 'workspace_write';
export type CodexProviderId = 'codex' | 'codex_subscription';

export interface CodexProviderConfig {
	providerId: 'codex';
	legacyProviderIds: ['codex_subscription'];
	subscriptionPlan: CodexSubscriptionPlan;
	defaultModel: string;
	approvalPolicy: CodexApprovalPolicy;
	sandboxMode: CodexSandboxMode;
	timeoutMs: number;
	requireDecisionForProductionRelease: boolean;
	allowFeatureBranchMutation: boolean;
	allowAutomaticStagingMerge: boolean;
	requireAllowedPaths: boolean;
	recordThreadIds: boolean;
}

export interface CodexProviderReadiness {
	ok: boolean;
	providerSelected: boolean;
	sdkInstalled: boolean;
	nodeVersionOk: boolean;
	authDetected: boolean;
	authMode: 'codex_auth_json' | 'api_key' | 'missing';
	authPath?: string;
	packagePath?: string;
	subscriptionPlan: CodexSubscriptionPlan;
	defaultModel: string;
	approvalPolicy: CodexApprovalPolicy;
	sandboxMode: CodexSandboxMode;
	timeoutMs: number;
	warnings: string[];
	blockingIssues: string[];
}

export interface CheckCodexProviderReadinessOptions {
	env?: NodeJS.ProcessEnv;
	nodeVersion?: string;
	resolvePackage?: (specifier: string) => string;
	fileExists?: (path: string) => boolean;
}

const requireFromHere = createRequire(import.meta.url);

const SUBSCRIPTION_PLANS = new Set<CodexSubscriptionPlan>([
	'plus',
	'pro',
	'business',
	'edu',
	'enterprise',
	'unknown',
]);
const APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(['never', 'on_request', 'always']);
const SANDBOX_MODES = new Set<CodexSandboxMode>(['read_only', 'workspace_write']);

function readChoice<T extends string>(value: string | undefined, allowed: Set<T>, fallback: T): T {
	const normalized = value?.trim().toLowerCase().replaceAll('-', '_');
	return normalized && allowed.has(normalized as T) ? (normalized as T) : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean) {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNodeMajor(version: string) {
	const normalized = version.trim().replace(/^v/, '');
	const [major] = normalized.split('.');
	return Number.parseInt(major ?? '', 10);
}

export function resolveCodexProviderConfig(env: NodeJS.ProcessEnv = process.env): CodexProviderConfig {
	return {
		providerId: 'codex',
		legacyProviderIds: ['codex_subscription'],
		subscriptionPlan: readChoice(env.TREESEED_CODEX_SUBSCRIPTION_PLAN, SUBSCRIPTION_PLANS, 'unknown'),
		defaultModel: env.TREESEED_CODEX_DEFAULT_MODEL?.trim() || 'gpt-5.5',
		approvalPolicy: readChoice(env.TREESEED_CODEX_APPROVAL_POLICY, APPROVAL_POLICIES, 'never'),
		sandboxMode: readChoice(env.TREESEED_CODEX_SANDBOX_MODE, SANDBOX_MODES, 'workspace_write'),
		timeoutMs: readPositiveInteger(env.TREESEED_CODEX_TIMEOUT_MS, 900_000),
		requireDecisionForProductionRelease: readBoolean(env.TREESEED_CODEX_REQUIRE_RELEASE_DECISION, true),
		allowFeatureBranchMutation: readBoolean(env.TREESEED_CODEX_ALLOW_FEATURE_BRANCH_MUTATION, true),
		allowAutomaticStagingMerge: readBoolean(env.TREESEED_CODEX_ALLOW_AUTOMATIC_STAGING_MERGE, true),
		requireAllowedPaths: readBoolean(env.TREESEED_CODEX_REQUIRE_ALLOWED_PATHS, true),
		recordThreadIds: readBoolean(env.TREESEED_CODEX_RECORD_THREAD_IDS, true),
	};
}

export function checkCodexProviderReadiness(
	options: CheckCodexProviderReadinessOptions = {},
): CodexProviderReadiness {
	const env = options.env ?? process.env;
	const config = resolveCodexProviderConfig(env);
	const resolvePackage = options.resolvePackage ?? ((specifier: string) => requireFromHere.resolve(specifier));
	const fileExists = options.fileExists ?? existsSync;
	const providerSelected = [
		env.TREESEED_EXECUTION_PROVIDER,
		env.TREESEED_AGENT_EXECUTION_PROVIDER,
	].every((value) => value === undefined)
		|| [
			env.TREESEED_EXECUTION_PROVIDER,
			env.TREESEED_AGENT_EXECUTION_PROVIDER,
		].some((value) => {
			const normalized = value?.trim();
			return normalized === config.providerId || config.legacyProviderIds.includes(normalized as 'codex_subscription');
		});
	const warnings: string[] = [];
	const blockingIssues: string[] = [];
	const nodeMajor = parseNodeMajor(options.nodeVersion ?? process.version);
	const nodeVersionOk = Number.isFinite(nodeMajor) && nodeMajor >= 22;

	let sdkInstalled = false;
	let packagePath: string | undefined;
	try {
		packagePath = resolvePackage('@openai/codex-sdk');
		sdkInstalled = true;
	} catch {
		if (providerSelected) {
			blockingIssues.push('@openai/codex-sdk is required when codex is the selected execution provider.');
		} else {
			warnings.push('@openai/codex-sdk is not installed; Codex execution remains unavailable until the provider is selected and installed.');
		}
	}

	if (!nodeVersionOk) {
		blockingIssues.push('Codex provider support requires Node.js 22 or newer in the TreeSeed agent runtime.');
	}

	const authPath = resolveCodexAuthFile(env);
	const authJsonDetected = fileExists(authPath);
	const apiKeyDetected = Boolean(env.CODEX_API_KEY?.trim());
	const authDetected = authJsonDetected || apiKeyDetected;
	const authMode = authJsonDetected ? 'codex_auth_json' : apiKeyDetected ? 'api_key' : 'missing';
	if (!authDetected) {
		const message = `Codex authentication was not detected. For subscription-backed Codex, run Codex login so ${authPath} exists; alternatively set CODEX_API_KEY as an API-billed fallback from https://platform.openai.com/api-keys. Never commit or print either credential.`;
		if (providerSelected) {
			blockingIssues.push(message);
		} else {
			warnings.push(message);
		}
	}

	return {
		ok: blockingIssues.length === 0,
		providerSelected,
		sdkInstalled,
		nodeVersionOk,
		authDetected,
		authMode,
		authPath,
		packagePath,
		subscriptionPlan: config.subscriptionPlan,
		defaultModel: config.defaultModel,
		approvalPolicy: config.approvalPolicy,
		sandboxMode: config.sandboxMode,
		timeoutMs: config.timeoutMs,
		warnings,
		blockingIssues,
	};
}
