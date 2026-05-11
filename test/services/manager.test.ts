import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runManagerAction, runManagerCycle, resolveManagerServiceConfig } from '../../src/services/manager.ts';

function createReporter() {
	return {
		kind: 'noop' as const,
		enabled: true,
		reportEnvironment: vi.fn(async () => undefined),
		reportResource: vi.fn(async () => undefined),
		reportDeployment: vi.fn(async () => undefined),
		registerAgentPoolHeartbeat: vi.fn(async () => undefined),
		reportScaleDecision: vi.fn(async () => undefined),
		reportWorkdaySummary: vi.fn(async () => undefined),
		getProjectCapacityPlan: vi.fn(async () => null),
		createCapacityReservation: vi.fn(async () => null),
		reportCapacityUsage: vi.fn(async () => undefined),
		reportCapacityRoutingDecision: vi.fn(async () => null),
		createApprovalRequest: vi.fn(async () => null),
	};
}

function createScaler() {
	return {
		scale: vi.fn(async (decision) => ({
			applied: true,
			provider: 'test',
			desiredWorkers: decision.desiredWorkers,
			metadata: {
				scaled: true,
			},
		})),
	};
}

function createSdkStub() {
	let activeWorkDay: Record<string, unknown> | null = null;
	let prioritySnapshot: Record<string, unknown> | null = null;
	let latestScaleDecision: Record<string, unknown> | null = null;
	const tasks: Array<Record<string, unknown>> = [];
	const creditLedger: Array<Record<string, unknown>> = [];

	return {
		getWorkPolicy: vi.fn(async () => ({ payload: null })),
		upsertWorkPolicy: vi.fn(async (request) => ({
			payload: {
				projectId: request.projectId,
				environment: request.environment,
				schedule: request.schedule,
				dailyTaskCreditBudget: request.dailyTaskCreditBudget,
				maxQueuedTasks: request.maxQueuedTasks,
				maxQueuedCredits: request.maxQueuedCredits,
				autoscale: request.autoscale,
				creditWeights: request.creditWeights ?? [],
				metadata: request.metadata ?? {},
			},
		})),
		search: vi.fn(async (request) => {
			if (request.model === 'work_day') {
				return { payload: activeWorkDay ? [activeWorkDay] : [] };
			}
			if (request.model === 'objective') {
				return {
					payload: [{
						id: 'reduce-spend',
						slug: 'reduce-spend',
						title: 'Reduce spend',
						status: 'active',
						relatedQuestions: ['queue-budget'],
						updated_at: '2026-04-10T00:00:00.000Z',
					}],
				};
			}
			if (request.model === 'question') {
				return {
					payload: [{
						id: 'queue-budget',
						slug: 'queue-budget',
						title: 'How should we cap the queue?',
						status: 'open',
						relatedObjectives: ['reduce-spend'],
						updated_at: '2026-04-09T00:00:00.000Z',
					}],
				};
			}
			return { payload: [] };
		}),
		refreshGraph: vi.fn(async () => ({ snapshotRoot: 'graph-1' })),
		startWorkDay: vi.fn(async (request) => {
			activeWorkDay = {
				id: 'workday-1',
				projectId: request.projectId,
				state: 'active',
				capacityBudget: request.capacityBudget,
				capacityUsed: 0,
				graphVersion: request.graphVersion,
				startedAt: '2026-04-15T13:00:00.000Z',
			};
			return { payload: activeWorkDay };
		}),
		createPrioritySnapshot: vi.fn(async (request) => {
			prioritySnapshot = {
				id: `snapshot-${request.workDayId ?? 'preview'}`,
				projectId: request.projectId,
				workDayId: request.workDayId ?? null,
				generatedAt: '2026-04-15T13:00:00.000Z',
				items: request.items,
				metadata: request.metadata ?? {},
			};
			return { payload: prioritySnapshot };
		}),
		listPriorityOverrides: vi.fn(async () => ({ payload: [] })),
		listAgentSpecs: vi.fn(async () => ([
			{
				slug: 'planner-agent',
				handler: 'planner',
				enabled: true,
				persona: 'Plans and coordinates work.',
				systemPrompt: 'Plan the next useful unit of work.',
				permissions: [],
				triggers: [{ type: 'startup', name: 'startup' }],
				execution: { cooldownSeconds: 0, leaseSeconds: 120 },
				triggerPolicy: { maxRunsPerCycle: 1 },
			},
		])),
		getCursor: vi.fn(async () => ({ payload: null })),
		scopeForAgent: vi.fn(function scopeForAgent() {
			return this;
		}),
		searchTasks: vi.fn(async (request) => {
			const states = Array.isArray(request.state) ? request.state : request.state ? [request.state] : [];
			const filtered = tasks.filter((task) =>
				(!request.workDayId || task.workDayId === request.workDayId)
				&& (states.length === 0 || states.includes(String(task.state))),
			);
			return { payload: filtered };
		}),
		createTask: vi.fn(async (request) => {
			const task = {
				id: `task-${tasks.length + 1}`,
				workDayId: request.workDayId,
				agentId: request.agentId,
				type: request.type,
				state: request.state ?? 'pending',
				priority: request.priority,
				idempotencyKey: request.idempotencyKey,
				payloadJson: JSON.stringify(request.payload),
				graphVersion: request.graphVersion,
				createdAt: '2026-04-15T13:00:00.000Z',
				updatedAt: '2026-04-15T13:00:00.000Z',
			};
			tasks.push(task);
			return { payload: task };
		}),
		recordTaskCredits: vi.fn(async (request) => {
			const entry = {
				id: `credit-${creditLedger.length + 1}`,
				...request,
				createdAt: '2026-04-15T13:00:00.000Z',
			};
			creditLedger.push(entry);
			if (activeWorkDay) {
				activeWorkDay = {
					...activeWorkDay,
					capacityUsed: Number(activeWorkDay.capacityUsed ?? 0) + Number(request.credits ?? 0),
				};
			}
			return { payload: entry };
		}),
		recordTaskProgress: vi.fn(async (request) => {
			const task = tasks.find((entry) => entry.id === request.id);
			if (task) {
				task.state = request.state ?? task.state;
			}
			return { payload: task ?? null };
		}),
		getLatestScaleDecision: vi.fn(async () => ({ payload: latestScaleDecision })),
		recordScaleDecision: vi.fn(async (request) => {
			latestScaleDecision = {
				id: 'scale-1',
				...request,
				createdAt: '2026-04-15T13:00:00.000Z',
			};
			return { payload: latestScaleDecision };
		}),
		createReport: vi.fn(async (request) => ({ payload: request })),
		closeWorkDay: vi.fn(async (request) => {
			activeWorkDay = activeWorkDay
				? {
					...activeWorkDay,
					state: request.state,
					summaryJson: JSON.stringify(request.summary ?? {}),
					endedAt: '2026-04-15T17:00:00.000Z',
				}
				: null;
			return { payload: activeWorkDay };
		}),
		listTaskCredits: vi.fn(async () => ({ payload: creditLedger })),
		getLatestPrioritySnapshot: vi.fn(async () => ({ payload: prioritySnapshot })),
	};
}

describe('manager service', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('skips opening a workday outside the active schedule and scales to zero', async () => {
		const sdk = createSdkStub();
		const reporter = createReporter();
		const scaler = createScaler();
		const config = {
			...resolveManagerServiceConfig(),
			mode: 'reconcile' as const,
			projectId: 'project-1',
			teamId: 'team-1',
			environment: 'staging' as const,
			defaultSchedule: {
				timezone: 'UTC',
				windows: [{ days: [2], startTime: '09:00', endTime: '17:00' }],
			},
			dailyTaskCreditBudget: 8,
			maxQueuedTasks: 2,
			maxQueuedCredits: 4,
			priorityModels: ['objective', 'question'],
		};

		const result = await runManagerCycle({
			sdk: sdk as any,
			reporter: reporter as any,
			scaler: scaler as any,
			config,
			now: new Date('2026-04-15T13:00:00.000Z'),
		});

		expect(result.insideWorkWindow).toBe(false);
		expect(result.workDay).toBeNull();
		expect((sdk.startWorkDay as any).mock.calls).toHaveLength(0);
		expect((scaler.scale as any).mock.calls[0]?.[0]).toMatchObject({
			desiredWorkers: 0,
		});
		expect((reporter.registerAgentPoolHeartbeat as any).mock.calls).toHaveLength(1);
	});

	it('opens a workday, seeds budget-limited tasks, and scales workers from queue depth', async () => {
		const sdk = createSdkStub();
		const reporter = createReporter();
		const scaler = createScaler();
		const config = {
			...resolveManagerServiceConfig(),
			mode: 'reconcile' as const,
			projectId: 'project-1',
			teamId: 'team-1',
			environment: 'staging' as const,
			defaultSchedule: {
				timezone: 'UTC',
				windows: [{ days: [3], startTime: '00:00', endTime: '23:59' }],
			},
			dailyTaskCreditBudget: 8,
			maxQueuedTasks: 2,
			maxQueuedCredits: 6,
			priorityModels: ['objective', 'question'],
			autoscale: {
				minWorkers: 0,
				maxWorkers: 3,
				targetQueueDepth: 1,
				cooldownSeconds: 0,
			},
		};

		const result = await runManagerCycle({
			sdk: sdk as any,
			reporter: reporter as any,
			scaler: scaler as any,
			config,
			now: new Date('2026-04-15T13:00:00.000Z'),
		});

		expect((sdk.startWorkDay as any).mock.calls).toHaveLength(1);
		expect((sdk.createPrioritySnapshot as any).mock.calls.length).toBeGreaterThan(0);
		expect((sdk.createTask as any).mock.calls.length).toBeGreaterThan(0);
		expect((sdk.createTask as any).mock.calls.map((call) => call[0]?.type)).toContain('agent_trigger');
		expect((sdk.recordTaskCredits as any).mock.calls.length).toBeGreaterThan(0);
		expect(result.seededTasks.length).toBeGreaterThan(0);
		expect(result.desiredWorkers).toBeGreaterThan(0);
		expect((scaler.scale as any).mock.calls[0]?.[0]).toMatchObject({
			desiredWorkers: result.desiredWorkers,
			observedQueueDepth: result.queuedCount,
		});
		expect((reporter.registerAgentPoolHeartbeat as any).mock.calls[0]?.[0]).toMatchObject({
			teamId: 'team-1',
			poolName: config.poolName,
		});
		expect((reporter.reportScaleDecision as any).mock.calls).toHaveLength(1);
	});

	it('holds manager scale-down during cooldown', async () => {
		const sdk = createSdkStub();
		const reporter = createReporter();
		const scaler = createScaler();
		(sdk.listAgentSpecs as any).mockResolvedValue([]);
		(sdk.getLatestScaleDecision as any).mockResolvedValue({
			payload: {
				id: 'scale-prev',
				projectId: 'project-1',
				environment: 'staging',
				poolName: 'project-1-staging',
				workDayId: 'workday-1',
				desiredWorkers: 2,
				observedQueueDepth: 3,
				observedActiveLeases: 0,
				reason: 'reconcile',
				metadata: {},
				createdAt: '2026-04-15T12:59:30.000Z',
			},
		});
		const config = {
			...resolveManagerServiceConfig(),
			mode: 'reconcile' as const,
			projectId: 'project-1',
			teamId: 'team-1',
			environment: 'staging' as const,
			defaultSchedule: {
				timezone: 'UTC',
				windows: [{ days: [3], startTime: '00:00', endTime: '23:59' }],
			},
			dailyTaskCreditBudget: 1,
			maxQueuedTasks: 0,
			maxQueuedCredits: 0,
			priorityModels: ['objective'],
			autoscale: {
				minWorkers: 0,
				maxWorkers: 3,
				targetQueueDepth: 1,
				cooldownSeconds: 120,
			},
		};

		const result = await runManagerCycle({
			sdk: sdk as any,
			reporter: reporter as any,
			scaler: scaler as any,
			config,
			now: new Date('2026-04-15T13:00:00.000Z'),
		});

		expect(result.desiredWorkers).toBe(2);
		expect((sdk.recordScaleDecision as any).mock.calls[0]?.[0]).toMatchObject({
			desiredWorkers: 2,
			reason: 'cooldown_hold',
		});
	});

	it('writes an immutable workday content snapshot when generating a workday report', async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-workday-report-'));
		try {
			vi.stubEnv('TREESEED_AGENT_REPO_ROOT', repoRoot);
			const sdk = createSdkStub();
			const reporter = createReporter();
			const scaler = createScaler();
			const config = {
				...resolveManagerServiceConfig(),
				mode: 'reconcile' as const,
				projectId: 'project-1',
				teamId: 'team-1',
				environment: 'staging' as const,
				defaultSchedule: {
					timezone: 'UTC',
					windows: [{ days: [3], startTime: '00:00', endTime: '23:59' }],
				},
				dailyTaskCreditBudget: 8,
				maxQueuedTasks: 1,
				maxQueuedCredits: 4,
				priorityModels: ['objective', 'question'],
			};

			await runManagerCycle({
				sdk: sdk as any,
				reporter: reporter as any,
				scaler: scaler as any,
				config,
				now: new Date('2026-04-15T13:00:00.000Z'),
			});

			const result = await runManagerAction({
				mode: 'report-workday',
				sdk: sdk as any,
				reporter: reporter as any,
				scaler: scaler as any,
				config,
			});

			const snapshot = (result as any).summary?.contentSnapshot;
			expect(snapshot?.relativePath).toMatch(/^src\/content\/workdays\/.+\.mdx$/);
			const document = readFileSync(join(repoRoot, snapshot.relativePath), 'utf8');
			expect(document).toContain('workDayId: workday-1');
			expect(document).toContain('## Tasks');
			expect(document).toContain('## Releases');
			expect(document).toContain('visibility: team');
			expect((sdk.createReport as any).mock.calls).toHaveLength(1);
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
