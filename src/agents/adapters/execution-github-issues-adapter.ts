import type { ExecutionArtifactRef, ExecutionProviderObservation, ExecutionProviderObserveInput, ExecutionRunRef, ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';
import { GitHubIssuesExecutionProviderAdapterOptions, GitHubIssuesExecutionProviderConfig, GitHubIssuesProviderError, assignmentLabel, authHeaders, commentArtifacts, descriptor, issueBodyFromWorkPackage, issueSnapshot, issueUrl, linkedRefsFromText, mapHttpError, normalizeIssue, record, repositoryParts, resolveGitHubIssuesExecutionProviderConfig, stringValue } from './execution-github-issues.ts';

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
