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

export interface GitHubIssuesExecutionProviderConfig {
	token: string;
	repository: string;
	labels: string[];
	inProgressLabels: string[];
	blockedLabels: string[];
	cancelledLabels: string[];
}

export interface GitHubIssueSnapshot {
	number: number;
	id?: number | null;
	state: string;
	title?: string | null;
	body?: string | null;
	htmlUrl: string;
	labels: string[];
	assignee?: string | null;
	comments?: Array<Record<string, unknown>>;
	createdAt?: string | null;
	updatedAt?: string | null;
	closedAt?: string | null;
}

export interface GitHubIssuesExecutionProviderAdapterOptions {
	config?: GitHubIssuesExecutionProviderConfig | null;
	fetchImpl?: typeof fetch;
}

export class GitHubIssuesProviderError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = true,
		readonly status?: number,
	) {
		super(message);
		this.name = 'GitHubIssuesProviderError';
	}
}

export const DEFAULT_LABELS = ['treeseed'];
export const DEFAULT_IN_PROGRESS_LABELS = ['treeseed-in-progress'];
export const DEFAULT_BLOCKED_LABELS = ['treeseed-blocked'];
export const DEFAULT_CANCELLED_LABELS = ['treeseed-cancelled'];

export function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

export function parseList(value: string, fallback: string[]) {
	const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
	return values.length ? values : fallback;
}

export function resolveGitHubIssuesExecutionProviderConfig(env: NodeJS.ProcessEnv = process.env): GitHubIssuesExecutionProviderConfig | null {
	const token = envValue(env, 'TREESEED_GITHUB_ISSUES_TOKEN');
	const repository = envValue(env, 'TREESEED_GITHUB_ISSUES_REPOSITORY');
	if (!token || !repository) return null;
	return {
		token,
		repository,
		labels: parseList(envValue(env, 'TREESEED_GITHUB_ISSUES_LABELS'), DEFAULT_LABELS),
		inProgressLabels: parseList(envValue(env, 'TREESEED_GITHUB_ISSUES_IN_PROGRESS_LABELS'), DEFAULT_IN_PROGRESS_LABELS),
		blockedLabels: parseList(envValue(env, 'TREESEED_GITHUB_ISSUES_BLOCKED_LABELS'), DEFAULT_BLOCKED_LABELS),
		cancelledLabels: parseList(envValue(env, 'TREESEED_GITHUB_ISSUES_CANCELLED_LABELS'), DEFAULT_CANCELLED_LABELS),
	};
}

export function descriptor(): ExecutionProviderDescriptor {
	return {
		id: 'github_issues',
		kind: 'human_issue_queue',
		capabilities: [
			'human_review',
			'manual_execution',
			'qa_validation',
			'project_management',
			'issue_queue',
			'github_issue_queue',
			'planning',
			'implementation',
			'review',
			'test',
		],
		capabilityAliases: ['github_issues', 'github_issue_queue', 'issue_queue'],
		nativeUnit: 'issue_activity',
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
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

export function sanitizeLabel(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120) || 'assignment';
}

export function assignmentLabel(assignmentId: string) {
	return `treeseed-assignment-${sanitizeLabel(assignmentId)}`;
}

export function repositoryParts(repository: string) {
	const [owner, repo] = repository.split('/');
	if (!owner || !repo || repository.split('/').length !== 2) {
		throw new GitHubIssuesProviderError('github_issues_repository_invalid', 'GitHub Issues provider repository must be in owner/repo form.', false);
	}
	return { owner, repo };
}

export function issueUrl(config: GitHubIssuesExecutionProviderConfig, issueNumber: number) {
	return `https://github.com/${config.repository}/issues/${issueNumber}`;
}

export function redactSensitive(value: unknown, key = ''): unknown {
	if (key && /(?:token|authorization|password|credential|api[_-]?key|private[_-]?key)/iu.test(key)) return '<redacted>';
	if (typeof value === 'string') {
		if (/(?:gh[psuor]_[A-Za-z0-9_]+|secret_should_not_leak|github_secret)/u.test(value)) return '<redacted>';
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
			entryKey,
			redactSensitive(entryValue, entryKey),
		]));
	}
	return value;
}

export function fieldSummary(value: unknown) {
	try {
		return JSON.stringify(redactSensitive(value), null, 2);
	} catch {
		return String(value ?? '<unavailable>');
	}
}

export function agentToolInstructions(input: ExecutionProviderInvocation) {
	const tools = (input.tools ?? []).filter((tool) => tool.kind === 'agent_tool');
	if (tools.length === 0) return null;
	return [
		'## Available TreeSeed tools',
		'Use only these assignment-scoped tools when tool use is needed. Do not request or paste raw credentials in GitHub.',
		'',
		'Available tools:',
		tools.map((tool) => [
			`### ${tool.name}`,
			`Tool id: ${tool.id}`,
			`Execution target: ${tool.executionTarget}`,
			`Mutability: ${tool.mutability}`,
			`Input schema:\n\`\`\`json\n${fieldSummary(tool.inputSchema)}\n\`\`\``,
		].join('\n\n')).join('\n\n'),
		'Expected completion artifact format:',
		'```json',
		fieldSummary({
			treeDxWorkspaceId: '<workspace-id>',
			treeDxCommitId: '<commit-id-or-result>',
			changedPaths: ['<path>'],
			summary: '<summary>',
			verificationEvidence: '<readback or verification summary>',
		}),
		'```',
	].join('\n\n');
}

export function issueBodyFromWorkPackage(input: ExecutionProviderInvocation) {
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
	return [
		`## Summary\n${input.workPackage.summary}`,
		`## Instructions\n${input.workPackage.instructions}`,
		`## Expected outputs\n\`\`\`json\n${fieldSummary(input.workPackage.expectedOutputs)}\n\`\`\``,
		`## Constraints\n\`\`\`json\n${fieldSummary(input.workPackage.constraints)}\n\`\`\``,
		`## Assignment\n\`\`\`json\n${fieldSummary(safeAssignment)}\n\`\`\``,
		`## Capacity envelope\n\`\`\`json\n${fieldSummary(input.capacityEnvelope)}\n\`\`\``,
		`## Decision input\n\`\`\`json\n${fieldSummary(input.decisionInput.input)}\n\`\`\``,
		`## Allowed paths\n${(input.workPackage.constraints.allowedPaths ?? input.agent.execution.allowedPaths ?? []).join('\n') || '<none>'}`,
		`## Forbidden paths\n${(input.workPackage.constraints.forbiddenPaths ?? input.agent.execution.forbiddenPaths ?? []).join('\n') || '<none>'}`,
		agentToolInstructions(input),
		'<!-- treeseed:assignment -->',
	].filter(Boolean).join('\n\n');
}

export function authHeaders(config: GitHubIssuesExecutionProviderConfig) {
	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${config.token}`,
		'content-type': 'application/json',
		'user-agent': 'treeseed-agent-provider',
		'x-github-api-version': '2022-11-28',
	};
}

export function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'GitHub Issues authentication failed.';
	if (status === 404) return 'GitHub issue was not found.';
	if (status === 410) return 'GitHub Issues are disabled for the repository.';
	if (status === 429 || status >= 500) return 'GitHub Issues provider is temporarily unavailable.';
	return `GitHub Issues request failed with status ${status} (${code}).`;
}

export function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new GitHubIssuesProviderError('github_issues_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new GitHubIssuesProviderError('github_issue_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 410) return new GitHubIssuesProviderError('github_issues_disabled', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 429 || status >= 500) return new GitHubIssuesProviderError('github_issues_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new GitHubIssuesProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

export function normalizeLabels(value: unknown) {
	return Array.isArray(value)
		? value.map((entry) => typeof entry === 'string' ? entry : stringValue(record(entry).name)).filter((entry): entry is string => Boolean(entry))
		: [];
}

export function normalizeIssue(config: GitHubIssuesExecutionProviderConfig, value: unknown): GitHubIssueSnapshot {
	const issue = record(value);
	const number = typeof issue.number === 'number' ? issue.number : Number.NaN;
	if (!Number.isFinite(number)) {
		throw new GitHubIssuesProviderError('github_issues_payload_invalid', 'GitHub issue payload did not include an issue number.', false);
	}
	const assignee = record(issue.assignee);
	return {
		number,
		id: typeof issue.id === 'number' ? issue.id : null,
		state: stringValue(issue.state) ?? 'open',
		title: stringValue(issue.title),
		body: stringValue(issue.body),
		htmlUrl: stringValue(issue.html_url, issue.htmlUrl) ?? issueUrl(config, number),
		labels: normalizeLabels(issue.labels),
		assignee: stringValue(assignee.login, assignee.name),
		comments: arrayOfRecords(issue.comments),
		createdAt: stringValue(issue.created_at, issue.createdAt),
		updatedAt: stringValue(issue.updated_at, issue.updatedAt),
		closedAt: stringValue(issue.closed_at, issue.closedAt),
	};
}

export function hasAnyLabel(issue: GitHubIssueSnapshot, labels: string[]) {
	const issueLabels = new Set(issue.labels.map((label) => label.toLowerCase()));
	return labels.some((label) => issueLabels.has(label.toLowerCase()));
}

export function issueSnapshot(config: GitHubIssuesExecutionProviderConfig, issue: GitHubIssueSnapshot): ExecutionRunSnapshot {
	let status: ExecutionRunSnapshot['status'] = 'waiting';
	let retryable: boolean | undefined;
	let code: string | undefined;
	if (hasAnyLabel(issue, config.cancelledLabels)) {
		status = 'failed';
		retryable = false;
		code = 'github_issue_cancelled';
	} else if (hasAnyLabel(issue, config.blockedLabels)) {
		status = 'blocked';
		retryable = true;
		code = 'github_issue_blocked';
	} else if (issue.state === 'closed') {
		status = 'completed';
	} else if (hasAnyLabel(issue, config.inProgressLabels)) {
		status = 'running';
	}
	return {
		status,
		summary: status === 'completed'
			? `GitHub issue #${issue.number} is complete.`
			: `GitHub issue #${issue.number} is ${status}.`,
		runId: String(issue.number),
		externalRef: String(issue.number),
		externalUrl: issue.htmlUrl,
		outputs: {
			issueNumber: issue.number,
			issueUrl: issue.htmlUrl,
			githubState: issue.state,
			labels: issue.labels,
			assignee: issue.assignee ?? null,
			commentCount: issue.comments?.length ?? null,
			blockerReason: status === 'blocked' ? issue.title ?? 'GitHub issue blocked.' : null,
			completionSummary: status === 'completed' ? issue.title ?? `GitHub issue #${issue.number} completed.` : null,
		},
		retryable,
		code,
		metadata: {
			provider: 'github_issues',
			repository: config.repository,
			issueNumber: issue.number,
			labels: issue.labels,
		},
	};
}

export function commentArtifacts(issue: GitHubIssueSnapshot): ExecutionArtifactRef[] {
	return (issue.comments ?? []).map((comment, index) => ({
		kind: 'github_issue_comment',
		name: `Comment ${stringValue(comment.id) ?? index + 1}`,
		externalUrl: stringValue(comment.html_url, comment.htmlUrl) ?? issue.htmlUrl,
		metadata: {
			provider: 'github_issues',
			issueNumber: issue.number,
			commentId: stringValue(comment.id),
			author: stringValue(record(comment.user).login),
			createdAt: stringValue(comment.created_at),
			updatedAt: stringValue(comment.updated_at),
		},
	}));
}

export function linkedRefsFromText(text: string | null | undefined) {
	if (!text) return [];
	const refs = new Set<string>();
	const pattern = /(?:^|\s)(?:#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)/gu;
	for (const match of text.matchAll(pattern)) {
		refs.add(match[0].trim());
	}
	return [...refs];
}

export { GitHubIssueExecutionProviderAdapter } from './execution-github-issues-adapter.ts';

