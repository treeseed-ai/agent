import type { ExecutionArtifactRef, ExecutionProviderObservation, ExecutionProviderObserveInput, ExecutionRunRef, ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../runtime/runtime-types.ts';
import { JIRA_ASSIGNMENT_PROPERTY, JiraExecutionProviderAdapterOptions, JiraExecutionProviderConfig, JiraProviderError, arrayOfRecords, assignmentLabel, authHeader, descriptor, issueSnapshot, issueUrl, jiraDocFromWorkPackage, mapHttpError, normalizeIssue, record, resolveJiraExecutionProviderConfig, safeAttachmentRefs, safeCommentBodies, safeLinkRefs, stringValue, textDoc } from '../integrations/execution-jira.ts';

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
