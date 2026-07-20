import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import { createExecutionProviderAdapter } from '../../src/agents/adapters/execution.ts';
import {
	JiraExecutionProviderAdapter,
	resolveJiraExecutionProviderConfig,
	type JiraExecutionProviderConfig,
} from '../../src/agents/adapters/execution-jira.ts';
import type { ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

const config: JiraExecutionProviderConfig = {
	baseUrl: 'https://treeseed.atlassian.net',
	email: 'jira@example.test',
	apiToken: 'jira-secret-token',
	projectKey: 'TS',
	issueType: 'Task',
	doneStatuses: ['Done', 'Resolved', 'Closed'],
	blockedStatuses: ['Blocked'],
	cancelledStatuses: ['Cancelled', "Won't Do", 'Wont Do'],
	inProgressStatuses: ['In Progress'],
	storyPointsField: 'customfield_10016',
};

function agent(): AgentRuntimeSpec {
	return {
		slug: 'provider-writer',
		handler: 'writer',
		enabled: true,
		systemPrompt: 'Plan.',
		persona: 'Planner.',
		triggers: [],
		permissions: [],
		context: { graphQueries: [], contextPacks: [] },
		execution: {
			provider: 'jira',
			model: 'human',
			approvalPolicy: 'never',
			sandboxMode: 'read_only',
			reasoningEffort: 'medium',
			allowedPaths: ['docs/**'],
			forbiddenPaths: ['.env*'],
			worktree: { enabled: false },
			maxConcurrency: 1,
			timeoutSeconds: 900,
			cooldownSeconds: 30,
			leaseSeconds: 300,
			retryLimit: 3,
			branchPrefix: 'agent',
			providerProfile: {
				requiredCapabilities: ['planning'],
				preferredExecutionProviders: [],
				acceptableFallbacks: [],
				fallbackPolicy: 'fail_if_unavailable',
			},
		},
		outputs: {
			messageTypes: ['planning_result'],
			modelMutations: [],
		},
		capabilities: [],
		tags: [],
	};
}

function invocation(id = 'assignment-1'): ExecutionProviderInvocation {
	return {
		assignment: {
			id,
			teamId: 'team-1',
			projectId: 'project-1',
			capacityProviderId: 'provider-1',
			executionProviderId: 'jira',
			projectAgentClassId: 'planner',
			mode: 'planning',
			status: 'leased',
			leaseState: 'leased',
			agentId: 'provider-writer',
			capacityEnvelope: {
				teamId: 'team-1',
				projectId: 'project-1',
				capacityProviderId: 'provider-1',
				projectAgentClassId: 'planner',
				mode: 'planning',
			} as AgentCapacityEnvelope,
			decisionInput: {
				teamId: 'team-1',
				projectId: 'project-1',
				projectAgentClassId: 'planner',
				mode: 'planning',
				agentId: 'provider-writer',
				input: { objective: 'Plan human review.' },
			} as DecisionExecutionInput,
			capabilityHandles: {
				repositoryAccess: [{ token: 'ghs_secret_should_not_leak' }],
			} as any,
			workspaceContext: {
				secretValue: 'secret_should_not_leak',
			} as any,
		} as ProviderAssignment,
		capacityEnvelope: {
			teamId: 'team-1',
			projectId: 'project-1',
			capacityProviderId: 'provider-1',
			projectAgentClassId: 'planner',
			mode: 'planning',
		} as AgentCapacityEnvelope,
		decisionInput: {
			teamId: 'team-1',
			projectId: 'project-1',
			projectAgentClassId: 'planner',
			mode: 'planning',
			agentId: 'provider-writer',
			input: { objective: 'Plan human review.' },
		} as DecisionExecutionInput,
		agent: agent(),
		workPackage: {
			kind: 'planning',
			title: 'Plan human review',
			summary: 'Coordinate human review work.',
			instructions: 'Review the proposed work and provide evidence.',
			context: { requestId: 'req-1' },
			expectedOutputs: [{ type: 'review_evidence', required: true }],
			constraints: {
				mode: 'planning',
				requiredCapabilities: ['human_review'],
				allowedPaths: ['docs/**'],
				forbiddenPaths: ['.env*'],
			},
		},
		leaseToken: 'lease-1',
		runnerId: 'runner-1',
		metadata: { runId: id },
	};
}

function issue(key: string, status: string, extraFields: Record<string, unknown> = {}) {
	return {
		key,
		fields: {
			summary: `${key} summary`,
			status: {
				name: status,
				statusCategory: { name: status === 'Done' ? 'Done' : 'In Progress' },
			},
			assignee: { displayName: 'Ada Lovelace' },
			timetracking: { timeSpentSeconds: 7200 },
			comment: { comments: [{ id: 'comment-1', body: { content: [] } }] },
			attachment: [{ id: 'att-1', filename: 'evidence.txt', mimeType: 'text/plain', size: 12, content: 'https://treeseed.atlassian.net/attachment/att-1' }],
			issuelinks: [{ id: 'link-1', type: { name: 'Relates' }, outwardIssue: { key: 'PR-1' } }],
			labels: ['treeseed-assignment-assignment-1'],
			customfield_10016: 5,
			...extraFields,
		},
	};
}

function response(body: unknown, init: ResponseInit = {}) {
	return new Response(body === undefined ? undefined : JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json' },
	});
}

function createMockJiraFetch(handler: (request: {
	url: URL;
	method: string;
	body: unknown;
	headers: Headers;
}) => Response | Promise<Response>) {
	const requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
		requests.push({
			method: init?.method ?? 'GET',
			url: url.toString(),
			body,
			headers: Object.fromEntries(headers.entries()),
		});
		return handler({ url, method: init?.method ?? 'GET', body, headers });
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function jsonWithoutAuth(value: unknown) {
	return JSON.stringify(value);
}

describe('JiraExecutionProviderAdapter', () => {
	it('describes Jira as an async human issue queue provider', async () => {
		const missing = new JiraExecutionProviderAdapter({ config: null });
		const configured = new JiraExecutionProviderAdapter({ config });

		const descriptor = await configured.describe();
		expect(descriptor).toMatchObject({
			kind: 'human_issue_queue',
			supportsAsync: true,
			supportsCancel: true,
			supportsUsage: true,
			supportsArtifacts: true,
		});
		expect(descriptor.capabilities).toEqual(expect.arrayContaining(['human_review', 'qa_validation', 'issue_queue']));
		expect(await missing.observe({})).toMatchObject({ available: false, pressure: 'exhausted' });
		expect(await configured.observe({})).toMatchObject({
			available: true,
			metadata: {
				projectKey: 'TS',
				baseUrl: 'https://treeseed.atlassian.net',
				configured: true,
			},
		});
		expect(jsonWithoutAuth(await configured.observe({}))).not.toContain(config.apiToken);
	});

	it('creates a Jira issue from an agent work package with assignment idempotency metadata', async () => {
		const { fetchImpl, requests } = createMockJiraFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/rest/api/3/search') return response({ issues: [] });
			if (method === 'POST' && url.pathname === '/rest/api/3/issue') return response({ key: 'TS-1' });
			if (method === 'PUT' && url.pathname === '/rest/api/3/issue/TS-1/properties/treeseedAssignment') return response(undefined, { status: 204 });
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new JiraExecutionProviderAdapter({ config, fetchImpl });

		const snapshot = await adapter.start(invocation());

		expect(snapshot).toMatchObject({
			status: 'waiting',
			externalRef: 'TS-1',
			externalUrl: 'https://treeseed.atlassian.net/browse/TS-1',
			metadata: {
				provider: 'jira',
				reused: false,
			},
		});
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
			'GET /rest/api/3/search',
			'POST /rest/api/3/issue',
			'PUT /rest/api/3/issue/TS-1/properties/treeseedAssignment',
		]);
		expect(requests[1]?.body).toMatchObject({
			fields: {
				project: { key: 'TS' },
				issuetype: { name: 'Task' },
				summary: 'Plan human review',
				labels: ['treeseed-assignment-assignment-1', 'treeseed-assignment'],
			},
		});
		expect(JSON.stringify(requests[1]?.body)).toContain('Review the proposed work');
		expect(JSON.stringify(requests[1]?.body)).not.toContain('ghs_secret_should_not_leak');
		expect(JSON.stringify(requests[2]?.body)).toContain('assignment-1');
		expect(jsonWithoutAuth({ snapshot, requests: requests.map(({ headers, ...rest }) => rest) })).not.toContain(config.apiToken);
	});

	it('reuses an existing Jira issue for duplicate assignment starts', async () => {
		const { fetchImpl, requests } = createMockJiraFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/rest/api/3/search') return response({ issues: [issue('TS-2', 'To Do')] });
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new JiraExecutionProviderAdapter({ config, fetchImpl });

		const snapshot = await adapter.start(invocation());

		expect(snapshot).toMatchObject({
			status: 'waiting',
			externalRef: 'TS-2',
			metadata: { reused: true },
		});
		expect(requests.map((entry) => entry.method)).toEqual(['GET']);
	});

	it('maps Jira statuses to normalized execution statuses', async () => {
		const cases = [
			['To Do', 'waiting', undefined],
			['In Progress', 'running', undefined],
			['Blocked', 'blocked', 'jira_issue_blocked'],
			['Done', 'completed', undefined],
			['Cancelled', 'failed', 'jira_issue_cancelled'],
			['Needs Triage', 'waiting', 'jira_status_unmapped'],
		] as const;
		for (const [jiraStatus, expectedStatus, expectedCode] of cases) {
			const { fetchImpl } = createMockJiraFetch(() => response(issue('TS-3', jiraStatus)));
			const adapter = new JiraExecutionProviderAdapter({ config, fetchImpl });
			const snapshot = await adapter.poll({ assignmentId: 'assignment-1', runId: 'TS-3', externalRef: 'TS-3' });
			expect(snapshot.status).toBe(expectedStatus);
			expect(snapshot.code).toBe(expectedCode);
			if (jiraStatus === 'Blocked') expect(snapshot.retryable).toBe(true);
			if (jiraStatus === 'Cancelled') expect(snapshot.retryable).toBe(false);
		}
	});

	it('collects Jira time tracking, story points, issue links, comments, and attachments as normalized usage and artifacts', async () => {
		const { fetchImpl } = createMockJiraFetch(() => response(issue('TS-4', 'Done')));
		const adapter = new JiraExecutionProviderAdapter({ config, fetchImpl });

		const usage = await adapter.collectUsage({ assignmentId: 'assignment-1', runId: 'TS-4', externalRef: 'TS-4' });
		const artifacts = await adapter.collectArtifacts({ assignmentId: 'assignment-1', runId: 'TS-4', externalRef: 'TS-4' });

		expect(usage).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'jira_time_spent', unit: 'second', amount: 7200 }),
			expect.objectContaining({ kind: 'jira_story_points', unit: 'story_point', amount: 5 }),
		]));
		expect(artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'external_issue', name: 'TS-4' }),
			expect.objectContaining({ kind: 'jira_attachment', name: 'evidence.txt' }),
			expect.objectContaining({ kind: 'jira_comment' }),
			expect.objectContaining({ kind: 'jira_link' }),
		]));
		expect(jsonWithoutAuth({ usage, artifacts })).not.toContain(config.apiToken);
	});

	it('cancels Jira issues through transitions when available and comments with the cancellation reason', async () => {
		const { fetchImpl, requests } = createMockJiraFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/rest/api/3/issue/TS-5/transitions') {
				return response({ transitions: [{ id: '31', name: 'Cancel', to: { name: 'Cancelled' } }] });
			}
			if (method === 'POST' && url.pathname === '/rest/api/3/issue/TS-5/transitions') return response({});
			if (method === 'POST' && url.pathname === '/rest/api/3/issue/TS-5/comment') return response({ id: 'comment-2' });
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new JiraExecutionProviderAdapter({ config, fetchImpl });

		const snapshot = await adapter.cancel({ assignmentId: 'assignment-1', runId: 'TS-5', externalRef: 'TS-5', reason: 'No longer needed.' });

		expect(snapshot).toMatchObject({
			status: 'cancelled',
			externalRef: 'TS-5',
			metadata: { transitionApplied: true },
		});
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
			'GET /rest/api/3/issue/TS-5/transitions',
			'POST /rest/api/3/issue/TS-5/transitions',
			'POST /rest/api/3/issue/TS-5/comment',
		]);
		expect(jsonWithoutAuth({ snapshot, requests: requests.map(({ headers, ...rest }) => rest) })).not.toContain(config.apiToken);
	});

	it('maps Jira auth and provider errors without leaking credentials', async () => {
		const authAdapter = new JiraExecutionProviderAdapter({
			config,
			fetchImpl: createMockJiraFetch(() => response({ message: config.apiToken }, { status: 401 })).fetchImpl,
		});
		await expect(authAdapter.start(invocation())).rejects.toMatchObject({
			code: 'jira_auth_failed',
			retryable: false,
		});
		await expect(authAdapter.start(invocation())).rejects.not.toThrow(config.apiToken);

		const providerUnavailable = new JiraExecutionProviderAdapter({
			config,
			fetchImpl: createMockJiraFetch(() => response({}, { status: 429 })).fetchImpl,
		});
		expect(await providerUnavailable.poll({ assignmentId: 'assignment-1', runId: 'TS-6', externalRef: 'TS-6' })).toMatchObject({
			status: 'waiting',
			code: 'jira_provider_unavailable',
			retryable: true,
		});

		const missing = new JiraExecutionProviderAdapter({
			config,
			fetchImpl: createMockJiraFetch(() => response({}, { status: 404 })).fetchImpl,
		});
		expect(await missing.poll({ assignmentId: 'assignment-1', runId: 'TS-7', externalRef: 'TS-7' })).toMatchObject({
			status: 'returned',
			code: 'jira_issue_missing',
			retryable: true,
		});

		const malformed = new JiraExecutionProviderAdapter({
			config,
			fetchImpl: createMockJiraFetch(() => response({ fields: {} })).fetchImpl,
		});
		expect(await malformed.poll({ assignmentId: 'assignment-1', runId: 'TS-8', externalRef: 'TS-8' })).toMatchObject({
			status: 'failed',
			code: 'jira_payload_invalid',
			retryable: false,
		});
	});

	it('registers Jira execution provider aliases in the built-in adapter factory', () => {
		expect(createExecutionProviderAdapter('jira')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('jira_issue_queue')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('human_issue_queue')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(() => createExecutionProviderAdapter('manual')).toThrow(/Unsupported execution provider "manual"/);
	});

	it('resolves Jira config from provider-local environment variables', () => {
		const resolved = resolveJiraExecutionProviderConfig({
			TREESEED_JIRA_BASE_URL: 'https://treeseed.atlassian.net/',
			TREESEED_JIRA_EMAIL: 'jira@example.test',
			TREESEED_JIRA_API_TOKEN: config.apiToken,
			TREESEED_JIRA_PROJECT_KEY: 'TS',
			TREESEED_JIRA_DONE_STATUSES: 'Done,Closed',
		} as NodeJS.ProcessEnv);
		expect(resolved).toMatchObject({
			baseUrl: 'https://treeseed.atlassian.net',
			projectKey: 'TS',
			doneStatuses: ['Done', 'Closed'],
		});
		expect(resolveJiraExecutionProviderConfig({} as NodeJS.ProcessEnv)).toBeNull();
	});
});
