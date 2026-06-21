import type {
	ExecutionArtifactRef,
	ExecutionProviderDescriptor,
	ExecutionProviderObserveInput,
	ExecutionProviderObservation,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';

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

const DEFAULT_DONE_STATUSES = ['Done', 'Resolved', 'Closed'];
const DEFAULT_BLOCKED_STATUSES = ['Blocked'];
const DEFAULT_CANCELLED_STATUSES = ['Cancelled', "Won't Do", 'Wont Do'];
const DEFAULT_IN_PROGRESS_STATUSES = ['In Progress'];
const JIRA_ASSIGNMENT_PROPERTY = 'treeseedAssignment';

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

function parseList(value: string, fallback: string[]) {
	if (!value.trim()) return fallback;
	const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
	return values.length ? values : fallback;
}

function normalizeBaseUrl(value: string) {
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

function descriptor(): ExecutionProviderDescriptor {
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

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function lowerSet(values: string[]) {
	return new Set(values.map((entry) => entry.toLowerCase()));
}

function sanitizeJiraLabel(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120) || 'assignment';
}

function assignmentLabel(assignmentId: string) {
	return `treeseed-assignment-${sanitizeJiraLabel(assignmentId)}`;
}

function issueUrl(config: JiraExecutionProviderConfig, issueKey: string) {
	return `${config.baseUrl}/browse/${encodeURIComponent(issueKey)}`;
}

function textDoc(text: string) {
	return {
		type: 'doc',
		version: 1,
		content: [{
			type: 'paragraph',
			content: [{ type: 'text', text }],
		}],
	};
}

function fieldSummary(value: unknown) {
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

function jiraDocFromWorkPackage(input: ExecutionProviderInvocation): Record<string, unknown> {
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

function authHeader(config: JiraExecutionProviderConfig) {
	return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
}

function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'Jira authentication failed.';
	if (status === 404) return 'Jira issue was not found.';
	if (status === 429 || status >= 500) return 'Jira provider is temporarily unavailable.';
	return `Jira request failed with status ${status} (${code}).`;
}

function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new JiraProviderError('jira_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new JiraProviderError('jira_issue_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 429 || status >= 500) return new JiraProviderError('jira_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new JiraProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

function safeCommentBodies(issue: JiraIssueSnapshot) {
	return (issue.comments ?? []).map((comment, index) => ({
		id: stringValue(comment.id) ?? `comment-${index}`,
		created: stringValue(comment.created),
		updated: stringValue(comment.updated),
	}));
}

function safeAttachmentRefs(issue: JiraIssueSnapshot) {
	return (issue.attachments ?? []).map((attachment) => ({
		id: stringValue(attachment.id),
		filename: stringValue(attachment.filename),
		mimeType: stringValue(attachment.mimeType),
		size: typeof attachment.size === 'number' ? attachment.size : null,
		content: stringValue(attachment.content),
	})).filter((entry) => entry.id || entry.filename || entry.content);
}

function safeLinkRefs(issue: JiraIssueSnapshot) {
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

function normalizeIssue(config: JiraExecutionProviderConfig, value: unknown): JiraIssueSnapshot {
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

function statusToSnapshot(config: JiraExecutionProviderConfig, issue: JiraIssueSnapshot): Pick<ExecutionRunSnapshot, 'status' | 'retryable' | 'code'> {
	const status = issue.status.toLowerCase();
	if (lowerSet(config.doneStatuses).has(status)) return { status: 'completed' };
	if (lowerSet(config.inProgressStatuses).has(status)) return { status: 'running' };
	if (lowerSet(config.blockedStatuses).has(status)) return { status: 'blocked', retryable: true, code: 'jira_issue_blocked' };
	if (lowerSet(config.cancelledStatuses).has(status)) return { status: 'failed', retryable: false, code: 'jira_issue_cancelled' };
	if (['to do', 'todo', 'open', 'backlog', 'selected for development'].includes(status)) return { status: 'waiting' };
	return { status: 'waiting', retryable: true, code: 'jira_status_unmapped' };
}

function issueSnapshot(config: JiraExecutionProviderConfig, issue: JiraIssueSnapshot): ExecutionRunSnapshot {
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

export class JiraExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: JiraExecutionProviderAdapterOptions = {}) {}

	private config() {
		return this.options.config === undefined ? resolveJiraExecutionProviderConfig() : this.options.config;
	}

	private fetchImpl() {
		return this.options.fetchImpl ?? fetch;
	}

	async describe() {
		return descriptor();
	}

	async observe(_input: ExecutionProviderObserveInput): Promise<ExecutionProviderObservation> {
		const config = this.config();
		const provider = descriptor();
		if (!config) {
			return {
				descriptor: provider,
				available: false,
				pressure: 'exhausted',
				blockedReason: 'Jira execution provider is not configured.',
				metadata: { configured: false },
			};
		}
		return {
			descriptor: provider,
			available: true,
			pressure: 'normal',
			activeAssignmentCount: 0,
			metadata: {
				projectKey: config.projectKey,
				baseUrl: config.baseUrl,
				configured: true,
			},
		};
	}

	async prepare() {
		const config = this.config();
		if (!config) {
			return {
				accepted: false,
				summary: 'Jira execution provider is not configured.',
				retryable: false,
				code: 'jira_provider_not_configured',
			};
		}
		return {
			accepted: true,
			summary: `Jira execution provider is configured for ${config.projectKey}.`,
			metadata: {
				projectKey: config.projectKey,
				baseUrl: config.baseUrl,
			},
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const label = assignmentLabel(input.assignment.id);
		const existing = await this.findIssueByAssignmentLabel(config, label);
		if (existing) {
			return {
				status: 'waiting',
				summary: `Jira issue ${existing.key} is waiting for human execution.`,
				runId: existing.key,
				externalRef: existing.key,
				externalUrl: existing.url,
				outputs: {
					issueKey: existing.key,
					issueUrl: existing.url,
					jiraStatus: existing.status,
					projectKey: config.projectKey,
				},
				metadata: {
					provider: 'jira',
					assignmentId: input.assignment.id,
					issueKey: existing.key,
					issueStatus: existing.status,
					reused: true,
				},
			};
		}
		const created = await this.createIssue(config, input, label);
		await this.setAssignmentProperty(config, created.key, input);
		return {
			status: 'waiting',
			summary: `Jira issue ${created.key} is waiting for human execution.`,
			runId: created.key,
			externalRef: created.key,
			externalUrl: created.url,
			outputs: {
				issueKey: created.key,
				issueUrl: created.url,
				jiraStatus: created.status,
				projectKey: config.projectKey,
			},
			metadata: {
				provider: 'jira',
				assignmentId: input.assignment.id,
				issueKey: created.key,
				issueStatus: created.status,
				reused: false,
			},
		};
	}

	async poll(input: ExecutionRunRef): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		try {
			const issue = await this.fetchIssue(config, input.externalRef ?? input.runId);
			return issueSnapshot(config, issue);
		} catch (error) {
			return this.snapshotFromError(error, input);
		}
	}

	resume(input: ExecutionRunRef): Promise<ExecutionRunSnapshot> {
		return this.poll(input);
	}

	async cancel(input: ExecutionRunRef & { reason: string }): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const issueKey = input.externalRef ?? input.runId;
		let transitionApplied = false;
		const transitions = await this.requestJson(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
			method: 'GET',
			code: 'jira_transition_lookup_failed',
		}).catch(() => ({ transitions: [] }));
		const transition = arrayOfRecords(record(transitions).transitions).find((candidate) => {
			const name = `${stringValue(candidate.name) ?? ''} ${stringValue(record(record(candidate.to).statusCategory).name) ?? ''} ${stringValue(record(candidate.to).name) ?? ''}`.toLowerCase();
			return ['cancel', "won't do", 'wont do', 'decline', 'close'].some((needle) => name.includes(needle));
		});
		if (transition && stringValue(transition.id)) {
			await this.requestJson(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
				method: 'POST',
				body: { transition: { id: stringValue(transition.id) } },
				code: 'jira_transition_failed',
			});
			transitionApplied = true;
		}
		await this.requestJson(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
			method: 'POST',
			body: { body: textDoc(`Treeseed cancelled this assignment: ${input.reason}`) },
			code: 'jira_cancel_comment_failed',
		}).catch(() => null);
		return {
			status: 'cancelled',
			summary: `Jira issue ${issueKey} was cancelled for Treeseed assignment execution.`,
			runId: input.runId,
			externalRef: issueKey,
			externalUrl: issueUrl(config, issueKey),
			code: 'jira_issue_cancelled',
			retryable: false,
			metadata: {
				provider: 'jira',
				issueKey,
				transitionApplied,
			},
		};
	}

	async collectUsage(input: ExecutionRunRef): Promise<ExecutionUsageActual[]> {
		const config = this.requireConfig();
		const issue = await this.fetchIssue(config, input.externalRef ?? input.runId);
		const usage: ExecutionUsageActual[] = [];
		const seconds = typeof issue.timeTracking?.timeSpentSeconds === 'number' ? issue.timeTracking.timeSpentSeconds : 0;
		if (seconds > 0) {
			usage.push({
				kind: 'jira_time_spent',
				unit: 'second',
				amount: seconds,
				source: 'jira',
				partial: false,
			});
		}
		if (config.storyPointsField) {
			const value = issue.fields?.[config.storyPointsField];
			const amount = typeof value === 'number' ? value : Number.NaN;
			if (Number.isFinite(amount) && amount > 0) {
				usage.push({
					kind: 'jira_story_points',
					unit: 'story_point',
					amount,
					source: 'jira',
					partial: true,
				});
			}
		}
		return usage;
	}

	async collectArtifacts(input: ExecutionRunRef): Promise<ExecutionArtifactRef[]> {
		const config = this.requireConfig();
		const issue = await this.fetchIssue(config, input.externalRef ?? input.runId);
		const artifacts: ExecutionArtifactRef[] = [{
			kind: 'external_issue',
			name: issue.key,
			externalUrl: issue.url,
			metadata: {
				provider: 'jira',
				status: issue.status,
			},
		}];
		for (const attachment of safeAttachmentRefs(issue)) {
			artifacts.push({
				kind: 'jira_attachment',
				name: attachment.filename ?? attachment.id ?? null,
				externalUrl: attachment.content ?? null,
				mediaType: attachment.mimeType ?? null,
				metadata: {
					provider: 'jira',
					issueKey: issue.key,
					attachmentId: attachment.id ?? null,
					size: attachment.size ?? null,
				},
			});
		}
		for (const comment of safeCommentBodies(issue)) {
			artifacts.push({
				kind: 'jira_comment',
				name: comment.id ? `Comment ${comment.id}` : null,
				externalUrl: issue.url,
				metadata: {
					provider: 'jira',
					issueKey: issue.key,
					commentId: comment.id,
				},
			});
		}
		for (const link of safeLinkRefs(issue)) {
			artifacts.push({
				kind: 'jira_link',
				name: link.type ?? link.id,
				externalUrl: null,
				metadata: {
					provider: 'jira',
					issueKey: issue.key,
					...link,
				},
			});
		}
		return artifacts;
	}

	private requireConfig() {
		const config = this.config();
		if (!config) {
			throw new JiraProviderError('jira_provider_not_configured', 'Jira execution provider is not configured.', false);
		}
		return config;
	}

	private async requestJson(config: JiraExecutionProviderConfig, path: string, input: {
		method: string;
		body?: unknown;
		code: string;
	}): Promise<Record<string, unknown>> {
		const response = await this.fetchImpl()(`${config.baseUrl}${path}`, {
			method: input.method,
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				authorization: authHeader(config),
			},
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		});
		if (!response.ok) {
			throw mapHttpError(response.status, input.code);
		}
		if (response.status === 204) return {};
		return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
	}

	private async findIssueByAssignmentLabel(config: JiraExecutionProviderConfig, label: string) {
		const jql = `project = ${config.projectKey} AND labels = "${label}"`;
		const search = new URLSearchParams({
			jql,
			fields: 'summary,status,assignee,timetracking,labels',
		});
		const payload = await this.requestJson(config, `/rest/api/3/search?${search.toString()}`, {
			method: 'GET',
			code: 'jira_search_failed',
		});
		const issue = arrayOfRecords(payload.issues).at(0);
		return issue ? normalizeIssue(config, issue) : null;
	}

	private async createIssue(config: JiraExecutionProviderConfig, input: ExecutionProviderInvocation, label: string) {
		const payload = {
			fields: {
				project: { key: config.projectKey },
				issuetype: { name: config.issueType },
				summary: input.workPackage.title,
				description: jiraDocFromWorkPackage(input),
				labels: [label, 'treeseed-assignment'],
			},
		};
		const issue = await this.requestJson(config, '/rest/api/3/issue', {
			method: 'POST',
			body: payload,
			code: 'jira_issue_create_failed',
		});
		const key = stringValue(issue.key);
		if (!key) throw new JiraProviderError('jira_payload_invalid', 'Created Jira issue did not include an issue key.', false);
		return {
			key,
			url: issueUrl(config, key),
			status: 'To Do',
		};
	}

	private async setAssignmentProperty(config: JiraExecutionProviderConfig, issueKey: string, input: ExecutionProviderInvocation) {
		await this.requestJson(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${JIRA_ASSIGNMENT_PROPERTY}`, {
			method: 'PUT',
			body: {
				assignmentId: input.assignment.id,
				capacityProviderId: input.assignment.capacityProviderId,
				executionProviderId: input.assignment.executionProviderId ?? null,
				runnerId: input.runnerId,
				mode: input.assignment.mode,
				workPackageKind: input.workPackage.kind,
				createdBy: 'treeseed',
			},
			code: 'jira_assignment_property_failed',
		});
	}

	private async fetchIssue(config: JiraExecutionProviderConfig, issueKey: string) {
		const fields = [
			'summary',
			'status',
			'assignee',
			'comment',
			'attachment',
			'issuelinks',
			'timetracking',
			'labels',
			config.storyPointsField,
		].filter(Boolean).join(',');
		const payload = await this.requestJson(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`, {
			method: 'GET',
			code: 'jira_issue_fetch_failed',
		});
		return normalizeIssue(config, payload);
	}

	private snapshotFromError(error: unknown, input: ExecutionRunRef): ExecutionRunSnapshot {
		if (error instanceof JiraProviderError) {
			return {
				status: error.code === 'jira_issue_missing' ? 'returned' : error.retryable ? 'waiting' : 'failed',
				summary: error.message,
				runId: input.runId,
				externalRef: input.externalRef,
				externalUrl: input.externalUrl,
				retryable: error.retryable,
				code: error.code,
				metadata: {
					provider: 'jira',
					status: error.status ?? null,
				},
			};
		}
		return {
			status: 'waiting',
			summary: 'Jira provider network request failed.',
			runId: input.runId,
			externalRef: input.externalRef,
			externalUrl: input.externalUrl,
			retryable: true,
			code: 'jira_network_error',
			metadata: { provider: 'jira' },
		};
	}
}
