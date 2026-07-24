import type {
	ExecutionArtifactRef,
	ExecutionProviderDescriptor,
	ExecutionProviderObserveInput,
	ExecutionProviderObservation,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../runtime/runtime-types.ts';

export interface JiraStatusMapping {
	doneStatuses: string[];
	blockedStatuses: string[];
	cancelledStatuses: string[];
	inProgressStatuses: string[];
}

export interface JiraExecutionProviderConfig extends JiraStatusMapping {
	baseUrl: string;
	email: string;
	apiToken: string;
	projectKey: string;
	issueType: string;
	storyPointsField?: string | null;
}

export interface JiraIssueSnapshot {
	key: string;
	url: string;
	status: string;
	statusCategory?: string | null;
	assignee?: string | null;
	summary?: string | null;
	timeTracking?: Record<string, unknown>;
	comments?: Array<Record<string, unknown>>;
	attachments?: Array<Record<string, unknown>>;
	links?: Array<Record<string, unknown>>;
	fields?: Record<string, unknown>;
}

export interface JiraExecutionProviderAdapterOptions {
	config?: JiraExecutionProviderConfig | null;
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export class JiraProviderError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = true,
		readonly status?: number,
	) {
		super(message);
		this.name = 'JiraProviderError';
	}
}

export const DEFAULT_DONE_STATUSES = ['Done', 'Resolved', 'Closed'];
export const DEFAULT_BLOCKED_STATUSES = ['Blocked'];
export const DEFAULT_CANCELLED_STATUSES = ['Cancelled', "Won't Do", 'Wont Do'];
export const DEFAULT_IN_PROGRESS_STATUSES = ['In Progress'];
export const JIRA_ASSIGNMENT_PROPERTY = 'treeseedAssignment';

export function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

export function parseList(value: string, fallback: string[]) {
	if (!value.trim()) return fallback;
	const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
	return values.length ? values : fallback;
}

export function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/u, '');
}

export function resolveJiraExecutionProviderConfig(
	env: NodeJS.ProcessEnv = process.env,
): JiraExecutionProviderConfig | null {
	const baseUrl = envValue(env, 'TREESEED_JIRA_BASE_URL');
	const email = envValue(env, 'TREESEED_JIRA_EMAIL');
	const apiToken = envValue(env, 'TREESEED_JIRA_API_TOKEN');
	const projectKey = envValue(env, 'TREESEED_JIRA_PROJECT_KEY');
	if (!baseUrl || !email || !apiToken || !projectKey) return null;
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		email,
		apiToken,
		projectKey,
		issueType: envValue(env, 'TREESEED_JIRA_ISSUE_TYPE') || 'Task',
		doneStatuses: parseList(envValue(env, 'TREESEED_JIRA_DONE_STATUSES'), DEFAULT_DONE_STATUSES),
		blockedStatuses: parseList(envValue(env, 'TREESEED_JIRA_BLOCKED_STATUSES'), DEFAULT_BLOCKED_STATUSES),
		cancelledStatuses: parseList(envValue(env, 'TREESEED_JIRA_CANCELLED_STATUSES'), DEFAULT_CANCELLED_STATUSES),
		inProgressStatuses: parseList(envValue(env, 'TREESEED_JIRA_IN_PROGRESS_STATUSES'), DEFAULT_IN_PROGRESS_STATUSES),
		storyPointsField: envValue(env, 'TREESEED_JIRA_STORY_POINTS_FIELD') || null,
	};
}

export function descriptor(): ExecutionProviderDescriptor {
	return {
		id: 'jira',
		kind: 'human_issue_queue',
		capabilities: [
			'human_review',
			'manual_execution',
			'qa_validation',
			'project_management',
			'issue_queue',
			'planning',
			'implementation',
			'review',
			'test',
		],
		capabilityAliases: ['jira', 'jira_issue_queue'],
		nativeUnit: 'issue_hour',
		quotaVisibility: 'partial',
		maxConcurrentAssignments: 1,
		supportsAsync: true,
		supportsCancel: true,
		supportsResume: true,
		supportsUsage: true,
		supportsArtifacts: true,
	};
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

export function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

export function lowerSet(values: string[]) {
	return new Set(values.map((entry) => entry.toLowerCase()));
}

export function sanitizeJiraLabel(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120) || 'assignment';
}

export function assignmentLabel(assignmentId: string) {
	return `treeseed-assignment-${sanitizeJiraLabel(assignmentId)}`;
}

export function issueUrl(config: JiraExecutionProviderConfig, issueKey: string) {
	return `${config.baseUrl}/browse/${encodeURIComponent(issueKey)}`;
}

export function textDoc(text: string) {
	return {
		type: 'doc',
		version: 1,
		content: [{
			type: 'paragraph',
			content: [{ type: 'text', text }],
		}],
	};
}

export function fieldSummary(value: unknown) {
	try {
		return JSON.stringify(value, (_key, inner) => {
			if (typeof inner === 'string' && /token|secret|password|authorization|api[_-]?key/iu.test(inner)) {
				return '<redacted>';
			}
			return inner;
		}, 2);
	} catch {
		return String(value ?? '<unavailable>');
	}
}

export function jiraDocFromWorkPackage(input: ExecutionProviderInvocation): Record<string, unknown> {
	const handles = record(input.assignment.capabilityHandles);
	const workspace = record(input.assignment.workspaceContext);
	const safeAssignment = {
		id: input.assignment.id,
		projectId: input.assignment.projectId,
		teamId: input.assignment.teamId,
		capacityProviderId: input.assignment.capacityProviderId,
		executionProviderId: input.assignment.executionProviderId ?? null,
		mode: input.assignment.mode,
		capabilityHandleKinds: Object.keys(handles),
		workspaceContextKeys: Object.keys(workspace).filter((key) => !/token|secret|credential|handle/iu.test(key)),
	};
	const text = [
		`Summary:\n${input.workPackage.summary}`,
		`Instructions:\n${input.workPackage.instructions}`,
		`Expected outputs:\n${fieldSummary(input.workPackage.expectedOutputs)}`,
		`Constraints:\n${fieldSummary(input.workPackage.constraints)}`,
		`Assignment:\n${fieldSummary(safeAssignment)}`,
		`Capacity envelope:\n${fieldSummary(input.capacityEnvelope)}`,
		`Decision input:\n${fieldSummary(input.decisionInput.input)}`,
		`Allowed paths:\n${(input.workPackage.constraints.allowedPaths ?? input.agent.execution.allowedPaths ?? []).join('\n') || '<none>'}`,
		`Forbidden paths:\n${(input.workPackage.constraints.forbiddenPaths ?? input.agent.execution.forbiddenPaths ?? []).join('\n') || '<none>'}`,
	].join('\n\n');
	return textDoc(text);
}

export function authHeader(config: JiraExecutionProviderConfig) {
	return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
}

export function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'Jira authentication failed.';
	if (status === 404) return 'Jira issue was not found.';
	if (status === 429 || status >= 500) return 'Jira provider is temporarily unavailable.';
	return `Jira request failed with status ${status} (${code}).`;
}

export function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new JiraProviderError('jira_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new JiraProviderError('jira_issue_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 429 || status >= 500) return new JiraProviderError('jira_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new JiraProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

export function safeCommentBodies(issue: JiraIssueSnapshot) {
	return (issue.comments ?? []).map((comment, index) => ({
		id: stringValue(comment.id) ?? `comment-${index}`,
		created: stringValue(comment.created),
		updated: stringValue(comment.updated),
	}));
}

export function safeAttachmentRefs(issue: JiraIssueSnapshot) {
	return (issue.attachments ?? []).map((attachment) => ({
		id: stringValue(attachment.id),
		filename: stringValue(attachment.filename),
		mimeType: stringValue(attachment.mimeType),
		size: typeof attachment.size === 'number' ? attachment.size : null,
		content: stringValue(attachment.content),
	})).filter((entry) => entry.id || entry.filename || entry.content);
}

export function safeLinkRefs(issue: JiraIssueSnapshot) {
	return (issue.links ?? []).map((link, index) => {
		const outwardIssue = record(link.outwardIssue);
		const inwardIssue = record(link.inwardIssue);
		const type = record(link.type);
		return {
			id: stringValue(link.id) ?? `link-${index}`,
			type: stringValue(type.name),
			outwardIssueKey: stringValue(outwardIssue.key),
			inwardIssueKey: stringValue(inwardIssue.key),
		};
	});
}

export function normalizeIssue(config: JiraExecutionProviderConfig, value: unknown): JiraIssueSnapshot {
	const issue = record(value);
	const key = stringValue(issue.key);
	if (!key) {
		throw new JiraProviderError('jira_payload_invalid', 'Jira issue payload did not include an issue key.', false);
	}
	const fields = record(issue.fields);
	const status = record(fields.status);
	const assignee = record(fields.assignee);
	const comment = record(fields.comment);
	return {
		key,
		url: issueUrl(config, key),
		status: stringValue(status.name) ?? 'Unknown',
		statusCategory: stringValue(record(status.statusCategory).name),
		assignee: stringValue(assignee.displayName, assignee.emailAddress),
		summary: stringValue(fields.summary),
		timeTracking: record(fields.timetracking),
		comments: arrayOfRecords(comment.comments),
		attachments: arrayOfRecords(fields.attachment),
		links: arrayOfRecords(fields.issuelinks),
		fields,
	};
}

export function statusToSnapshot(config: JiraExecutionProviderConfig, issue: JiraIssueSnapshot): Pick<ExecutionRunSnapshot, 'status' | 'retryable' | 'code'> {
	const status = issue.status.toLowerCase();
	if (lowerSet(config.doneStatuses).has(status)) return { status: 'completed' };
	if (lowerSet(config.inProgressStatuses).has(status)) return { status: 'running' };
	if (lowerSet(config.blockedStatuses).has(status)) return { status: 'blocked', retryable: true, code: 'jira_issue_blocked' };
	if (lowerSet(config.cancelledStatuses).has(status)) return { status: 'failed', retryable: false, code: 'jira_issue_cancelled' };
	if (['to do', 'todo', 'open', 'backlog', 'selected for development'].includes(status)) return { status: 'waiting' };
	return { status: 'waiting', retryable: true, code: 'jira_status_unmapped' };
}

export function issueSnapshot(config: JiraExecutionProviderConfig, issue: JiraIssueSnapshot): ExecutionRunSnapshot {
	const mapped = statusToSnapshot(config, issue);
	return {
		status: mapped.status,
		summary: mapped.status === 'completed'
			? `Jira issue ${issue.key} is complete.`
			: `Jira issue ${issue.key} is ${issue.status}.`,
		runId: issue.key,
		externalRef: issue.key,
		externalUrl: issue.url,
		outputs: {
			issueKey: issue.key,
			issueUrl: issue.url,
			assignee: issue.assignee ?? null,
			jiraStatus: issue.status,
			comments: safeCommentBodies(issue),
			attachments: safeAttachmentRefs(issue),
			links: safeLinkRefs(issue),
			blockerReason: mapped.status === 'blocked' ? issue.summary ?? issue.status : null,
			completionSummary: mapped.status === 'completed' ? issue.summary ?? `Jira issue ${issue.key} completed.` : null,
			timeTracking: issue.timeTracking ?? {},
		},
		retryable: mapped.retryable,
		code: mapped.code,
		metadata: {
			provider: 'jira',
			issueKey: issue.key,
			issueStatus: issue.status,
			statusCategory: issue.statusCategory ?? null,
		},
	};
}

export { JiraExecutionProviderAdapter } from '../reconciliation/execution-jira-adapter.ts';

