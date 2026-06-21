import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSdk } from '@treeseed/sdk';
import { buildTaskContext, startAndSeedWorkday } from '../../src/services/common.ts';

describe('service orchestration helpers', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubEnv('TREESEED_CLOUDFLARE_ACCOUNT_ID', 'account-123');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('builds a task context directly from the local sdk', async () => {
		const sdk = {
			getManagerContext: vi.fn(async () => ({
				payload: {
					task: { id: 'task-1', agentId: 'treeseed-docs-planner' },
					workDay: { id: 'workday-1' },
					graph: { nodes: [] },
				},
			})),
			get: vi.fn(async () => ({
				payload: { slug: 'treeseed-docs-planner', title: 'TreeSeed Documentation Planner' },
			})),
		} as unknown as AgentSdk;

		const context = await buildTaskContext(sdk, 'task-1');
		expect(context).toMatchObject({
			task: { id: 'task-1' },
			workDay: { id: 'workday-1' },
			agent: { slug: 'treeseed-docs-planner' },
		});
	});

	it('starts a workday and seeds startup tasks without manager http', async () => {
		const sdk = {
			refreshGraph: vi.fn(async () => ({ snapshotRoot: 'graph-1' })),
			startWorkDay: vi.fn(async () => ({ payload: { id: 'workday-1' } })),
			listAgentSpecs: vi.fn(async () => ([
				{ slug: 'treeseed-docs-planner', handler: 'plan', triggers: [{ type: 'startup' }] },
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
		expect((sdk.createTask as any).mock.calls).toHaveLength(4);
		expect((sdk.createTask as any).mock.calls[0]?.[0]).toMatchObject({
			type: 'refresh_project_graph',
			idempotencyKey: 'workday-1:refresh_project_graph',
		});
		expect((sdk.createTask as any).mock.calls[1]?.[0]).toMatchObject({
			type: 'scan_codebase_documentation_surface',
			idempotencyKey: 'workday-1:scan_codebase_documentation_surface',
			agentId: 'treeseed-codebase-cartographer',
		});
	});

});
