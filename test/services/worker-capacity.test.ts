import { describe, expect, it, vi } from 'vitest';
import {
	applyInteractiveWakeUpOverride,
	applyScaleCooldown,
	computeDesiredWorkerCount,
	enqueueTaskAndEnsureCapacity,
} from '../../src/services/worker-capacity.ts';

describe('worker capacity helpers', () => {
	it('computes desired workers from queue depth while respecting min and max', () => {
		expect(computeDesiredWorkerCount({
			minWorkers: 0,
			maxWorkers: 4,
			targetQueueDepth: 2,
			cooldownSeconds: 60,
		}, {
			queuedCount: 5,
			activeLeases: 0,
		})).toBe(3);
	});

	it('returns min workers when the queue is idle', () => {
		expect(computeDesiredWorkerCount({
			minWorkers: 2,
			maxWorkers: 4,
			targetQueueDepth: 2,
			cooldownSeconds: 60,
		}, {
			queuedCount: 0,
			activeLeases: 0,
		})).toBe(2);
	});

	it('holds scale-down during cooldown', () => {
		expect(applyScaleCooldown({
			minWorkers: 0,
			maxWorkers: 4,
			targetQueueDepth: 1,
			cooldownSeconds: 120,
		}, {
			id: 'scale-1',
			projectId: 'project-1',
			environment: 'local',
			poolName: 'primary',
			workDayId: null,
			desiredWorkers: 2,
			observedQueueDepth: 0,
			observedActiveLeases: 0,
			reason: 'reconcile',
			metadata: {},
			createdAt: '2026-04-15T12:59:30.000Z',
		}, 0, new Date('2026-04-15T13:00:00.000Z'))).toBe(2);
	});

	it('only bypasses cooldown for interactive zero-to-one wake-ups', () => {
		expect(applyInteractiveWakeUpOverride({
			priorityClass: 'interactive',
			queuedCount: 1,
			currentWorkers: 0,
			desiredWorkers: 0,
		})).toBe(1);
		expect(applyInteractiveWakeUpOverride({
			priorityClass: 'interactive',
			queuedCount: 4,
			currentWorkers: 1,
			desiredWorkers: 1,
		})).toBe(1);
	});

	it('enqueues interactive tasks and records a cold-start scale decision without failing on scaler errors', async () => {
		const sdk = {
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-1',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({
				payload: {
					id: 'scale-prev',
					projectId: 'project-1',
					environment: 'local',
					poolName: 'pool-1',
					workDayId: null,
					desiredWorkers: 0,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'cooldown_hold',
					metadata: {},
					createdAt: '2026-04-15T12:59:50.000Z',
				},
			})),
			recordScaleDecision: vi.fn(async (request) => ({
				payload: {
					id: 'scale-2',
					...request,
					createdAt: '2026-04-15T13:00:00.000Z',
				},
			})),
		};

		const result = await enqueueTaskAndEnsureCapacity(sdk as any, {
			taskId: 'task-1',
			actor: 'api',
			priorityClass: 'interactive',
			identity: {
				projectId: 'project-1',
				environment: 'local',
				poolName: 'pool-1',
			},
			autoscale: {
				minWorkers: 0,
				maxWorkers: 3,
				targetQueueDepth: 1,
				cooldownSeconds: 120,
			},
			scaler: {
				scale: vi.fn(async () => {
					throw new Error('railway unavailable');
				}),
			},
			now: new Date('2026-04-15T13:00:00.000Z'),
			enqueueTask: vi.fn(async () => ({ ok: true, taskId: 'task-1', queued: true })),
		});

		expect(result).toMatchObject({
			taskId: 'task-1',
			queued: true,
			workerState: 'cold_starting',
			desiredWorkers: 1,
			scaleApplied: false,
			scaleReason: 'interactive_cold_start',
		});
		expect(sdk.recordScaleDecision).toHaveBeenCalledWith(expect.objectContaining({
			desiredWorkers: 1,
			reason: 'interactive_cold_start',
		}));
	});
});
