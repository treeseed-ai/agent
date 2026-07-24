import type { AgentExecutionConfig, AgentProviderFallbackPolicy, AgentProviderProfile } from '@treeseed/sdk/types/agents';
import type { AgentSpecDiagnostic } from './spec-types.ts';
import {
	APPROVAL_POLICIES,
	DEFAULT_CODEX_ALLOWED_PATHS,
	DEFAULT_CODEX_FORBIDDEN_PATHS,
	EXECUTION_PROVIDERS,
	REASONING_EFFORTS,
	SANDBOX_MODES,
	ensureBoolean,
	ensurePositiveNumber,
	ensureString,
	isPlainObject,
	normalizeOptionalString,
	normalizeStringArray,
	normalizeStringChoice,
} from './spec-normalizer-primitives.ts';

export function normalizeExecution(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentExecutionConfig {
	const next = isPlainObject(value) ? value : {};
	const worktree = isPlainObject(next.worktree) ? next.worktree : {};
	if (next.worktree !== undefined && !isPlainObject(next.worktree)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'execution.worktree',
			message: 'Expected execution.worktree to be an object.',
		});
	}
	return {
		provider: normalizeStringChoice(next.provider, 'execution.provider', EXECUTION_PROVIDERS, diagnostics, slug, 'codex', {
			warnOnUnknown: true,
		}),
		model: normalizeOptionalString(next.model, 'execution.model', diagnostics, slug) ?? 'gpt-5.5',
		approvalPolicy: normalizeStringChoice(next.approvalPolicy, 'execution.approvalPolicy', APPROVAL_POLICIES, diagnostics, slug, 'never'),
		sandboxMode: normalizeStringChoice(next.sandboxMode, 'execution.sandboxMode', SANDBOX_MODES, diagnostics, slug, 'workspace_write'),
		reasoningEffort: normalizeStringChoice(next.reasoningEffort, 'execution.reasoningEffort', REASONING_EFFORTS, diagnostics, slug, 'medium'),
		allowedPaths: normalizeStringArray(next.allowedPaths, 'execution.allowedPaths', diagnostics, slug, DEFAULT_CODEX_ALLOWED_PATHS),
		forbiddenPaths: normalizeStringArray(next.forbiddenPaths, 'execution.forbiddenPaths', diagnostics, slug, DEFAULT_CODEX_FORBIDDEN_PATHS),
		worktree: {
			enabled: ensureBoolean(worktree.enabled, 'execution.worktree.enabled', diagnostics, slug, true),
			root: normalizeOptionalString(worktree.root, 'execution.worktree.root', diagnostics, slug),
			branchPrefix: normalizeOptionalString(worktree.branchPrefix, 'execution.worktree.branchPrefix', diagnostics, slug),
		},
		maxConcurrency: ensurePositiveNumber(next.maxConcurrency, 'execution.maxConcurrency', diagnostics, slug, 1),
		timeoutSeconds: ensurePositiveNumber(next.timeoutSeconds, 'execution.timeoutSeconds', diagnostics, slug, 900),
		cooldownSeconds: ensurePositiveNumber(next.cooldownSeconds, 'execution.cooldownSeconds', diagnostics, slug, 30, true),
		leaseSeconds: ensurePositiveNumber(next.leaseSeconds, 'execution.leaseSeconds', diagnostics, slug, 300),
		retryLimit: ensurePositiveNumber(next.retryLimit, 'execution.retryLimit', diagnostics, slug, 3, true),
		branchPrefix: ensureString(next.branchPrefix ?? 'agent', 'execution.branchPrefix', diagnostics, slug) || 'agent',
		providerProfile: normalizeProviderProfile(next.providerProfile, diagnostics, slug),
	};
}

function normalizeWeightedProviderList(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an array.`,
		});
		return [];
	}
	return value.flatMap((entry, index) => {
		if (!isPlainObject(entry)) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `${field}[${index}]`,
				message: 'Expected execution-provider preference to be an object.',
			});
			return [];
		}
		return [{
			providerId: typeof entry.providerId === 'string' ? entry.providerId : undefined,
			provider: typeof entry.provider === 'string' ? entry.provider : undefined,
			model: typeof entry.model === 'string' ? entry.model : undefined,
			modelClass: typeof entry.modelClass === 'string' ? entry.modelClass : undefined,
			weight: ensurePositiveNumber(entry.weight, `${field}[${index}].weight`, diagnostics, slug, 1, true),
			reason: typeof entry.reason === 'string' ? entry.reason : undefined,
			maxQualityPenalty: typeof entry.maxQualityPenalty === 'number' ? entry.maxQualityPenalty : undefined,
		}];
	});
}

function normalizeProviderProfile(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentProviderProfile | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'execution.providerProfile',
			message: 'Expected execution.providerProfile to be an object.',
		});
		return undefined;
	}
	const fallbackPolicy = typeof value.fallbackPolicy === 'string'
		? value.fallbackPolicy as AgentProviderFallbackPolicy
		: 'allow_substitution';
	if (!['allow_substitution', 'require_same_model_class', 'fail_if_unavailable', 'ask_for_approval'].includes(fallbackPolicy)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'execution.providerProfile.fallbackPolicy',
			message: `Unsupported fallback policy "${String(value.fallbackPolicy)}".`,
		});
	}
	return {
		requiredCapabilities: Array.isArray(value.requiredCapabilities)
			? value.requiredCapabilities.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
			: [],
		preferredExecutionProviders: normalizeWeightedProviderList(value.preferredExecutionProviders, 'execution.providerProfile.preferredExecutionProviders', diagnostics, slug),
		acceptableFallbacks: normalizeWeightedProviderList(value.acceptableFallbacks, 'execution.providerProfile.acceptableFallbacks', diagnostics, slug).map((entry) => ({
			providerId: entry.providerId,
			provider: entry.provider,
			model: entry.model,
			modelClass: entry.modelClass,
			maxQualityPenalty: entry.maxQualityPenalty,
		})),
		disallowedProviders: Array.isArray(value.disallowedProviders) ? value.disallowedProviders.filter((entry): entry is string => typeof entry === 'string') : undefined,
		disallowedRegions: Array.isArray(value.disallowedRegions) ? value.disallowedRegions.filter((entry): entry is string => typeof entry === 'string') : undefined,
		fallbackPolicy,
	};
}

