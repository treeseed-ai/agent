import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSdk } from '@treeseed/sdk';
import { buildTaskContext, enqueueTaskFromSdk, startAndSeedWorkday } from '../../src/services/common.ts';

describe('service orchestration helpers', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-123');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-push-secret');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('builds a task context directly from the local sdk', async () => {
		const sdk = {
			getManagerContext: vi.fn(async () => ({
				payload: {
					task: { id: 'task-1', agentId: 'market-curator' },
					workDay: { id: 'workday-1' },
					graph: { nodes: [] },
				},
			})),
			get: vi.fn(async () => ({
				payload: { slug: 'market-curator', title: 'Market Curator' },
			})),
		} as unknown as AgentSdk;

		const context = await buildTaskContext(sdk, 'task-1');
		expect(context).toMatchObject({
			task: { id: 'task-1' },
			workDay: { id: 'workday-1' },
			agent: { slug: 'market-curator' },
		});
	});

	it('starts a workday and seeds startup tasks without manager http', async () => {
		const sdk = {
			refreshGraph: vi.fn(async () => ({ snapshotRoot: 'graph-1' })),
			startWorkDay: vi.fn(async () => ({ payload: { id: 'workday-1' } })),
			listAgentSpecs: vi.fn(async () => ([
				{ slug: 'market-curator', handler: 'market-curator', triggers: [{ type: 'startup' }] },
				{ slug: 'nightly-only', handler: 'nightly-only', triggers: [{ type: 'schedule' }] },
				{ slug: 'manual-agent', handler: 'manual-agent', triggers: [{ type: 'manual' }] },
			])),
			createTask: vi.fn(async (request) => ({ payload: request })),
		} as unknown as AgentSdk;

		const result = await startAndSeedWorkday(sdk, {
			projectId: 'treeseed-market',
			capacityBudget: 100,
			actor: 'manager',
		});

		expect(result).toMatchObject({
			ok: true,
			workDay: { id: 'workday-1' },
		});
		expect(sdk.refreshGraph).not.toHaveBeenCalled();
		expect((sdk.createTask as any).mock.calls).toHaveLength(3);
		expect((sdk.createTask as any).mock.calls[0]?.[0]).toMatchObject({
			type: 'refresh_project_graph',
			idempotencyKey: 'workday-1:refresh_project_graph',
		});
	});

	it('enqueues a task directly through the queue client and records queued state', async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/messages')) {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const sdk = {
			get: vi.fn(async () => ({
				payload: {
					id: 'task-1',
					workDayId: 'workday-1',
					agentId: 'market-curator',
					type: 'agent_root',
					idempotencyKey: 'workday-1:market-curator',
					attemptCount: 0,
					graphVersion: 'graph-1',
				},
			})),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-1', state: 'queued' } })),
		} as unknown as AgentSdk;

		const result = await enqueueTaskFromSdk(sdk, {
			taskId: 'task-1',
			queueName: 'agent-work',
			actor: 'worker',
		});

		expect(result).toMatchObject({ ok: true, taskId: 'task-1', queued: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((sdk.recordTaskProgress as any).mock.calls[0]?.[0]).toMatchObject({
			id: 'task-1',
			state: 'queued',
		});
	});
});
