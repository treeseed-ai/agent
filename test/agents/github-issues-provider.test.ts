import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import {
	GitHubIssueExecutionProviderAdapter,
	resolveGitHubIssuesExecutionProviderConfig,
	type GitHubIssuesExecutionProviderConfig,
} from '../../src/agents/adapters/execution-github-issues.ts';
import { createExecutionProviderAdapter } from '../../src/agents/adapters/execution.ts';
import type { ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

const config: GitHubIssuesExecutionProviderConfig = {
	token: 'github_secret_token',
	repository: 'treeseed-ai/work',
	labels: ['treeseed'],
	inProgressLabels: ['treeseed-in-progress'],
	blockedLabels: ['treeseed-blocked'],
	cancelledLabels: ['treeseed-cancelled'],
};

function agent(): AgentRuntimeSpec {
	return {
		slug: 'provider-reviewer',
		handler: 'review',
		enabled: true,
		systemPrompt: 'Review.',
		persona: 'Reviewer.',
		triggers: [],
		permissions: [],
		context: { graphQueries: [], contextPacks: [] },
		execution: {
			provider: 'github_issues',
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
				requiredCapabilities: ['human_review'],
				preferredLanes: [],
				acceptableFallbacks: [],
				fallbackPolicy: 'fail_if_unavailable',
			},
		},
		outputs: { messageTypes: [], modelMutations: [] },
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
			executionProviderId: 'github_issues',
			projectAgentClassId: 'reviewer',
			mode: 'planning',
			status: 'leased',
			leaseState: 'leased',
			agentId: 'provider-reviewer',
			capacityEnvelope: {} as AgentCapacityEnvelope,
			decisionInput: { input: { objective: 'Review this.' } } as DecisionExecutionInput,
			capabilityHandles: { repositoryAccess: [{ token: 'ghs_secret_should_not_leak' }] } as any,
			workspaceContext: { secretValue: 'secret_should_not_leak' } as any,
		} as ProviderAssignment,
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: { input: { objective: 'Review this.' } } as DecisionExecutionInput,
		agent: agent(),
		workPackage: {
			kind: 'review',
			title: 'Review implementation',
			summary: 'Coordinate a human review.',
			instructions: 'Review the implementation and provide evidence.',
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

function issue(number: number, state = 'open', labels: string[] = ['treeseed']) {
	return {
		id: number + 1000,
		number,
		state,
		title: `Issue ${number}`,
		body: 'See #7 and https://github.com/treeseed-ai/work/pull/9',
		html_url: `https://github.com/treeseed-ai/work/issues/${number}`,
		labels: labels.map((name) => ({ name })),
		assignee: { login: 'ada' },
		created_at: '2026-06-20T00:00:00Z',
		updated_at: '2026-06-20T00:01:00Z',
	};
}

function response(body: unknown, init: ResponseInit = {}) {
	return new Response(body === undefined ? undefined : JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json' },
	});
}

function createMockFetch(handler: (request: { url: URL; method: string; body: unknown; headers: Headers }) => Response | Promise<Response>) {
	const requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
		requests.push({ method: init?.method ?? 'GET', url: url.toString(), body, headers: Object.fromEntries(headers.entries()) });
		return handler({ url, method: init?.method ?? 'GET', body, headers });
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function assertNoSecretLeak(value: unknown) {
	const serialized = JSON.stringify(value);
	expect(serialized).not.toContain(config.token);
	expect(serialized).not.toContain('ghs_secret_should_not_leak');
	expect(serialized).not.toContain('secret_should_not_leak');
}

describe('GitHubIssueExecutionProviderAdapter', () => {
	it('describes GitHub Issues as an async human issue queue provider', async () => {
		const configured = new GitHubIssueExecutionProviderAdapter({ config });
		const missing = new GitHubIssueExecutionProviderAdapter({ config: null });

		expect(await configured.describe()).toMatchObject({
			kind: 'human_issue_queue',
			supportsAsync: true,
			supportsCancel: true,
			supportsUsage: true,
			supportsArtifacts: true,
		});
		expect((await configured.describe()).capabilities).toEqual(expect.arrayContaining(['github_issue_queue', 'human_review']));
		expect(await missing.observe({})).toMatchObject({ available: false, pressure: 'exhausted' });
		expect(await configured.observe({})).toMatchObject({ available: true, metadata: { repository: 'treeseed-ai/work' } });
		assertNoSecretLeak(await configured.observe({}));
	});

	it('creates a GitHub issue with assignment idempotency labels and redacted work package context', async () => {
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/repos/treeseed-ai/work/issues') return response([]);
			if (method === 'POST' && url.pathname === '/repos/treeseed-ai/work/issues') return response(issue(12));
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new GitHubIssueExecutionProviderAdapter({ config, fetchImpl });

		const snapshot = await adapter.start(invocation());

		expect(snapshot).toMatchObject({ status: 'waiting', externalRef: '12', externalUrl: 'https://github.com/treeseed-ai/work/issues/12' });
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
			'GET /repos/treeseed-ai/work/issues',
			'POST /repos/treeseed-ai/work/issues',
		]);
		expect(requests[1]?.body).toMatchObject({
			title: 'Review implementation',
			labels: ['treeseed', 'treeseed-assignment-assignment-1', 'treeseed-assignment'],
		});
		expect(JSON.stringify(requests[1]?.body)).toContain('Review the implementation');
		assertNoSecretLeak({ snapshot, requests: requests.map(({ headers, ...rest }) => rest) });
	});

	it('adds credential-free TreeDX assignment tool instructions to issue bodies', async () => {
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/repos/treeseed-ai/work/issues') return response([]);
			if (method === 'POST' && url.pathname === '/repos/treeseed-ai/work/issues') return response(issue(13));
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const input = invocation('assignment-treedx');
		input.tools = [{
			kind: 'treedx_proxy',
			id: 'treedx-proxy:handle-1',
			name: 'TreeDX assignment proxy',
			description: 'Assignment-scoped TreeDX content proxy.',
			operations: ['files:read', 'files:write', 'git:commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-treedx',
			handleId: 'handle-1',
			repositoryId: 'repo-1',
			workspaceId: 'workspace-1',
			allowedOperations: ['files:read', 'files:write', 'git:commit'],
			allowedPaths: ['src/content/**'],
			routes: {
				buildContext: 'POST /v1/dx/projects/project-1/repos/repo-1/context/build',
				readRepositoryFiles: 'POST /v1/dx/projects/project-1/repos/repo-1/files/read',
				searchWorkspace: 'POST /v1/dx/projects/project-1/workspaces/workspace-1/search',
				readWorkspaceFile: 'GET /v1/dx/projects/project-1/workspaces/workspace-1/files?path=:path',
				writeWorkspaceFile: 'PUT /v1/dx/projects/project-1/workspaces/workspace-1/files?path=:path',
				commitWorkspace: 'POST /v1/dx/projects/project-1/workspaces/workspace-1/commit',
			},
			metadata: { token: 'secret_should_not_leak' },
		}];

		await new GitHubIssueExecutionProviderAdapter({ config, fetchImpl }).start(input);

		const body = JSON.stringify(requests[1]?.body);
		expect(body).toContain('## TreeDX assignment tools');
		expect(body).toContain('Authorization: Bearer <capacity-provider-api-key>');
		expect(body).toContain('x-treeseed-assignment-id');
		expect(body).toContain('src/content/**');
		expect(body).toContain('/v1/dx/projects/project-1/workspaces/workspace-1/commit');
		assertNoSecretLeak({ requests: requests.map(({ headers, ...rest }) => rest) });
	});

	it('reuses an existing GitHub issue for duplicate assignment starts', async () => {
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/repos/treeseed-ai/work/issues') return response([issue(13)]);
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const snapshot = await new GitHubIssueExecutionProviderAdapter({ config, fetchImpl }).start(invocation());

		expect(snapshot).toMatchObject({ status: 'waiting', externalRef: '13', metadata: { reused: true } });
		expect(requests.map((entry) => entry.method)).toEqual(['GET']);
	});

	it('maps GitHub issue state and labels to normalized execution statuses', async () => {
		const cases = [
			[issue(1, 'open'), 'waiting', undefined],
			[issue(2, 'open', ['treeseed-in-progress']), 'running', undefined],
			[issue(3, 'open', ['treeseed-blocked']), 'blocked', 'github_issue_blocked'],
			[issue(4, 'closed'), 'completed', undefined],
			[issue(5, 'open', ['treeseed-cancelled']), 'failed', 'github_issue_cancelled'],
		] as const;
		for (const [payload, expectedStatus, expectedCode] of cases) {
			const { fetchImpl } = createMockFetch(({ url, method }) => {
				if (method === 'GET' && /\/issues\/\d+$/u.test(url.pathname)) return response(payload);
				if (method === 'GET' && url.pathname.endsWith('/comments')) return response([]);
				return response({ error: 'unexpected' }, { status: 404 });
			});
			const snapshot = await new GitHubIssueExecutionProviderAdapter({ config, fetchImpl }).poll({ assignmentId: 'assignment-1', runId: String(payload.number), externalRef: String(payload.number) });
			expect(snapshot.status).toBe(expectedStatus);
			expect(snapshot.code).toBe(expectedCode);
		}
	});

	it('cancels, collects partial usage, and reports issue/comment/link artifacts', async () => {
		const comments = [{ id: 30, body: 'Done in #8', html_url: 'https://github.com/treeseed-ai/work/issues/14#issuecomment-30', user: { login: 'ada' } }];
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/repos/treeseed-ai/work/issues/14') return response(issue(14, 'closed', ['treeseed', 'reviewed']));
			if (method === 'GET' && url.pathname === '/repos/treeseed-ai/work/issues/14/comments') return response(comments);
			if (method === 'POST' && url.pathname === '/repos/treeseed-ai/work/issues/14/comments') return response(comments[0]);
			if (method === 'PATCH' && url.pathname === '/repos/treeseed-ai/work/issues/14') return response(issue(14, 'closed', ['treeseed-cancelled']));
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new GitHubIssueExecutionProviderAdapter({ config, fetchImpl });

		const usage = await adapter.collectUsage({ assignmentId: 'assignment-1', runId: '14', externalRef: '14' });
		const artifacts = await adapter.collectArtifacts({ assignmentId: 'assignment-1', runId: '14', externalRef: '14' });
		const cancelled = await adapter.cancel({ assignmentId: 'assignment-1', runId: '14', externalRef: '14', reason: 'No longer needed.' });

		expect(usage).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'github_issue_comments', amount: 1 }),
			expect.objectContaining({ kind: 'github_issue_labels', amount: 2 }),
		]));
		expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(['external_issue', 'github_issue_comment', 'github_issue_link']));
		expect(cancelled).toMatchObject({ status: 'cancelled', code: 'github_issue_cancelled' });
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toContain('PATCH /repos/treeseed-ai/work/issues/14');
		assertNoSecretLeak({ usage, artifacts, cancelled, requests: requests.map(({ headers, ...rest }) => rest) });
	});

	it('maps GitHub auth and provider errors without leaking credentials', async () => {
		const authAdapter = new GitHubIssueExecutionProviderAdapter({
			config,
			fetchImpl: createMockFetch(() => response({ message: config.token }, { status: 401 })).fetchImpl,
		});
		await expect(authAdapter.start(invocation())).rejects.toMatchObject({ code: 'github_issues_auth_failed', retryable: false });
		await expect(authAdapter.start(invocation())).rejects.not.toThrow(config.token);

		const unavailable = new GitHubIssueExecutionProviderAdapter({
			config,
			fetchImpl: createMockFetch(() => response({}, { status: 429 })).fetchImpl,
		});
		expect(await unavailable.poll({ assignmentId: 'assignment-1', runId: '2', externalRef: '2' })).toMatchObject({
			status: 'waiting',
			code: 'github_issues_provider_unavailable',
			retryable: true,
		});
	});

	it('resolves config and registers factory aliases', () => {
		expect(resolveGitHubIssuesExecutionProviderConfig({
			TREESEED_GITHUB_ISSUES_TOKEN: config.token,
			TREESEED_GITHUB_ISSUES_REPOSITORY: config.repository,
			TREESEED_GITHUB_ISSUES_LABELS: 'one,two',
		} as NodeJS.ProcessEnv)).toMatchObject({ labels: ['one', 'two'], repository: config.repository });
		expect(resolveGitHubIssuesExecutionProviderConfig({} as NodeJS.ProcessEnv)).toBeNull();
		expect(createExecutionProviderAdapter('github_issues')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_issue_queue')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('issue_queue')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
	});
});
