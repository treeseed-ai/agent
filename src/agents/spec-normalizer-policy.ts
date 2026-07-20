import { assertKnownAgentToolIds } from '@treeseed/sdk';
import { TREESEED_CONTENT_ACTIONS, type TreeseedContentAction } from '@treeseed/sdk/content-operations';
import type { AgentContentAccessPolicy, AgentPermissionPolicy, AgentToolPolicy, AgentTriggerConfig, AgentTriggerKind } from '@treeseed/sdk/types/agents';
import type { AgentSpecDiagnostic } from './spec-types.ts';
import { TRIGGER_KINDS, ensureString, isPlainObject } from './spec-normalizer-primitives.ts';

export function normalizeTrigger(
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

export function normalizePermissionPolicy(
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

export function normalizeToolPolicy(
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

export function normalizeContentAccess(
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
