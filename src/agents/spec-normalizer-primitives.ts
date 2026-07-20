import type { AgentTriggerKind } from '@treeseed/sdk/types/agents';
import type { AgentSpecDiagnostic } from './spec-types.ts';

export const TRIGGER_KINDS: readonly AgentTriggerKind[] = ['schedule', 'message', 'follow', 'startup'];
export const ACTIVITY_TYPES = new Set<string>(['planning', 'estimating', 'acting', 'reviewing', 'reporting']);
export const GENERIC_HANDLER_KINDS = new Set<string>(['writer', 'actor', 'estimate', 'releaser', 'reporter']);
export const EXECUTION_PROVIDERS = new Set([
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
export const APPROVAL_POLICIES = new Set(['never', 'on_request', 'always']);
export const SANDBOX_MODES = new Set(['read_only', 'workspace_write']);
export const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
export const DEFAULT_CODEX_ALLOWED_PATHS = ['**'];
export const DEFAULT_CODEX_FORBIDDEN_PATHS = ['.git/**', '.agent-worktrees/**', '.treeseed/secrets/**', 'node_modules/**'];
export const LEGACY_AGENT_FIELDS = [
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function ensureString(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string) {
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

export function ensureBoolean(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string, fallback = false) {
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

export function ensurePositiveNumber(
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

export function normalizeOptionalString(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): string | undefined {
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

export function normalizeStringChoice<T extends string>(
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

export function normalizeStringArray(
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

