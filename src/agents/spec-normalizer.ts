import {
	AGENT_CLI_ALLOW_TOOLS,
	type AgentExecutionConfig,
	type AgentHandlerKind,
	type AgentOutputContract,
	type AgentPermissionConfig,
	type AgentPermissionOperation,
	type AgentTriggerConfig,
	type AgentTriggerKind,
} from '@treeseed/core/types/agents';
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

function normalizeExecution(
	value: unknown,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentExecutionConfig {
	const next = isPlainObject(value) ? value : {};
	return {
		maxConcurrency: ensurePositiveNumber(next.maxConcurrency, 'execution.maxConcurrency', diagnostics, slug, 1),
		timeoutSeconds: ensurePositiveNumber(next.timeoutSeconds, 'execution.timeoutSeconds', diagnostics, slug, 900),
		cooldownSeconds: ensurePositiveNumber(next.cooldownSeconds, 'execution.cooldownSeconds', diagnostics, slug, 30, true),
		leaseSeconds: ensurePositiveNumber(next.leaseSeconds, 'execution.leaseSeconds', diagnostics, slug, 300),
		retryLimit: ensurePositiveNumber(next.retryLimit, 'execution.retryLimit', diagnostics, slug, 3, true),
		branchPrefix: ensureString(next.branchPrefix ?? 'agent', 'execution.branchPrefix', diagnostics, slug) || 'agent',
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

function normalizeParts(
	raw: RawAgentRuntimeSpec,
	slugHint: string,
	diagnostics: AgentSpecDiagnostic[],
): AgentSpecParts | null {
	const slug = ensureString(raw.slug ?? slugHint, 'slug', diagnostics, slugHint) || slugHint;
	const handler = ensureString(raw.handler, 'handler', diagnostics, slug) as AgentHandlerKind;
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
