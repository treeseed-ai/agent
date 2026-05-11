import { describe, expect, it, vi } from 'vitest';
import { NoopWorkerPoolScaler, RailwayWorkerPoolScaler } from '../../src/services/worker-pool-scaler.ts';

describe('worker pool scaler', () => {
	it('returns an unapplied noop result when unconfigured', async () => {
		const scaler = new NoopWorkerPoolScaler();
		const result = await scaler.scale({
			id: 'scale-1',
			projectId: 'project-1',
			environment: 'staging',
			poolName: 'primary',
			workDayId: 'workday-1',
			desiredWorkers: 0,
			observedQueueDepth: 0,
			observedActiveLeases: 0,
			reason: 'idle',
			metadata: {},
			createdAt: '2026-04-15T00:00:00.000Z',
		});

		expect(result).toMatchObject({
			applied: false,
			provider: 'noop',
			desiredWorkers: 0,
		});
	});

	it('wakes named Railway runners instead of scaling replicas', async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			expect(String(body.query)).toContain('TreeseedRailwayRunnerWake');
			expect(body.variables).toMatchObject({
				serviceId: 'svc-worker',
				environmentId: 'env-staging',
				projectId: 'railway-project-1',
			});
			return new Response(JSON.stringify({ data: { serviceInstanceRedeploy: true } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		const scaler = new RailwayWorkerPoolScaler({
			apiToken: 'railway-token',
			serviceId: 'svc-worker',
			environmentId: 'env-staging',
			projectId: 'railway-project-1',
			fetchImpl: fetchMock as typeof fetch,
		});

		const result = await scaler.scale({
			id: 'scale-1',
			projectId: 'project-1',
			environment: 'staging',
			poolName: 'primary',
			workDayId: 'workday-1',
			desiredWorkers: 3,
			observedQueueDepth: 6,
			observedActiveLeases: 1,
			reason: 'reconcile',
			metadata: {},
			createdAt: '2026-04-15T00:00:00.000Z',
		});

		expect(result).toMatchObject({
			applied: true,
			provider: 'railway',
			desiredWorkers: 3,
			metadata: {
				action: 'wake',
				serviceId: 'svc-worker',
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('sleeps named Railway runners when desired workers reaches zero', async () => {
		const fetchMock = vi.fn(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			expect(String(body.query)).toContain('TreeseedRailwayRunnerSleep');
			expect(body.variables).toMatchObject({
				serviceId: 'svc-worker',
				environmentId: 'env-staging',
			});
			return new Response(JSON.stringify({ data: { deploymentRemove: true } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		const scaler = new RailwayWorkerPoolScaler({
			apiToken: 'railway-token',
			serviceId: 'svc-worker',
			environmentId: 'env-staging',
			projectId: 'railway-project-1',
			fetchImpl: fetchMock as typeof fetch,
		});

		const result = await scaler.scale({
			id: 'scale-2',
			projectId: 'project-1',
			environment: 'staging',
			poolName: 'primary',
			workDayId: 'workday-1',
			desiredWorkers: 0,
			observedQueueDepth: 0,
			observedActiveLeases: 0,
			reason: 'idle',
			metadata: {},
			createdAt: '2026-04-15T00:00:00.000Z',
		});

		expect(result).toMatchObject({
			applied: true,
			provider: 'railway',
			desiredWorkers: 0,
			metadata: {
				action: 'sleep',
				serviceId: 'svc-worker',
			},
		});
	});
});
