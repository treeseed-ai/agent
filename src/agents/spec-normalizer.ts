import {
	AGENT_CLI_ALLOW_TOOLS,
	type AgentExecutionConfig,
	type AgentHandlerKind,
	type AgentOutputContract,
	type AgentProviderFallbackPolicy,
	type AgentProviderProfile,
	type AgentPermissionConfig,
	type AgentPermissionOperation,
	type AgentTriggerConfig,
	type AgentTriggerKind,
} from '@treeseed/sdk/types/agents';
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
const GENERIC_HANDLER_KINDS = new Set(['plan', 'research', 'act', 'review', 'report']);
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

function normalizeHandlerConfig(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'handlerConfig',
			message: 'Expected handlerConfig to be an object.',
		});
		return undefined;
	}
	if (value.delegation !== undefined && !isPlainObject(value.delegation)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'handlerConfig.delegation',
			message: 'Expected handlerConfig.delegation to be an object.',
		});
	}
	if (value.resourceNeeds !== undefined && !Array.isArray(value.resourceNeeds)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'handlerConfig.resourceNeeds',
			message: 'Expected handlerConfig.resourceNeeds to be an array.',
		});
	}
	return value;
}

function normalizeParts(
	raw: RawAgentRuntimeSpec,
	slugHint: string,
	diagnostics: AgentSpecDiagnostic[],
): AgentSpecParts | null {
	const slug = ensureString(raw.slug ?? slugHint, 'slug', diagnostics, slugHint) || slugHint;
	const rawHandler = ensureString(raw.handler, 'handler', diagnostics, slug);
	const handler = rawHandler as AgentHandlerKind;
	if (!GENERIC_HANDLER_KINDS.has(handler)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'handler',
			message: `Unsupported first-party handler "${handler}". Use plan, research, act, review, or report.`,
		});
	}
	const triggers = Array.isArray(raw.triggers)
		? raw.triggers.map((entry, index) => normalizeTrigger(entry, index, diagnostics, slug)).filter((entry): entry is AgentTriggerConfig => Boolean(entry))
		: [];
	if (!triggers.length) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'triggers',
			message: 'Expected at least one trigger.',
		});
	}
	try {
		const cli = normalizeAgentCliOptions(raw.cli);
		const spec: AgentSpecParts = {
			slug,
			handler,
			projectAgentClassId: ensureString(
				raw.projectAgentClassId ?? raw.agentClassId,
				'projectAgentClassId',
				diagnostics,
				slug,
			),
			projectAgentClassSlug: ensureString(
				raw.projectAgentClassSlug ?? raw.agentClassSlug ?? raw.projectAgentClassId ?? raw.agentClassId,
				'projectAgentClassSlug',
				diagnostics,
				slug,
			),
			handlerConfig: normalizeHandlerConfig(raw.handlerConfig, diagnostics, slug),
			enabled: ensureBoolean(raw.enabled, 'enabled', diagnostics, slug, true),
			systemPrompt: ensureString(raw.systemPrompt, 'systemPrompt', diagnostics, slug),
			persona: ensureString(raw.persona, 'persona', diagnostics, slug),
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
			permissions: normalizePermissions(raw.permissions, diagnostics, slug),
			context: normalizeContext(raw.context, diagnostics, slug),
			execution: normalizeExecution(raw.execution, diagnostics, slug),
			outputs: normalizeOutputs(raw.outputs, diagnostics, slug),
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
			const messagePermission = spec.permissions.find((permission) => permission.model === 'message');
			if (!messagePermission || !messagePermission.operations.includes('pick') || !messagePermission.operations.includes('update')) {
				diagnostics.push({
					severity: 'error',
					slug: spec.slug,
					field: 'permissions',
					message: 'Message-triggered agents must allow message pick and update operations.',
				});
			}
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
