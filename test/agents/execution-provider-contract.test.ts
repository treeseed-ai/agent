import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import {
	CopilotExecutionProviderAdapter,
	createExecutionProviderAdapter,
} from '../../src/agents/adapters/execution.ts';
import { CodexSubscriptionExecutionProviderAdapter } from '../../src/agents/adapters/execution-codex.ts';
import {
	JiraExecutionProviderAdapter,
	type JiraExecutionProviderConfig,
} from '../../src/agents/adapters/execution-jira.ts';
import {
	GitHubIssueExecutionProviderAdapter,
	type GitHubIssuesExecutionProviderConfig,
} from '../../src/agents/adapters/execution-github-issues.ts';
import {
	DiscordExecutionProviderAdapter,
	type DiscordExecutionProviderConfig,
} from '../../src/agents/adapters/execution-discord.ts';
import { WorkflowExecutionProviderAdapter } from '../../src/agents/adapters/execution-workflow.ts';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

const forbiddenSecrets = ['ghs_secret', 'jira_secret', 'github_secret', 'discord_secret', 'TREESEED_JIRA_API_TOKEN', 'TREESEED_GITHUB_ISSUES_TOKEN', 'TREESEED_DISCORD_BOT_TOKEN'];

const jiraConfig: JiraExecutionProviderConfig = {
	baseUrl: 'https://jira.example.test',
	email: 'agent@example.test',
	apiToken: 'jira_secret',
	projectKey: 'TS',
	issueType: 'Task',
	doneStatuses: ['Done'],
	blockedStatuses: ['Blocked'],
	cancelledStatuses: ['Cancelled'],
	inProgressStatuses: ['In Progress'],
	storyPointsField: 'customfield_10016',
};

const githubIssuesConfig: GitHubIssuesExecutionProviderConfig = {
	token: 'github_secret',
	repository: 'treeseed-ai/work',
	labels: ['treeseed'],
	inProgressLabels: ['treeseed-in-progress'],
	blockedLabels: ['treeseed-blocked'],
	cancelledLabels: ['treeseed-cancelled'],
};

const discordConfig: DiscordExecutionProviderConfig = {
	botToken: 'discord_secret',
	channelId: 'channel-1',
	guildId: 'guild-1',
	threadPrefix: 'treeseed',
};

function agentSpec(provider = 'codex'): AgentRuntimeSpec {
	return {
		slug: 'contract-agent',
		handler: 'tester',
		enabled: true,
		systemPrompt: '',
		persona: '',
		cli: {},
		triggers: [],
		permissions: [],
		execution: {
			provider,
			model: 'test-model',
			approvalPolicy: 'never',
			sandboxMode: 'workspace_write',
			reasoningEffort: 'medium',
			allowedPaths: ['docs/**'],
			forbiddenPaths: ['.git/**'],
			worktree: { enabled: true },
			maxConcurrency: 1,
			timeoutSeconds: 60,
			cooldownSeconds: 0,
			leaseSeconds: 60,
			retryLimit: 1,
			branchPrefix: 'agent/',
		},
		outputs: {
			messageTypes: [],
			modelMutations: [],
		},
	};
}

function assignment(overrides: Partial<ProviderAssignment> = {}): ProviderAssignment {
	return {
		id: 'assignment-contract',
		teamId: 'team-test',
		projectId: 'project-test',
		capacityProviderId: 'capacity-provider-test',
		projectAgentClassId: 'agent-class-test',
		mode: 'acting',
		status: 'leased',
		leaseState: 'leased',
		agentId: 'contract-agent',
		handlerId: 'tester',
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: {} as DecisionExecutionInput,
		...overrides,
	} as ProviderAssignment;
}

function invocation(provider = 'codex', overrides: Partial<ExecutionProviderInvocation> = {}): ExecutionProviderInvocation {
	const agent = agentSpec(provider);
	return {
		assignment: assignment(overrides.assignment as Partial<ProviderAssignment> | undefined),
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: { input: {} } as DecisionExecutionInput,
		agent,
		workPackage: {
			kind: 'implementation',
			title: 'Execution provider contract test',
			summary: 'Verify the shared execution provider contract.',
			instructions: 'Run the provider contract test without leaking sensitive values.',
			context: {},
			expectedOutputs: [{ type: 'final_response', required: true }],
			constraints: {
				mode: 'acting',
				requiredCapabilities: ['repo_read'],
				allowedPaths: agent.execution.allowedPaths,
				forbiddenPaths: agent.execution.forbiddenPaths,
			},
		},
		leaseToken: 'lease-contract',
		runnerId: 'runner-contract',
		metadata: { runId: 'run-contract' },
		...overrides,
	};
}

async function assertDescriptor(adapter: ExecutionProviderAdapter, expected: Record<string, unknown>) {
	const descriptor = await adapter.describe();
	expect(descriptor).toMatchObject(expected);
	expect(descriptor.capabilities.length).toBeGreaterThan(0);
	expect(descriptor.nativeUnit).toBeTruthy();
	expect(descriptor.maxConcurrentAssignments).toBeGreaterThan(0);
}

function assertNoSecretLeak(value: unknown) {
	const serialized = JSON.stringify(value);
	for (const secret of forbiddenSecrets) {
		expect(serialized).not.toContain(secret);
	}
}

function issuePayload(status: string) {
	return {
		key: 'TS-1',
		fields: {
			summary: 'Contract issue',
			status: {
				name: status,
				statusCategory: { name: status === 'Done' ? 'Done' : 'In Progress' },
			},
			assignee: { displayName: 'Human Teammate' },
			comment: { comments: [{ id: 'comment-1', body: 'Completed safely.' }] },
			attachment: [{ id: 'attachment-1', filename: 'evidence.txt', content: 'https://jira.example.test/attachment/1', mimeType: 'text/plain' }],
			issuelinks: [{ id: 'link-1', type: { name: 'Relates' } }],
			timetracking: { timeSpentSeconds: 180 },
			customfield_10016: 3,
		},
	};
}

function mockJiraFetch() {
	const requests: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		const parsed = new URL(href);
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		requests.push({ method, url: href, body });
		if (parsed.pathname === '/rest/api/3/search') {
			return Response.json({ issues: [] });
		}
		if (parsed.pathname === '/rest/api/3/issue' && method === 'POST') {
			return Response.json({ key: 'TS-1' });
		}
		if (parsed.pathname.endsWith('/properties/treeseedAssignment')) {
			return new Response(null, { status: 204 });
		}
		if (parsed.pathname === '/rest/api/3/issue/TS-1' && method === 'GET') {
			return Response.json(issuePayload('Done'));
		}
		if (parsed.pathname === '/rest/api/3/issue/TS-1/transitions' && method === 'GET') {
			return Response.json({ transitions: [{ id: '91', name: 'Cancel', to: { name: 'Cancelled' } }] });
		}
		if (parsed.pathname === '/rest/api/3/issue/TS-1/transitions' && method === 'POST') {
			return new Response(null, { status: 204 });
		}
		if (parsed.pathname === '/rest/api/3/issue/TS-1/comment' && method === 'POST') {
			return Response.json({ id: 'comment-cancel' });
		}
		return Response.json({ error: 'unexpected route' }, { status: 404 });
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function workflowInvocation() {
	return invocation('workflow', {
		assignment: assignment({
			capabilityHandles: {
				workflowOperations: [{
					id: 'workflow-handle-1',
					kind: 'workflow_operation',
					status: 'active',
					assignmentId: 'assignment-contract',
					operations: ['dispatch_workflow'],
					operationId: 'implementation',
					secretBearing: true,
				}],
			},
		} as Partial<ProviderAssignment>),
		workPackage: {
			kind: 'implementation',
			title: 'Workflow contract test',
			summary: 'Verify workflow dispatch.',
			instructions: 'Dispatch without leaking ghs_secret.',
			context: { safe: true },
			expectedOutputs: [{ type: 'workflow_run', required: true }],
			constraints: {
				mode: 'acting',
				requiredCapabilities: ['workflow_dispatch'],
			},
			metadata: {
				inputs: {
					token: 'ghs_secret',
				},
			},
		},
	});
}

describe('execution provider adapter contract', () => {
	it('describes built-in execution provider descriptors with normalized capabilities', async () => {
		await assertDescriptor(new CodexSubscriptionExecutionProviderAdapter(), { kind: 'ai_model' });
		await assertDescriptor(new JiraExecutionProviderAdapter({ config: jiraConfig }), { kind: 'human_issue_queue', supportsAsync: true });
		await assertDescriptor(new GitHubIssueExecutionProviderAdapter({ config: githubIssuesConfig }), { kind: 'human_issue_queue', supportsAsync: true });
		await assertDescriptor(new DiscordExecutionProviderAdapter({ config: discordConfig }), { kind: 'human_issue_queue', supportsAsync: true });
		await assertDescriptor(new WorkflowExecutionProviderAdapter({ dispatchWorkflowOperation: async () => ({ ok: true }) }), { kind: 'deterministic_workflow', supportsAsync: true });
	});

	it('normalizes Codex provider start into an execution snapshot with mocked SDK boundary', async () => {
		const run = vi.fn(async () => ({
			items: [],
			finalResponse: 'Codex contract completed.',
			usage: null,
		}));
		const adapter = new CodexSubscriptionExecutionProviderAdapter({
			repoRoot: '/repo',
			createCodexClient: () => ({
				startThread: () => ({ id: 'thread-contract', run }),
				resumeThread: vi.fn(),
			}),
			prepareWorktree: async () => ({
				branchName: 'agent/contract/run-contract',
				worktreeRoot: '/repo/.agent-worktrees/contract/run-contract',
				created: true,
			}),
			env: {
				TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro',
				TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890',
			},
		});

		const snapshot = await adapter.start(invocation('codex'));

		expect(snapshot).toMatchObject({
			status: 'completed',
			outputs: { finalResponse: 'Codex contract completed.' },
			metadata: {
				provider: 'codex',
				codex: {
					threadId: 'thread-contract',
				},
			},
		});
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('passes assignment TreeSeed tools into the Copilot SDK boundary', async () => {
		const calls: unknown[] = [];
		const adapter = new CopilotExecutionProviderAdapter({
			repoRoot: '/repo',
			runCopilotTask: async (input) => {
				calls.push(input);
				return {
					status: 'completed',
					summary: 'Copilot completed.',
					stdout: 'Called treeseed_status.',
					stderr: '',
				};
			},
			env: {},
		});

		const snapshot = await adapter.start(invocation('copilot', {
			tools: [{
				kind: 'agent_tool',
				id: 'treeseed.status',
				name: 'TreeSeed status',
				description: 'Inspect TreeSeed status.',
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
				executionTarget: 'sdk_dispatch',
				mutability: 'read',
				metadata: {
					assignmentId: 'assignment-contract',
					projectId: 'project-test',
					dispatchPreferredMode: 'prefer_local',
				},
			}],
		}));

		expect(snapshot).toMatchObject({
			status: 'completed',
			metadata: {
				provider: 'copilot',
				toolCount: 1,
				copilotToolCount: 1,
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			cwd: '/repo',
			tools: [expect.objectContaining({ name: 'treeseed_status', skipPermission: true })],
		});
		expect(JSON.stringify(calls[0])).not.toContain('provider-secret');
	});

	it('runs Jira async lifecycle through start, poll, resume, cancel, usage, and artifacts with mocked Jira API', async () => {
		const { fetchImpl } = mockJiraFetch();
		const adapter = new JiraExecutionProviderAdapter({ config: jiraConfig, fetchImpl });
		const started = await adapter.start(invocation('jira'));
		const ref = {
			assignmentId: 'assignment-contract',
			runId: started.runId ?? 'TS-1',
			externalRef: started.externalRef,
			externalUrl: started.externalUrl,
		};

		const polled = await adapter.poll(ref);
		const resumed = await adapter.resume(ref);
		const cancelled = await adapter.cancel({ ...ref, reason: 'Contract test cancellation.' });
		const usage = await adapter.collectUsage(ref);
		const artifacts = await adapter.collectArtifacts(ref);

		expect(started).toMatchObject({ status: 'waiting', externalRef: 'TS-1' });
		expect(polled).toMatchObject({ status: 'completed', externalRef: 'TS-1' });
		expect(resumed).toMatchObject({ status: 'completed', externalRef: 'TS-1' });
		expect(cancelled).toMatchObject({ status: 'cancelled', code: 'jira_issue_cancelled' });
		expect(usage).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'jira_time_spent', amount: 180 }),
			expect.objectContaining({ kind: 'jira_story_points', amount: 3 }),
		]));
		expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(['external_issue', 'jira_attachment', 'jira_comment', 'jira_link']));
		assertNoSecretLeak({ started, polled, resumed, cancelled, usage, artifacts });
	});

	it('runs workflow deterministic lifecycle through assignment-scoped handle authorization', async () => {
		const dispatchWorkflowOperation = vi.fn(async (_assignmentId: string, _operationId: string, body: Record<string, unknown>) => ({
			ok: true,
			payload: {
				dispatch: {
					id: 'workflow-run-1',
					status: 'queued',
					htmlUrl: 'https://github.example.test/runs/1',
					logsUrl: 'https://github.example.test/runs/1/logs',
					runnerMinutes: 2,
				},
				body,
			},
		}));
		const adapter = new WorkflowExecutionProviderAdapter({ dispatchWorkflowOperation });
		const denied = await adapter.start(invocation('workflow'));
		const waiting = await adapter.start(workflowInvocation());
		const completed = await new WorkflowExecutionProviderAdapter({
			dispatchWorkflowOperation: async () => ({
				ok: true,
				payload: { dispatch: { id: 'workflow-run-2', status: 'success' } },
			}),
		}).start(workflowInvocation());
		const failed = await new WorkflowExecutionProviderAdapter({
			dispatchWorkflowOperation: async () => ({
				ok: true,
				payload: { dispatch: { id: 'workflow-run-3', status: 'failure' } },
			}),
		}).start(workflowInvocation());

		expect(denied).toMatchObject({ status: 'failed', code: 'assignment_workflow_operation_denied' });
		expect(waiting).toMatchObject({ status: 'waiting', externalRef: 'workflow-run-1' });
		expect(completed).toMatchObject({ status: 'completed', externalRef: 'workflow-run-2' });
		expect(failed).toMatchObject({ status: 'failed', externalRef: 'workflow-run-3' });
		expect(dispatchWorkflowOperation).toHaveBeenCalledTimes(1);
		assertNoSecretLeak({ waiting, completed, failed, dispatch: dispatchWorkflowOperation.mock.calls });
	});

	it('factory aliases resolve to concrete execution providers', () => {
		expect(createExecutionProviderAdapter('codex')).toBeInstanceOf(CodexSubscriptionExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('codex_subscription')).toBeInstanceOf(CodexSubscriptionExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('jira')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('jira_issue_queue')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('human_issue_queue')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_issues')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_issue_queue')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('issue_queue')).toBeInstanceOf(GitHubIssueExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('discord')).toBeInstanceOf(DiscordExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('discord_thread')).toBeInstanceOf(DiscordExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('workflow_operation')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('deterministic_workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_actions')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_actions_workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
	});

	it('rejects removed or unknown execution provider names instead of falling back to stub work', () => {
		expect(() => createExecutionProviderAdapter('stub')).toThrow(/Unsupported execution provider "stub"/);
		expect(() => createExecutionProviderAdapter('manual')).toThrow(/Unsupported execution provider "manual"/);
		expect(() => createExecutionProviderAdapter('made_up_provider')).toThrow(/Unsupported execution provider "made_up_provider"/);
	});
});
