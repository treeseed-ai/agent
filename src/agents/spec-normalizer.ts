import {
	AGENT_CLI_ALLOW_TOOLS,
	type AgentActivityProfile,
	type AgentActivityType,
	type AgentBranchPolicy,
	type AgentExecutionConfig,
	type AgentHandlerKind,
	type AgentDefinitionIdentity,
	type AgentContentAccessPolicy,
	type AgentOutputContract,
	type AgentProviderFallbackPolicy,
	type AgentProviderProfile,
	type AgentQuestionPolicy,
	type AgentPermissionConfig,
	type AgentPermissionOperation,
	type AgentPermissionPolicy,
	type AgentToolPolicy,
	type AgentTriggerConfig,
	type AgentTriggerKind,
} from '@treeseed/sdk/types/agents';
import { TREESEED_CONTENT_ACTIONS, type TreeseedContentAction } from '@treeseed/sdk/content-operations';
import { assertKnownAgentToolIds } from '@treeseed/sdk';
import type { DeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';
import { AGENT_MESSAGE_TYPES } from './contracts/messages.ts';
import { normalizeAgentCliOptions } from './cli-tools.ts';
import type {
	AgentSpecDiagnostic,
	AgentSpecNormalizationResult,
	AgentSpecParts,
	AgentSpecValidationContext,
	NormalizedAgentRuntimeSpec,
	RawAgentRuntimeSpec,
} from './spec-types.ts';

const TRIGGER_KINDS: readonly AgentTriggerKind[] = ['schedule', 'message', 'follow', 'startup'];
const PERMISSION_OPERATIONS: readonly AgentPermissionOperation[] = ['get', 'search', 'follow', 'pick', 'create', 'update'];
const ACTIVITY_TYPES = new Set<string>(['planning', 'estimating', 'acting', 'reviewing', 'reporting']);
const GENERIC_HANDLER_KINDS = new Set<string>(['writer', 'actor', 'estimate', 'releaser', 'reporter']);
const EXECUTION_PROVIDERS = new Set([
	'codex',
	'codex_subscription',
	'copilot',
	'jira',
	'jira_issue_queue',
	'human_issue_queue',
	'github_issues',
	'github_issue_queue',
	'issue_queue',
	'discord',
	'discord_thread',
	'workflow',
	'workflow_operation',
	'deterministic_workflow',
	'github_actions',
	'github_actions_workflow',
]);
const APPROVAL_POLICIES = new Set(['never', 'on_request', 'always']);
const SANDBOX_MODES = new Set(['read_only', 'workspace_write']);
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_CODEX_ALLOWED_PATHS = ['**'];
const DEFAULT_CODEX_FORBIDDEN_PATHS = ['.git/**', '.agent-worktrees/**', '.treeseed/secrets/**', 'node_modules/**'];
const LEGACY_AGENT_FIELDS = [
	'handler',
	'handlerConfig',
	'systemPrompt',
	'permissions',
	'tools',
	'contentAccess',
	'context',
	'execution',
	'outputs',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureString(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be a non-empty string.`,
		});
		return '';
	}
	return value;
}

function ensureBoolean(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string, fallback = false) {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'boolean') {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be a boolean.`,
		});
		return fallback;
	}
	return value;
}

function ensurePositiveNumber(
	value: unknown,
	field: string,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
	fallback: number,
	allowZero = false,
) {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || Number.isNaN(value) || (!allowZero && value <= 0) || (allowZero && value < 0)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be ${allowZero ? 'a non-negative' : 'a positive'} number.`,
		});
		return fallback;
	}
	return value;
}

function normalizeOptionalString(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value.trim()) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be a non-empty string.`,
		});
		return undefined;
	}
	return value.trim();
}

function normalizeStringChoice<T extends string>(
	value: unknown,
	field: string,
	allowed: Set<T>,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
	fallback: T,
	options: { warnOnUnknown?: boolean } = {},
): T | string {
	if (value === undefined) return fallback;
	const normalized = normalizeOptionalString(value, field, diagnostics, slug)?.toLowerCase().replaceAll('-', '_');
	if (!normalized) return fallback;
	if (allowed.has(normalized as T)) return normalized as T;
	diagnostics.push({
		severity: options.warnOnUnknown ? 'warning' : 'error',
		slug,
		field,
		message: `Unsupported ${field} "${String(value)}".`,
	});
	return normalized;
}

function normalizeStringArray(
	value: unknown,
	field: string,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
	fallback: string[],
) {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an array of strings.`,
		});
		return [...fallback];
	}
	const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
		.map((entry) => entry.trim());
	if (values.length !== value.length) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to contain only non-empty strings.`,
		});
	}
	return values;
}

function normalizeTrigger(
	value: unknown,
	index: number,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentTriggerConfig | null {
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `triggers[${index}]`,
			message: 'Expected trigger to be an object.',
		});
		return null;
	}
	const type = ensureString(value.type, `triggers[${index}].type`, diagnostics, slug) as AgentTriggerKind;
	if (!TRIGGER_KINDS.includes(type)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `triggers[${index}].type`,
			message: `Unsupported trigger type "${String(value.type ?? '')}".`,
		});
		return null;
	}
	return {
		type,
		cron: typeof value.cron === 'string' ? value.cron : undefined,
		messageTypes: Array.isArray(value.messageTypes) ? value.messageTypes.filter((entry): entry is string => typeof entry === 'string') : [],
		models: Array.isArray(value.models) ? value.models.filter((entry): entry is string => typeof entry === 'string') : [],
		sinceField: typeof value.sinceField === 'string' ? value.sinceField : undefined,
		runOnStart: typeof value.runOnStart === 'boolean' ? value.runOnStart : false,
	};
}

function normalizePermissions(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentPermissionConfig[] {
	if (!Array.isArray(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'permissions',
			message: 'Expected permissions to be an array.',
		});
		return [];
	}
	return value.flatMap((entry, index) => {
		if (!isPlainObject(entry)) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `permissions[${index}]`,
				message: 'Expected permission entry to be an object.',
			});
			return [];
		}
		const model = ensureString(entry.model, `permissions[${index}].model`, diagnostics, slug);
		const operations = Array.isArray(entry.operations)
			? entry.operations.filter(
				(operation): operation is AgentPermissionOperation =>
					typeof operation === 'string' && PERMISSION_OPERATIONS.includes(operation as AgentPermissionOperation),
			)
			: [];
		if (!operations.length) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `permissions[${index}].operations`,
				message: 'Expected at least one valid permission operation.',
			});
		}
		return model ? [{ model, operations }] : [];
	});
}

function normalizePermissionPolicy(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentPermissionPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'permissionPolicy',
			message: 'Expected permissionPolicy to be an object.',
		});
		return undefined;
	}
	for (const mode of ['planning', 'acting'] as const) {
		const modePolicy = isPlainObject(value.modes) && isPlainObject(value.modes[mode])
			? value.modes[mode]
			: null;
		if (!modePolicy) continue;
		if (modePolicy.operations !== undefined) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `permissionPolicy.modes.${mode}.operations`,
				message: 'Operation allow lists are not supported. Declare callable agent tools in tools.allowed.',
			});
		}
	}
	return value as AgentPermissionPolicy;
}

function normalizeTools(
	value: unknown,
	enabled: boolean,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentToolPolicy {
	if (value === undefined || value === null) {
		if (enabled) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: 'tools.allowed',
				message: 'Enabled agents must declare tools.allowed, even when the list is empty.',
			});
		}
		return { allowed: [] };
	}
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'tools',
			message: 'Expected tools to be an object.',
		});
		return { allowed: [] };
	}
	if (!Array.isArray(value.allowed)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'tools.allowed',
			message: 'Expected tools.allowed to be an array of tool ids.',
		});
		return { allowed: [] };
	}
	const ids = value.allowed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
		.map((entry) => entry.trim());
	if (ids.length !== value.allowed.length) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'tools.allowed',
			message: 'Expected tools.allowed to contain only non-empty strings.',
		});
	}
	const result = assertKnownAgentToolIds(ids);
	for (const duplicate of result.duplicates) {
		diagnostics.push({
			severity: 'warning',
			slug,
			field: 'tools.allowed',
			message: `Duplicate tool id "${duplicate}" was ignored.`,
		});
	}
	for (const unknown of result.unknown) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'tools.allowed',
			message: `Unknown agent tool id "${unknown}".`,
		});
	}
	return { allowed: result.known };
}

function normalizeToolPolicy(
	value: unknown,
	field: string,
	enabled: boolean,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentToolPolicy {
	const result = normalizeTools(value, enabled, diagnostics, slug);
	if (isPlainObject(value) && Array.isArray(value.denied)) {
		return {
			...result,
			denied: value.denied.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
		};
	}
	return result;
}

function stringList(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim())) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an array of non-empty strings.`,
		});
		return undefined;
	}
	return value.map((entry) => entry.trim());
}

function normalizeContentScope(
	value: unknown,
	field: string,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
) {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return undefined;
	}
	const models = stringList(value.models, `${field}.models`, diagnostics, slug) ?? [];
	const actions = stringList(value.actions, `${field}.actions`, diagnostics, slug);
	const invalidActions = (actions ?? []).filter((action) => !TREESEED_CONTENT_ACTIONS.includes(action as TreeseedContentAction));
	for (const action of invalidActions) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `${field}.actions`,
			message: `Unknown content action "${action}".`,
		});
	}
	return {
		models,
		actions: actions?.filter((action): action is TreeseedContentAction => TREESEED_CONTENT_ACTIONS.includes(action as TreeseedContentAction)),
		books: stringList(value.books, `${field}.books`, diagnostics, slug),
		paths: stringList(value.paths, `${field}.paths`, diagnostics, slug),
		relations: stringList(value.relations, `${field}.relations`, diagnostics, slug),
	};
}

function normalizeContentAccess(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
	field = 'contentAccess',
): AgentContentAccessPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return undefined;
	}
	const commit = value.commit;
	if (commit !== undefined && (!isPlainObject(commit) || typeof commit.allowed !== 'boolean')) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `${field}.commit.allowed`,
			message: `Expected ${field}.commit.allowed to be a boolean.`,
		});
	}
	return {
		read: normalizeContentScope(value.read, `${field}.read`, diagnostics, slug),
		write: normalizeContentScope(value.write, `${field}.write`, diagnostics, slug),
		commit: isPlainObject(commit) && typeof commit.allowed === 'boolean' ? { allowed: commit.allowed } : { allowed: false },
	};
}

function normalizeContext(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): { queries: DeclarativeContextQuery[] } | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'context',
			message: 'Expected context to be an object.',
		});
		return undefined;
	}
	if (value.queries === undefined) {
		return { queries: [] };
	}
	if (!Array.isArray(value.queries)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'context.queries',
			message: 'Expected context.queries to be an array.',
		});
		return { queries: [] };
	}

	const queries = value.queries.flatMap((entry, index) => {
		if (!isPlainObject(entry)) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}]`,
				message: 'Expected context query to be an object.',
			});
			return [];
		}
		for (const field of ['id', 'purpose', 'query']) {
			if (typeof entry[field] !== 'string' || !entry[field].trim()) {
				diagnostics.push({
					severity: 'error',
					slug,
					field: `context.queries[${index}].${field}`,
					message: `Expected context query ${field} to be a non-empty string.`,
				});
			}
		}
		if (entry.scope !== undefined && typeof entry.scope !== 'string') {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].scope`,
				message: 'Expected context query scope to be a string.',
			});
		}
		if (entry.codeScopes !== undefined && (!Array.isArray(entry.codeScopes) || entry.codeScopes.some((scope) => typeof scope !== 'string'))) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].codeScopes`,
				message: 'Expected context query codeScopes to be an array of strings.',
			});
		}
		if (entry.relations !== undefined && (!Array.isArray(entry.relations) || entry.relations.some((relation) => typeof relation !== 'string'))) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].relations`,
				message: 'Expected context query relations to be an array of strings.',
			});
		}
		if (entry.depth !== undefined && typeof entry.depth !== 'number') {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].depth`,
				message: 'Expected context query depth to be a number.',
			});
		}
		if (entry.budget !== undefined && typeof entry.budget !== 'number') {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].budget`,
				message: 'Expected context query budget to be a number.',
			});
		}
		if (entry.format !== undefined && typeof entry.format !== 'string') {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `context.queries[${index}].format`,
				message: 'Expected context query format to be a string.',
			});
		}
		return [entry as unknown as DeclarativeContextQuery];
	});

	return { queries };
}

function normalizeExecution(
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

function normalizeWeightedLaneList(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string) {
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
				message: 'Expected provider lane entry to be an object.',
			});
			return [];
		}
		return [{
			providerId: typeof entry.providerId === 'string' ? entry.providerId : undefined,
			provider: typeof entry.provider === 'string' ? entry.provider : undefined,
			laneId: typeof entry.laneId === 'string' ? entry.laneId : undefined,
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
		preferredLanes: normalizeWeightedLaneList(value.preferredLanes, 'execution.providerProfile.preferredLanes', diagnostics, slug),
		acceptableFallbacks: normalizeWeightedLaneList(value.acceptableFallbacks, 'execution.providerProfile.acceptableFallbacks', diagnostics, slug).map((entry) => ({
			providerId: entry.providerId,
			provider: entry.provider,
			laneId: entry.laneId,
			model: entry.model,
			modelClass: entry.modelClass,
			maxQualityPenalty: entry.maxQualityPenalty,
		})),
		disallowedProviders: Array.isArray(value.disallowedProviders) ? value.disallowedProviders.filter((entry): entry is string => typeof entry === 'string') : undefined,
		disallowedRegions: Array.isArray(value.disallowedRegions) ? value.disallowedRegions.filter((entry): entry is string => typeof entry === 'string') : undefined,
		fallbackPolicy,
	};
}

function normalizeOutputs(
	value: unknown,
	_diagnostics: AgentSpecDiagnostic[],
	_slug: string,
): AgentOutputContract {
	const next = isPlainObject(value) ? value : {};
	return {
		messageTypes: Array.isArray(next.messageTypes) ? next.messageTypes.filter((entry): entry is string => typeof entry === 'string') : [],
		modelMutations: Array.isArray(next.modelMutations) ? next.modelMutations.filter((entry): entry is string => typeof entry === 'string') : [],
	};
}

function normalizeBranchPolicy(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): AgentBranchPolicy {
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return { kind: 'read-only', base: 'main' };
	}
	const kind = typeof value.kind === 'string' ? value.kind : 'read-only';
	switch (kind) {
		case 'read-only':
			return { kind, base: value.base === 'staging' ? 'staging' : 'main' };
		case 'main-planning-content':
			return { kind, base: 'main' };
		case 'staging-content':
			return { kind, base: 'staging' };
		case 'assignment-feature':
			return {
				kind,
				base: 'staging',
				target: 'staging',
				prefix: typeof value.prefix === 'string' ? value.prefix : undefined,
				branchNameTemplate: typeof value.branchNameTemplate === 'string' ? value.branchNameTemplate : 'agent/{agentSlug}/{assignmentId}',
				worktree: value.worktree === 'reuse' ? 'reuse' : 'new',
				updateBaseBeforeRun: value.updateBaseBeforeRun !== false,
				mergeTargetBeforeSave: value.mergeTargetBeforeSave !== false,
			};
		case 'staging-release':
			return { kind, base: 'staging', target: 'main' };
		default:
			diagnostics.push({
				severity: 'error',
				slug,
				field: `${field}.kind`,
				message: `Unsupported branch policy "${kind}".`,
			});
			return { kind: 'read-only', base: 'main' };
	}
}

function normalizeQuestionPolicy(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): AgentQuestionPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return undefined;
	}
	return value as AgentQuestionPolicy;
}

function normalizeIdentity(value: unknown, diagnostics: AgentSpecDiagnostic[], slug: string): AgentDefinitionIdentity | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ severity: 'error', slug, field: 'identity', message: 'Expected identity to be an object.' });
		return undefined;
	}
	return {
		purpose: typeof value.purpose === 'string' ? value.purpose : '',
		responsibilities: Array.isArray(value.responsibilities) ? value.responsibilities.filter((entry): entry is string => typeof entry === 'string') : [],
		durableInstructions: typeof value.durableInstructions === 'string' ? value.durableInstructions : '',
	};
}

function normalizeActivityProfile(
	value: unknown,
	activityType: AgentActivityType,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentActivityProfile | null {
	const field = `activityProfiles.${activityType}`;
	if (!isPlainObject(value)) {
		diagnostics.push({ severity: 'error', slug, field, message: `Expected ${field} to be an object.` });
		return null;
	}
	const enabled = ensureBoolean(value.enabled, `${field}.enabled`, diagnostics, slug, true);
	const handler = ensureString(value.handler, `${field}.handler`, diagnostics, slug) as AgentHandlerKind;
	if (!GENERIC_HANDLER_KINDS.has(handler)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `${field}.handler`,
			message: `Unsupported first-party handler "${handler}". Use writer, actor, estimate, releaser, or reporter.`,
		});
	}
	const prompt = isPlainObject(value.prompt) ? value.prompt : {};
	if (!isPlainObject(value.prompt)) {
		diagnostics.push({ severity: 'error', slug, field: `${field}.prompt`, message: `Expected ${field}.prompt to be an object.` });
	}
	return {
		enabled,
		handler: handler as AgentActivityProfile['handler'],
		prompt: {
			system: ensureString(prompt.system, `${field}.prompt.system`, diagnostics, slug),
			task: typeof prompt.task === 'string' ? prompt.task : undefined,
			templates: isPlainObject(prompt.templates) ? prompt.templates as Record<string, string> : undefined,
		},
		branchPolicy: normalizeBranchPolicy(value.branchPolicy, `${field}.branchPolicy`, diagnostics, slug),
		contentAccess: normalizeContentAccess(value.contentAccess, diagnostics, slug, `${field}.contentAccess`),
		tools: normalizeToolPolicy(value.tools, `${field}.tools`, enabled, diagnostics, slug),
		outputs: normalizeOutputs(value.outputs, diagnostics, slug),
		questionPolicy: normalizeQuestionPolicy(value.questionPolicy, `${field}.questionPolicy`, diagnostics, slug),
		execution: isPlainObject(value.execution) ? value.execution as AgentActivityProfile['execution'] : undefined,
	};
}

function normalizeActivityProfiles(value: unknown, diagnostics: AgentSpecDiagnostic[], slug: string) {
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'activityProfiles',
			message: 'Expected activityProfiles to be an object.',
		});
		return {};
	}
	const profiles: Partial<Record<AgentActivityType, AgentActivityProfile>> = {};
	for (const [key, profile] of Object.entries(value)) {
		if (!ACTIVITY_TYPES.has(key)) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `activityProfiles.${key}`,
				message: `Unsupported activity profile "${key}".`,
			});
			continue;
		}
		const normalized = normalizeActivityProfile(profile, key as AgentActivityType, diagnostics, slug);
		if (normalized) profiles[key as AgentActivityType] = normalized;
	}
	return profiles;
}

function selectDefaultActivityProfile(
	profiles: Partial<Record<AgentActivityType, AgentActivityProfile>>,
): [AgentActivityType, AgentActivityProfile] | null {
	for (const activity of ['acting', 'estimating', 'planning', 'reviewing', 'reporting'] as const) {
		const profile = profiles[activity];
		if (profile?.enabled) return [activity, profile];
	}
	return null;
}

function normalizeParts(
	raw: RawAgentRuntimeSpec,
	slugHint: string,
	diagnostics: AgentSpecDiagnostic[],
): AgentSpecParts | null {
	const slug = ensureString(raw.slug ?? slugHint, 'slug', diagnostics, slugHint) || slugHint;
	for (const field of LEGACY_AGENT_FIELDS) {
		if (raw[field] !== undefined) {
			diagnostics.push({
				severity: 'error',
				slug,
				field,
				message: `${field} is legacy top-level agent configuration. Move it under activityProfiles.<activity>.`,
			});
		}
	}
	const activityProfiles = normalizeActivityProfiles(raw.activityProfiles, diagnostics, slug);
	const selected = selectDefaultActivityProfile(activityProfiles);
	if (!selected) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'activityProfiles',
			message: 'Expected at least one enabled activity profile.',
		});
		return null;
	}
	const [activityType, profile] = selected;
	const handler = profile.handler as AgentHandlerKind;
	const triggers = Array.isArray(raw.triggers)
		? raw.triggers.map((entry, index) => normalizeTrigger(entry, index, diagnostics, slug)).filter((entry): entry is AgentTriggerConfig => Boolean(entry))
		: [];
	if (!triggers.length) {
		triggers.push({ type: 'startup', runOnStart: true });
	}
	try {
		const cli = normalizeAgentCliOptions(raw.cli);
		const enabled = ensureBoolean(raw.enabled, 'enabled', diagnostics, slug, true);
		const spec: AgentSpecParts = {
			slug,
			handler,
			activityType,
			activityProfiles,
			branchPolicy: profile.branchPolicy,
			questionPolicy: profile.questionPolicy,
			identity: normalizeIdentity(raw.identity, diagnostics, slug),
			projectAgentClassId: ensureString(
				raw.projectAgentClassId ?? raw.agentClassId ?? raw.agentClass,
				'projectAgentClassId',
				diagnostics,
				slug,
			),
			projectAgentClassSlug: ensureString(
				raw.projectAgentClassSlug ?? raw.agentClassSlug ?? raw.projectAgentClassId ?? raw.agentClassId ?? raw.agentClass,
				'projectAgentClassSlug',
				diagnostics,
				slug,
			),
			activityConfig: {
				workPackageKind: profile.handler,
				domain: activityType,
				activityType,
				branchPolicy: profile.branchPolicy,
				questionPolicy: profile.questionPolicy,
			},
			enabled,
			systemPrompt: profile.prompt.system,
			persona: typeof raw.persona === 'string' ? raw.persona : '',
			cli,
			triggers,
			triggerPolicy: isPlainObject(raw.triggerPolicy)
				? {
					maxRunsPerCycle:
						typeof raw.triggerPolicy.maxRunsPerCycle === 'number' ? raw.triggerPolicy.maxRunsPerCycle : undefined,
					messageBatchSize:
						typeof raw.triggerPolicy.messageBatchSize === 'number' ? raw.triggerPolicy.messageBatchSize : undefined,
				}
				: undefined,
			permissions: [],
			permissionPolicy: normalizePermissionPolicy(raw.permissionPolicy, diagnostics, slug),
			tools: profile.tools,
			contentAccess: profile.contentAccess,
			context: { queries: [] },
			execution: normalizeExecution(raw.execution, diagnostics, slug),
			outputs: profile.outputs,
		};
		return spec;
	} catch (error) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'cli',
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function normalizeAgentRuntimeSpec(
	raw: RawAgentRuntimeSpec,
	context: AgentSpecValidationContext,
): AgentSpecNormalizationResult {
	const slugHint = typeof raw.slug === 'string' && raw.slug ? raw.slug : 'unknown-agent';
	const diagnostics: AgentSpecDiagnostic[] = [];
	const parts = normalizeParts(raw, slugHint, diagnostics);
	if (!parts) {
		return { spec: null, diagnostics };
	}

	const spec: NormalizedAgentRuntimeSpec = {
		...parts,
		name: typeof raw.name === 'string' ? raw.name : undefined,
		description: typeof raw.description === 'string' ? raw.description : undefined,
		summary: typeof raw.summary === 'string' ? raw.summary : undefined,
		operator: typeof raw.operator === 'string' ? raw.operator : undefined,
		runtimeStatus: typeof raw.runtimeStatus === 'string' ? raw.runtimeStatus : undefined,
		capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((entry): entry is string => typeof entry === 'string') : [],
		tags: Array.isArray(raw.tags) ? raw.tags.filter((entry): entry is string => typeof entry === 'string') : [],
	};

	if (!context.registeredHandlers.includes(spec.handler)) {
		diagnostics.push({
			severity: 'error',
			slug: spec.slug,
			field: 'handler',
			message: `No runtime handler is registered for "${spec.handler}".`,
		});
	}

	for (const trigger of spec.triggers) {
		if (trigger.type === 'message') {
			for (const messageType of trigger.messageTypes ?? []) {
				if (
					!context.messageTypes.includes(messageType)
					|| !AGENT_MESSAGE_TYPES.includes(messageType as (typeof AGENT_MESSAGE_TYPES)[number])
				) {
					diagnostics.push({
						severity: 'error',
						slug: spec.slug,
						field: 'triggers.messageTypes',
						message: `Unknown message trigger type "${messageType}".`,
					});
				}
			}
		}
		if (trigger.type === 'follow' && !(trigger.models?.length)) {
			diagnostics.push({
				severity: 'error',
				slug: spec.slug,
				field: 'triggers.models',
				message: 'Follow triggers must declare at least one model.',
			});
		}
	}

	for (const messageType of spec.outputs.messageTypes) {
		if (
			!context.messageTypes.includes(messageType)
			|| !AGENT_MESSAGE_TYPES.includes(messageType as (typeof AGENT_MESSAGE_TYPES)[number])
		) {
			diagnostics.push({
				severity: 'error',
				slug: spec.slug,
				field: 'outputs.messageTypes',
				message: `Unknown emitted message type "${messageType}".`,
			});
		}
	}

	if (spec.cli.allowTools?.some((tool) => !AGENT_CLI_ALLOW_TOOLS.includes(tool))) {
		diagnostics.push({
			severity: 'error',
			slug: spec.slug,
			field: 'cli.allowTools',
			message: 'Agent declared an unsupported tool allowance.',
		});
	}

	return {
		spec: diagnostics.some((entry) => entry.severity === 'error') ? null : spec,
		diagnostics,
	};
}
