import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		reportCapacityEstimate: vi.fn(async () => null),
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

function createTestSdk() {
	let activeWorkDay: Record<string, unknown> | null = null;
	let prioritySnapshot: Record<string, unknown> | null = null;
	let latestScaleDecision: Record<string, unknown> | null = null;
	const tasks: Array<Record<string, unknown>> = [];
	const creditLedger: Array<Record<string, unknown>> = [];
	const taskOutputs: Array<Record<string, unknown>> = [];

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
			if (request.model === 'task_output') {
				const taskId = request.filters?.find((filter: Record<string, unknown>) => filter.field === 'taskId')?.value;
				return {
					payload: taskOutputs.filter((output) => !taskId || output.taskId === taskId),
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
				handler: 'plan',
				projectAgentClassId: 'planning',
				projectAgentClassSlug: 'planning',
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
				parentTaskId: request.parentTaskId ?? null,
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
				if (request.patch) {
					task.payloadJson = JSON.stringify({
						...JSON.parse(String(task.payloadJson ?? '{}')),
						...request.patch,
					});
				}
			}
			return { payload: task ?? null };
		}),
		appendTaskEvent: vi.fn(async (request) => ({ payload: request })),
		failTask: vi.fn(async (request) => {
			const task = tasks.find((entry) => entry.id === request.id);
			if (task) {
				task.state = request.retryable ? 'pending' : 'failed';
				task.availableAt = request.nextVisibleAt ?? task.availableAt;
				task.leaseExpiresAt = null;
				task.lastErrorCode = request.errorCode ?? null;
				task.lastErrorMessage = request.errorMessage;
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
		createMessage: vi.fn(async (request) => ({ payload: request })),
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
		__tasks: tasks,
		__taskOutputs: taskOutputs,
		__setActiveWorkDay: (value: Record<string, unknown>) => {
			activeWorkDay = value;
		},
	};
}

describe('manager service', () => {
	let testRepoRoot: string | null = null;

	beforeEach(() => {
		testRepoRoot = mkdtempSync(join(tmpdir(), 'treeseed-manager-test-root-'));
		vi.stubEnv('TREESEED_AGENT_REPO_ROOT', testRepoRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (testRepoRoot) {
			rmSync(testRepoRoot, { recursive: true, force: true });
			testRepoRoot = null;
		}
	});

	it('skips opening a workday outside the active schedule and scales to zero', async () => {
		const sdk = createTestSdk();
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

	it('opens an explicit local workday outside schedule and seeds starter tasks', async () => {
		const sdk = createTestSdk();
		const reporter = createReporter();
		const scaler = createScaler();
		const config = {
			...resolveManagerServiceConfig(),
			mode: 'reconcile' as const,
			projectId: 'project-1',
			teamId: 'team-1',
			environment: 'local' as const,
			workDayId: 'local-docs-1',
			defaultSchedule: {
				timezone: 'UTC',
				windows: [{ days: [2], startTime: '09:00', endTime: '17:00' }],
			},
			dailyTaskCreditBudget: 8,
			maxQueuedTasks: 2,
			maxQueuedCredits: 4,
			priorityModels: [],
		};

		const result = await runManagerCycle({
			sdk: sdk as any,
			reporter: reporter as any,
			scaler: scaler as any,
			config,
			now: new Date('2026-04-15T13:00:00.000Z'),
		});

		expect(result.insideWorkWindow).toBe(true);
		expect((sdk.startWorkDay as any).mock.calls).toHaveLength(1);
		expect((sdk.startWorkDay as any).mock.calls[0]?.[0]).toMatchObject({ id: 'local-docs-1' });
		const createdTaskTypes = (sdk.createTask as any).mock.calls.map((call) => call[0]?.type);
		expect(createdTaskTypes).toContain('refresh_project_graph');
		expect(createdTaskTypes).toContain('scan_codebase_documentation_surface');
		expect(result.seededTasks.length).toBeGreaterThan(0);
	});

	it('skips reconciliation when another healthy manager holds the lease', async () => {
		const sdk = {
			...createTestSdk(),
			claimWorkdayManagerLease: vi.fn(async () => ({ payload: null })),
		};
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
		};

		const result = await runManagerCycle({
			sdk: sdk as any,
			reporter: reporter as any,
			scaler: scaler as any,
			config,
			now: new Date('2026-04-15T13:00:00.000Z'),
		});

		expect(result).toMatchObject({
			skipped: true,
			reason: 'healthy_manager_lease_exists',
			seededTasks: [],
			desiredWorkers: 0,
		});
		expect((sdk.startWorkDay as any).mock.calls).toHaveLength(0);
		expect((scaler.scale as any).mock.calls).toHaveLength(0);
	});

	it('opens a workday, seeds budget-limited tasks, and scales workers from queue depth', async () => {
		const sdk = createTestSdk();
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
		const createdTaskTypes = (sdk.createTask as any).mock.calls.map((call) => call[0]?.type);
		expect(createdTaskTypes).toContain('agent_trigger');
		expect(createdTaskTypes).toContain('scan_codebase_documentation_surface');
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

	it('recovers stale claimed tasks with deterministic retry backoff', async () => {
		const sdk = createTestSdk();
		const reporter = createReporter();
		const scaler = createScaler();
		(sdk.listAgentSpecs as any).mockResolvedValue([]);
		(sdk as any).__setActiveWorkDay({
			id: 'workday-1',
			projectId: 'project-1',
			state: 'active',
			capacityBudget: 30,
			capacityUsed: 0,
			graphVersion: 'graph-1',
			startedAt: '2026-04-15T12:00:00.000Z',
		});
		(sdk as any).__tasks.push({
			id: 'stale-1',
			workDayId: 'workday-1',
			agentId: 'planner-agent',
			type: 'agent_trigger',
			state: 'running',
			priority: 10,
			idempotencyKey: 'workday-1:agent_trigger:planner-agent',
			payloadJson: '{}',
			attemptCount: 2,
			maxAttempts: 3,
			claimedBy: 'worker-old',
			leaseExpiresAt: '2026-04-15T12:59:00.000Z',
			createdAt: '2026-04-15T12:00:00.000Z',
			updatedAt: '2026-04-15T12:59:00.000Z',
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
			dailyTaskCreditBudget: 30,
			maxQueuedTasks: 0,
			maxQueuedCredits: 0,
			priorityModels: [],
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

		expect(result.staleTaskRecovery).toMatchObject({
			checkedTaskCount: 1,
			recoveredTasks: [expect.objectContaining({ id: 'stale-1', state: 'pending' })],
		});
		expect((sdk.appendTaskEvent as any).mock.calls).toEqual(expect.arrayContaining([
			[expect.objectContaining({
				taskId: 'stale-1',
				kind: 'stale_task_recovered',
				data: expect.objectContaining({
					retryDelaySeconds: 30,
					nextVisibleAt: '2026-04-15T13:00:30.000Z',
				}),
			})],
		]));
		expect((sdk.failTask as any).mock.calls[0]?.[0]).toMatchObject({
			id: 'stale-1',
			errorCode: 'stale_task_recovered',
			retryable: true,
			nextVisibleAt: '2026-04-15T13:00:30.000Z',
		});
	});

	it('materializes completed planning proposals progressively and marks them idempotent', async () => {
		const sdk = createTestSdk();
		const reporter = createReporter();
		const scaler = createScaler();
		(sdk.listAgentSpecs as any).mockResolvedValue([]);
		(sdk as any).__setActiveWorkDay({
			id: 'workday-1',
			projectId: 'project-1',
			state: 'active',
			capacityBudget: 30,
			capacityUsed: 0,
			graphVersion: 'graph-1',
			startedAt: '2026-04-15T13:00:00.000Z',
		});
		(sdk as any).__tasks.push({
			id: 'planning-1',
			workDayId: 'workday-1',
			agentId: 'planner-agent',
			type: 'planning_task',
			state: 'completed',
			priority: 70,
			idempotencyKey: 'workday-1:planning:source-1',
			parentTaskId: 'source-1',
			payloadJson: JSON.stringify({
				executionKind: 'planning',
				planning: { sourceTaskId: 'source-1', planningDepth: 0 },
			}),
			graphVersion: 'graph-1',
			createdAt: '2026-04-15T13:00:00.000Z',
			updatedAt: '2026-04-15T13:00:00.000Z',
		});
		(sdk as any).__taskOutputs.push({
			id: 'output-1',
			taskId: 'planning-1',
			outputJson: JSON.stringify({
				planningProposal: {
					schemaVersion: 1,
					planId: 'plan-1',
					sourceTaskId: 'source-1',
					parentTaskId: 'planning-1',
					planningDepth: 0,
					tasks: [
						{ id: 'verify', type: 'workflow_followup', priority: 10, taskSignature: 'workflow.dispatch', estimatedCreditsP50: 2, estimatedCreditsP90: 4, payload: { executionKind: 'workflow_dispatch', namespace: 'workflow', operation: 'verify' } },
						{ id: 'refactor', type: 'workflow_followup', priority: 9, taskSignature: 'workflow.dispatch', estimatedCreditsP50: 10, estimatedCreditsP90: 20, payload: { executionKind: 'workflow_dispatch', namespace: 'workflow', operation: 'refactor' } },
					],
				},
			}),
			createdAt: '2026-04-15T13:01:00.000Z',
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
			dailyTaskCreditBudget: 30,
			maxQueuedTasks: 1,
			maxQueuedCredits: 10,
			priorityModels: [],
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
			now: new Date('2026-04-15T13:02:00.000Z'),
		});

		expect(result.seededTasks.map((task: Record<string, unknown>) => task.type)).toContain('workflow_followup');
		const planningTask = (sdk as any).__tasks.find((task: Record<string, unknown>) => task.id === 'planning-1');
		expect(JSON.parse(String(planningTask.payloadJson))).toMatchObject({
			planningMaterializedAt: '2026-04-15T13:02:00.000Z',
		});
		expect((sdk.createTask as any).mock.calls.filter((call) => call[0]?.parentTaskId === 'planning-1')).toHaveLength(1);
		expect((sdk.recordTaskProgress as any).mock.calls.some((call) => call[0]?.appendEvent?.kind === 'plan_partially_admitted')).toBe(true);
	});

	it('holds manager scale-down during cooldown', async () => {
		const sdk = createTestSdk();
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
			reason: 'reconcile',
		});
	});

	it('writes an immutable workday content snapshot when generating a workday report', async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-workday-report-'));
		try {
			vi.stubEnv('TREESEED_AGENT_REPO_ROOT', repoRoot);
			const sdk = createTestSdk();
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
			(sdk as any).__taskOutputs.push({
				taskId: 'task-1',
				outputJson: JSON.stringify({
					generatedArtifacts: [{
						artifactKind: 'knowledge_draft',
						id: 'knowledge:runtime',
						title: 'Runtime Knowledge',
						targetPath: 'src/content/knowledge/agent-runtime/runtime.mdx',
						taskId: 'task-1',
					}, {
						artifactKind: 'promotion_request',
						id: 'promotion:runtime',
						approvalKind: 'promote_knowledge_draft',
						draftId: 'knowledge:runtime',
						targetPath: 'src/content/knowledge/agent-runtime/runtime.mdx',
						totalScore: 29,
						recommendation: 'promote',
						taskId: 'task-1',
					}, {
						artifactKind: 'docs_mutation_result',
						id: 'mutation:runtime',
						draftId: 'knowledge:runtime',
						targetPath: 'src/content/knowledge/agent-runtime/runtime.mdx',
						changedPaths: ['src/content/knowledge/agent-runtime/runtime.mdx'],
						verificationStatus: 'completed',
						mergedToStaging: true,
						taskId: 'task-1',
					}],
				}),
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
			expect(document).toContain('id: workday:workday-1');
			expect(document).toContain('title: TreeSeed Documentation Automation Workday - ');
			expect(document).toContain('work_day_id: workday-1');
			expect(document).toContain('generated_by: treeseed-agent');
			expect(document).toContain('updated:');
			expect(document).toContain('workDayId: workday-1');
			expect(document).toContain('# Summary');
			expect(document).toContain('## What agents analyzed');
			expect(document).toContain('## Knowledge created');
			expect(document).toContain('## Drafts pending review');
			expect(document).toContain('## Approved changes');
			expect(document).toContain('## Verification outcomes');
			expect(document).toContain('## Governance decisions');
			expect(document).toContain('## Open questions');
			expect(document).toContain('## Next workday recommendations');
			expect(document).toContain('## Tasks');
			expect(document).toContain('## Releases');
			expect(document).toContain('Runtime Knowledge');
			expect(document).toContain('promotion:runtime');
			expect(document).toContain('mutation:runtime');
			expect(document).toContain('visibility: team');
			expect((sdk.createReport as any).mock.calls).toHaveLength(1);
			expect((sdk.createReport as any).mock.calls[0]?.[0].body).toMatchObject({
				docsAutomation: expect.objectContaining({
					knowledgeDraftCount: 1,
					promotionRequestCount: 1,
					docsMutationCount: 1,
				}),
				contentSnapshot: expect.objectContaining({ relativePath: snapshot.relativePath }),
				linkedArtifacts: expect.arrayContaining([expect.objectContaining({ id: 'knowledge:runtime' })]),
				linkedApprovals: expect.arrayContaining([expect.objectContaining({ id: 'promotion:runtime' })]),
				linkedMutations: expect.arrayContaining([expect.objectContaining({ id: 'mutation:runtime' })]),
			});
			expect((sdk.createMessage as any).mock.calls).toEqual(expect.arrayContaining([
				[expect.objectContaining({
					type: 'workday_report_created',
					payload: expect.objectContaining({
						workDayId: 'workday-1',
						docsAutomation: expect.objectContaining({ docsMutationCount: 1 }),
					}),
				})],
			]));
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
