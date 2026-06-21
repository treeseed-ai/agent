import type {
	ExecutionArtifactRef,
	ExecutionProviderDescriptor,
	ExecutionProviderObserveInput,
	ExecutionProviderObservation,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation, TreeDxProxyExecutionToolDescriptor } from '../runtime-types.ts';

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

const DEFAULT_LABELS = ['treeseed'];
const DEFAULT_IN_PROGRESS_LABELS = ['treeseed-in-progress'];
const DEFAULT_BLOCKED_LABELS = ['treeseed-blocked'];
const DEFAULT_CANCELLED_LABELS = ['treeseed-cancelled'];

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

function parseList(value: string, fallback: string[]) {
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

function descriptor(): ExecutionProviderDescriptor {
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

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

function sanitizeLabel(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120) || 'assignment';
}

function assignmentLabel(assignmentId: string) {
	return `treeseed-assignment-${sanitizeLabel(assignmentId)}`;
}

function repositoryParts(repository: string) {
	const [owner, repo] = repository.split('/');
	if (!owner || !repo || repository.split('/').length !== 2) {
		throw new GitHubIssuesProviderError('github_issues_repository_invalid', 'GitHub Issues provider repository must be in owner/repo form.', false);
	}
	return { owner, repo };
}

function issueUrl(config: GitHubIssuesExecutionProviderConfig, issueNumber: number) {
	return `https://github.com/${config.repository}/issues/${issueNumber}`;
}

function redactSensitive(value: unknown, key = ''): unknown {
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

function fieldSummary(value: unknown) {
	try {
		return JSON.stringify(redactSensitive(value), null, 2);
	} catch {
		return String(value ?? '<unavailable>');
	}
}

function treeDxToolInstructions(input: ExecutionProviderInvocation) {
	const tools = (input.tools ?? []).filter((tool): tool is TreeDxProxyExecutionToolDescriptor => tool.kind === 'treedx_proxy');
	if (tools.length === 0) return null;
	return [
		'## TreeDX assignment tools',
		'Use TreeDX workspace operations for content changes. Local repository patches are only for code, verification artifacts, temporary worktrees, package files, and non-content artifacts.',
		'Do not request or paste raw credentials in GitHub. The API routes require the provider runtime to supply these header values outside GitHub:',
		'- Authorization: Bearer <capacity-provider-api-key>',
		'- x-treeseed-assignment-id',
		'- x-treeseed-treedx-proxy-handle-id',
		'',
		'Available tools:',
		tools.map((tool) => [
			`### ${tool.name}`,
			`Handle id: ${tool.handleId}`,
			`Repository id: ${tool.repositoryId ?? '<assignment default>'}`,
			`Workspace id: ${tool.workspaceId ?? '<assignment default>'}`,
			`Allowed operations: ${tool.allowedOperations.join(', ') || '<none>'}`,
			`Allowed paths:\n${tool.allowedPaths.join('\n') || '<none>'}`,
			`Routes:\n\`\`\`json\n${fieldSummary(tool.routes)}\n\`\`\``,
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

function issueBodyFromWorkPackage(input: ExecutionProviderInvocation) {
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
		treeDxToolInstructions(input),
		'<!-- treeseed:assignment -->',
	].filter(Boolean).join('\n\n');
}

function authHeaders(config: GitHubIssuesExecutionProviderConfig) {
	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${config.token}`,
		'content-type': 'application/json',
		'user-agent': 'treeseed-agent-provider',
		'x-github-api-version': '2022-11-28',
	};
}

function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'GitHub Issues authentication failed.';
	if (status === 404) return 'GitHub issue was not found.';
	if (status === 410) return 'GitHub Issues are disabled for the repository.';
	if (status === 429 || status >= 500) return 'GitHub Issues provider is temporarily unavailable.';
	return `GitHub Issues request failed with status ${status} (${code}).`;
}

function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new GitHubIssuesProviderError('github_issues_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new GitHubIssuesProviderError('github_issue_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 410) return new GitHubIssuesProviderError('github_issues_disabled', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 429 || status >= 500) return new GitHubIssuesProviderError('github_issues_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new GitHubIssuesProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

function normalizeLabels(value: unknown) {
	return Array.isArray(value)
		? value.map((entry) => typeof entry === 'string' ? entry : stringValue(record(entry).name)).filter((entry): entry is string => Boolean(entry))
		: [];
}

function normalizeIssue(config: GitHubIssuesExecutionProviderConfig, value: unknown): GitHubIssueSnapshot {
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

function hasAnyLabel(issue: GitHubIssueSnapshot, labels: string[]) {
	const issueLabels = new Set(issue.labels.map((label) => label.toLowerCase()));
	return labels.some((label) => issueLabels.has(label.toLowerCase()));
}

function issueSnapshot(config: GitHubIssuesExecutionProviderConfig, issue: GitHubIssueSnapshot): ExecutionRunSnapshot {
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

function commentArtifacts(issue: GitHubIssueSnapshot): ExecutionArtifactRef[] {
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

function linkedRefsFromText(text: string | null | undefined) {
	if (!text) return [];
	const refs = new Set<string>();
	const pattern = /(?:^|\s)(?:#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)/gu;
	for (const match of text.matchAll(pattern)) {
		refs.add(match[0].trim());
	}
	return [...refs];
}

export class GitHubIssueExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: GitHubIssuesExecutionProviderAdapterOptions = {}) {}

	private config() {
		return this.options.config === undefined ? resolveGitHubIssuesExecutionProviderConfig() : this.options.config;
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
				blockedReason: 'GitHub Issues execution provider is not configured.',
				metadata: { configured: false },
			};
		}
		return {
			descriptor: provider,
			available: true,
			pressure: 'normal',
			activeAssignmentCount: 0,
			metadata: {
				repository: config.repository,
				configured: true,
			},
		};
	}

	async prepare() {
		const config = this.config();
		if (!config) {
			return {
				accepted: false,
				summary: 'GitHub Issues execution provider is not configured.',
				retryable: false,
				code: 'github_issues_provider_not_configured',
			};
		}
		return {
			accepted: true,
			summary: `GitHub Issues execution provider is configured for ${config.repository}.`,
			metadata: { repository: config.repository },
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const label = assignmentLabel(input.assignment.id);
		const existing = await this.findIssueByAssignmentLabel(config, label);
		if (existing) {
			return {
				...issueSnapshot(config, existing),
				status: issueSnapshot(config, existing).status === 'completed' ? 'completed' : 'waiting',
				summary: `GitHub issue #${existing.number} is waiting for human execution.`,
				metadata: {
					provider: 'github_issues',
					repository: config.repository,
					assignmentId: input.assignment.id,
					issueNumber: existing.number,
					reused: true,
				},
			};
		}
		const created = await this.createIssue(config, input, label);
		return {
			status: 'waiting',
			summary: `GitHub issue #${created.number} is waiting for human execution.`,
			runId: String(created.number),
			externalRef: String(created.number),
			externalUrl: created.htmlUrl,
			outputs: {
				issueNumber: created.number,
				issueUrl: created.htmlUrl,
				repository: config.repository,
				labels: created.labels,
			},
			metadata: {
				provider: 'github_issues',
				repository: config.repository,
				assignmentId: input.assignment.id,
				issueNumber: created.number,
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

	resume(input: ExecutionRunRef) {
		return this.poll(input);
	}

	async cancel(input: ExecutionRunRef & { reason: string }): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const issueNumber = input.externalRef ?? input.runId;
		await this.requestJson(config, `/issues/${encodeURIComponent(issueNumber)}/comments`, {
			method: 'POST',
			body: { body: `Treeseed cancelled this assignment: ${input.reason}` },
			code: 'github_issue_cancel_comment_failed',
		}).catch(() => null);
		await this.requestJson(config, `/issues/${encodeURIComponent(issueNumber)}`, {
			method: 'PATCH',
			body: { state: 'closed', labels: [...new Set([...config.labels, ...config.cancelledLabels])] },
			code: 'github_issue_cancel_failed',
		});
		return {
			status: 'cancelled',
			summary: `GitHub issue #${issueNumber} was cancelled for Treeseed assignment execution.`,
			runId: input.runId,
			externalRef: issueNumber,
			externalUrl: issueUrl(config, Number(issueNumber)),
			code: 'github_issue_cancelled',
			retryable: false,
			metadata: {
				provider: 'github_issues',
				repository: config.repository,
				issueNumber,
			},
		};
	}

	async collectUsage(input: ExecutionRunRef): Promise<ExecutionUsageActual[]> {
		const config = this.requireConfig();
		const issue = await this.fetchIssue(config, input.externalRef ?? input.runId);
		const usage: ExecutionUsageActual[] = [];
		if (issue.comments && issue.comments.length > 0) {
			usage.push({ kind: 'github_issue_comments', unit: 'count', amount: issue.comments.length, source: 'github_issues', partial: true });
		}
		if (issue.labels.length > 0) {
			usage.push({ kind: 'github_issue_labels', unit: 'count', amount: issue.labels.length, source: 'github_issues', partial: true });
		}
		return usage;
	}

	async collectArtifacts(input: ExecutionRunRef): Promise<ExecutionArtifactRef[]> {
		const config = this.requireConfig();
		const issue = await this.fetchIssue(config, input.externalRef ?? input.runId);
		const artifacts: ExecutionArtifactRef[] = [{
			kind: 'external_issue',
			name: `#${issue.number}`,
			externalUrl: issue.htmlUrl,
			metadata: {
				provider: 'github_issues',
				repository: config.repository,
				state: issue.state,
				labels: issue.labels,
			},
		}];
		artifacts.push(...commentArtifacts(issue));
		for (const ref of linkedRefsFromText([issue.body, ...(issue.comments ?? []).map((comment) => stringValue(comment.body))].filter(Boolean).join('\n'))) {
			artifacts.push({
				kind: 'github_issue_link',
				name: ref,
				externalUrl: ref.startsWith('http') ? ref : issue.htmlUrl,
				metadata: {
					provider: 'github_issues',
					repository: config.repository,
					issueNumber: issue.number,
				},
			});
		}
		return artifacts;
	}

	private requireConfig() {
		const config = this.config();
		if (!config) throw new GitHubIssuesProviderError('github_issues_provider_not_configured', 'GitHub Issues execution provider is not configured.', false);
		repositoryParts(config.repository);
		return config;
	}

	private async requestJson(config: GitHubIssuesExecutionProviderConfig, path: string, input: {
		method: string;
		body?: unknown;
		code: string;
	}): Promise<Record<string, unknown>> {
		const { owner, repo } = repositoryParts(config.repository);
		const response = await this.fetchImpl()(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
			method: input.method,
			headers: authHeaders(config),
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		});
		if (!response.ok) throw mapHttpError(response.status, input.code);
		if (response.status === 204) return {};
		return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
	}

	private async findIssueByAssignmentLabel(config: GitHubIssuesExecutionProviderConfig, label: string) {
		const search = new URLSearchParams({
			state: 'all',
			labels: label,
			per_page: '100',
		});
		const payload = await this.requestJson(config, `/issues?${search.toString()}`, {
			method: 'GET',
			code: 'github_issues_search_failed',
		}) as unknown;
		const issue = Array.isArray(payload) ? payload.map(record).find((candidate) => !candidate.pull_request) : null;
		return issue ? normalizeIssue(config, issue) : null;
	}

	private async createIssue(config: GitHubIssuesExecutionProviderConfig, input: ExecutionProviderInvocation, label: string) {
		const payload = await this.requestJson(config, '/issues', {
			method: 'POST',
			body: {
				title: input.workPackage.title,
				body: issueBodyFromWorkPackage(input),
				labels: [...new Set([...config.labels, label, 'treeseed-assignment'])],
			},
			code: 'github_issue_create_failed',
		});
		return normalizeIssue(config, payload);
	}

	private async fetchIssue(config: GitHubIssuesExecutionProviderConfig, issueNumber: string | number) {
		const issue = normalizeIssue(config, await this.requestJson(config, `/issues/${encodeURIComponent(String(issueNumber))}`, {
			method: 'GET',
			code: 'github_issue_fetch_failed',
		}));
		const commentsPayload = await this.requestJson(config, `/issues/${encodeURIComponent(String(issueNumber))}/comments?per_page=100`, {
			method: 'GET',
			code: 'github_issue_comments_fetch_failed',
		}).catch(() => []);
		return {
			...issue,
			comments: Array.isArray(commentsPayload) ? commentsPayload.map(record) : [],
		};
	}

	private snapshotFromError(error: unknown, input: ExecutionRunRef): ExecutionRunSnapshot {
		if (error instanceof GitHubIssuesProviderError) {
			const returned = error.code === 'github_issue_missing';
			return {
				status: returned ? 'returned' : error.retryable ? 'waiting' : 'failed',
				summary: error.message,
				runId: input.runId,
				externalRef: input.externalRef,
				externalUrl: input.externalUrl,
				retryable: error.retryable,
				code: error.code,
				metadata: { provider: 'github_issues', status: error.status },
			};
		}
		return {
			status: 'failed',
			summary: 'GitHub Issues provider failed with an unexpected error.',
			runId: input.runId,
			externalRef: input.externalRef,
			externalUrl: input.externalUrl,
			retryable: false,
			code: 'github_issues_unexpected_error',
			metadata: { provider: 'github_issues' },
		};
	}
}
