import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import {
	DiscordExecutionProviderAdapter,
	resolveDiscordExecutionProviderConfig,
	type DiscordExecutionProviderConfig,
} from '../../src/agents/adapters/execution-discord.ts';
import { createExecutionProviderAdapter } from '../../src/agents/adapters/execution.ts';
import type { ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

const config: DiscordExecutionProviderConfig = {
	botToken: 'discord_secret_token',
	channelId: 'channel-1',
	guildId: 'guild-1',
	threadPrefix: 'treeseed',
};

function agent(): AgentRuntimeSpec {
	return {
		slug: 'provider-coordinator',
		handler: 'planner',
		enabled: true,
		systemPrompt: 'Coordinate.',
		persona: 'Coordinator.',
		triggers: [],
		permissions: [],
		context: { graphQueries: [], contextPacks: [] },
		execution: {
			provider: 'discord',
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
				requiredCapabilities: ['human_coordination'],
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
			executionProviderId: 'discord',
			projectAgentClassId: 'planner',
			mode: 'planning',
			status: 'leased',
			leaseState: 'leased',
			agentId: 'provider-coordinator',
			capacityEnvelope: {} as AgentCapacityEnvelope,
			decisionInput: { input: { objective: 'Coordinate this.' } } as DecisionExecutionInput,
			capabilityHandles: { repositoryAccess: [{ token: 'ghs_secret_should_not_leak' }] } as any,
			workspaceContext: { secretValue: 'secret_should_not_leak' } as any,
		} as ProviderAssignment,
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: { input: { objective: 'Coordinate this.' } } as DecisionExecutionInput,
		agent: agent(),
		workPackage: {
			kind: 'planning',
			title: 'Coordinate review',
			summary: 'Solicit human feedback.',
			instructions: 'Read the request and coordinate a decision.',
			context: { requestId: 'req-1' },
			expectedOutputs: [{ type: 'decision_feedback', required: true }],
			constraints: {
				mode: 'planning',
				requiredCapabilities: ['human_coordination'],
				allowedPaths: ['docs/**'],
				forbiddenPaths: ['.env*'],
			},
		},
		leaseToken: 'lease-1',
		runnerId: 'runner-1',
		metadata: { runId: id },
	};
}

function response(body: unknown, init: ResponseInit = {}) {
	return new Response(body === undefined ? undefined : JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json' },
	});
}

function message(id: string, content: string, timestamp = '2026-06-20T00:00:00Z') {
	return {
		id,
		content,
		timestamp,
		author: { id: `user-${id}`, username: `user-${id}` },
	};
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
	expect(serialized).not.toContain(config.botToken);
	expect(serialized).not.toContain('ghs_secret_should_not_leak');
	expect(serialized).not.toContain('secret_should_not_leak');
}

describe('DiscordExecutionProviderAdapter', () => {
	it('describes Discord as an async human coordination provider', async () => {
		const configured = new DiscordExecutionProviderAdapter({ config });
		const missing = new DiscordExecutionProviderAdapter({ config: null });

		expect(await configured.describe()).toMatchObject({
			kind: 'human_issue_queue',
			supportsAsync: true,
			supportsCancel: true,
			supportsUsage: true,
			supportsArtifacts: true,
		});
		expect((await configured.describe()).capabilities).toEqual(expect.arrayContaining(['human_coordination', 'feedback_request', 'decision_action']));
		expect(await missing.observe({})).toMatchObject({ available: false, pressure: 'exhausted' });
		expect(await configured.observe({})).toMatchObject({ available: true, metadata: { channelId: 'channel-1', guildId: 'guild-1' } });
		assertNoSecretLeak(await configured.observe({}));
	});

	it('creates a Discord message and assignment thread', async () => {
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/api/v10/guilds/guild-1/threads/active') return response({ threads: [] });
			if (method === 'GET' && url.pathname === '/api/v10/channels/channel-1/threads/archived/public') return response({ threads: [] });
			if (method === 'POST' && url.pathname === '/api/v10/channels/channel-1/messages') return response({ id: 'message-1' });
			if (method === 'POST' && url.pathname === '/api/v10/channels/channel-1/messages/message-1/threads') return response({ id: 'thread-1', name: 'treeseed-assignment-1' });
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new DiscordExecutionProviderAdapter({ config, fetchImpl });

		const snapshot = await adapter.start(invocation());

		expect(snapshot).toMatchObject({
			status: 'waiting',
			externalRef: 'thread-1',
			externalUrl: 'https://discord.com/channels/guild-1/thread-1',
			metadata: { reused: false },
		});
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
			'GET /api/v10/guilds/guild-1/threads/active',
			'GET /api/v10/channels/channel-1/threads/archived/public',
			'POST /api/v10/channels/channel-1/messages',
			'POST /api/v10/channels/channel-1/messages/message-1/threads',
		]);
		expect(JSON.stringify(requests[2]?.body)).toContain('treeseed: complete');
		assertNoSecretLeak({ snapshot, requests: requests.map(({ headers, ...rest }) => rest) });
	});

	it('reuses an active thread by assignment thread name', async () => {
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/api/v10/guilds/guild-1/threads/active') return response({ threads: [{ id: 'thread-2', name: 'treeseed-assignment-1' }] });
			if (method === 'GET' && url.pathname === '/api/v10/channels/thread-2/messages') return response([]);
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const snapshot = await new DiscordExecutionProviderAdapter({ config, fetchImpl }).start(invocation());

		expect(snapshot).toMatchObject({ status: 'waiting', externalRef: 'thread-2', metadata: { reused: true } });
		expect(requests.map((entry) => entry.method)).toEqual(['GET', 'GET']);
	});

	it('maps exact Discord control replies to normalized execution statuses', async () => {
		const cases = [
			[[message('1', 'hello')], 'waiting', 'discord_thread_waiting'],
			[[message('2', 'treeseed: running')], 'running', undefined],
			[[message('3', 'treeseed: blocked Need a reviewer')], 'blocked', 'discord_thread_blocked'],
			[[message('4', 'treeseed: complete Approved')], 'completed', undefined],
			[[message('5', 'treeseed: cancel Not needed')], 'failed', 'discord_thread_cancelled'],
		] as const;
		for (const [messages, expectedStatus, expectedCode] of cases) {
			const { fetchImpl } = createMockFetch(({ url, method }) => {
				if (method === 'GET' && url.pathname === '/api/v10/channels/thread-1/messages') return response(messages);
				return response({ error: 'unexpected' }, { status: 404 });
			});
			const snapshot = await new DiscordExecutionProviderAdapter({ config, fetchImpl }).poll({
				assignmentId: 'assignment-1',
				runId: 'thread-1',
				externalRef: 'thread-1',
				metadata: { threadName: 'treeseed-assignment-1', messageId: 'message-1' },
			});
			expect(snapshot.status).toBe(expectedStatus);
			expect(snapshot.code).toBe(expectedCode);
		}
	});

	it('cancels, collects partial usage, and reports thread/message artifacts', async () => {
		const replies = [message('10', 'treeseed: complete Looks good'), message('11', 'Evidence attached')];
		const { fetchImpl, requests } = createMockFetch(({ url, method }) => {
			if (method === 'GET' && url.pathname === '/api/v10/channels/thread-3/messages') return response(replies);
			if (method === 'POST' && url.pathname === '/api/v10/channels/thread-3/messages') return response(message('12', 'treeseed: cancel No longer needed.'));
			return response({ error: 'unexpected' }, { status: 404 });
		});
		const adapter = new DiscordExecutionProviderAdapter({ config, fetchImpl });
		const ref = {
			assignmentId: 'assignment-1',
			runId: 'thread-3',
			externalRef: 'thread-3',
			externalUrl: 'https://discord.com/channels/guild-1/thread-3',
			metadata: { threadName: 'treeseed-assignment-1', messageId: 'message-3' },
		};

		const usage = await adapter.collectUsage(ref);
		const artifacts = await adapter.collectArtifacts(ref);
		const cancelled = await adapter.cancel({ ...ref, reason: 'No longer needed.' });

		expect(usage).toEqual([expect.objectContaining({ kind: 'discord_thread_messages', amount: 2 })]);
		expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(['external_issue', 'discord_thread_message']));
		expect(cancelled).toMatchObject({ status: 'cancelled', code: 'discord_thread_cancelled' });
		expect(requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toContain('POST /api/v10/channels/thread-3/messages');
		assertNoSecretLeak({ usage, artifacts, cancelled, requests: requests.map(({ headers, ...rest }) => rest) });
	});

	it('maps Discord auth and provider errors without leaking credentials', async () => {
		const authAdapter = new DiscordExecutionProviderAdapter({
			config,
			fetchImpl: createMockFetch(() => response({ message: config.botToken }, { status: 401 })).fetchImpl,
		});
		await expect(authAdapter.start(invocation())).rejects.toMatchObject({ code: 'discord_auth_failed', retryable: false });
		await expect(authAdapter.start(invocation())).rejects.not.toThrow(config.botToken);

		const unavailable = new DiscordExecutionProviderAdapter({
			config,
			fetchImpl: createMockFetch(() => response({}, { status: 429 })).fetchImpl,
		});
		expect(await unavailable.poll({ assignmentId: 'assignment-1', runId: 'thread-4', externalRef: 'thread-4' })).toMatchObject({
			status: 'waiting',
			code: 'discord_provider_unavailable',
			retryable: true,
		});
	});

	it('resolves config and registers factory aliases', () => {
		expect(resolveDiscordExecutionProviderConfig({
			TREESEED_DISCORD_BOT_TOKEN: config.botToken,
			TREESEED_DISCORD_CHANNEL_ID: config.channelId,
			TREESEED_DISCORD_GUILD_ID: config.guildId ?? '',
		} as NodeJS.ProcessEnv)).toMatchObject({ channelId: config.channelId, guildId: config.guildId, threadPrefix: 'treeseed' });
		expect(resolveDiscordExecutionProviderConfig({} as NodeJS.ProcessEnv)).toBeNull();
		expect(createExecutionProviderAdapter('discord')).toBeInstanceOf(DiscordExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('discord_thread')).toBeInstanceOf(DiscordExecutionProviderAdapter);
	});
});
