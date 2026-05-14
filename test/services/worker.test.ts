import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = {
	claimTask: vi.fn(),
	createTask: vi.fn(),
	recordTaskProgress: vi.fn(),
	completeTask: vi.fn(),
	failTask: vi.fn(),
	dispatch: vi.fn(),
};

const queue = {
	pull: vi.fn(),
	ack: vi.fn(),
	retry: vi.fn(),
};

const reporter = vi.hoisted(() => ({
	reportCapacityUsage: vi.fn(async () => undefined),
	createApprovalRequest: vi.fn(async () => null),
}));

const workerConfig = {
	workerId: 'worker-test',
	batchSize: 1,
	visibilityTimeoutMs: 1000,
	pollIntervalMs: 1000,
	leaseSeconds: 120,
};

let taskContext: Record<string, unknown> = {
	task: null,
	agent: null,
};

const runAgentMock = vi.fn();

vi.mock('@treeseed/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@treeseed/sdk')>();
	return {
		...actual,
		createControlPlaneReporter: vi.fn(() => reporter),
	};
});

vi.mock('../../src/services/common.ts', () => ({
	buildTaskContext: vi.fn(async () => taskContext),
	createQueueClient: vi.fn(() => queue),
	createQueuePushClient: vi.fn(() => null),
	createServiceSdk: vi.fn(() => sdk),
	queueEnvelopeForTask: vi.fn((task) => ({
		messageId: `message-${task.id ?? 'task'}`,
		taskId: String(task.id ?? ''),
		workDayId: String(task.workDayId ?? ''),
		agentId: String(task.agentId ?? ''),
		taskType: String(task.type ?? ''),
		idempotencyKey: String(task.idempotencyKey ?? ''),
		attempt: 1,
		payloadRef: `d1:tasks/${String(task.id ?? '')}`,
		graphVersion: task.graphVersion ?? null,
		budgetHint: 1,
	})),
	resolveServiceRepoRoot: vi.fn(() => '/tmp/treeseed'),
	resolveWorkerConfig: vi.fn(() => workerConfig),
}));

vi.mock('../../src/agents/kernel/agent-kernel.ts', () => ({
	AgentKernel: class MockAgentKernel {
		runAgent = runAgentMock;
	},
}));

describe('worker service', () => {
	beforeEach(() => {
		taskContext = { task: null, agent: null };
		queue.pull.mockResolvedValue({ messages: [] });
		queue.ack.mockResolvedValue(undefined);
		queue.retry.mockResolvedValue(undefined);
		sdk.claimTask.mockResolvedValue({ payload: { id: 'task-1' } });
		sdk.createTask.mockResolvedValue({ payload: { id: 'task-followup' } });
		sdk.recordTaskProgress.mockResolvedValue({ payload: { id: 'task-1', state: 'running' } });
		sdk.completeTask.mockResolvedValue({ payload: { id: 'task-1', state: 'completed' } });
		sdk.failTask.mockResolvedValue({ payload: { id: 'task-1', state: 'failed' } });
		sdk.dispatch.mockResolvedValue({
			ok: true,
			mode: 'inline',
			namespace: 'workflow',
			operation: 'verify',
			target: 'local',
			capability: null,
			payload: { verified: true },
		});
		runAgentMock.mockResolvedValue({
			status: 'completed',
			summary: 'Agent completed.',
		});
		reporter.reportCapacityUsage.mockClear();
		reporter.createApprovalRequest.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('executes queued workflow dispatch tasks through sdk dispatch', async () => {
		taskContext = {
			task: {
				id: 'task-1',
				agentId: 'workflow-dispatch',
				payloadJson: JSON.stringify({
					executionKind: 'workflow_dispatch',
					namespace: 'workflow',
					operation: 'verify',
					input: { strict: true },
				}),
			},
			agent: null,
		};
		queue.pull.mockResolvedValue({
			messages: [{
				body: { taskId: 'task-1' },
				attempts: 1,
				leaseId: 'lease-1',
			}],
		});

		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		const result = await runWorkerCycle();

		expect(result).toMatchObject({ ok: true, processed: 1 });
		expect(sdk.dispatch).toHaveBeenCalledWith(expect.objectContaining({
			namespace: 'workflow',
			operation: 'verify',
			input: { strict: true },
			preferredMode: 'prefer_local',
		}));
		expect(sdk.completeTask).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-1',
			summary: expect.objectContaining({
				status: 'completed',
				summary: 'Executed workflow:verify',
			}),
		}));
		expect(queue.ack).toHaveBeenCalledWith(['lease-1']);
	}, 20_000);

	it('identifies when a deployed worker loop should exit after idle timeout', async () => {
		const { shouldExitWorkerLoopAfterIdle } = await import('../../src/services/worker.ts');

		expect(shouldExitWorkerLoopAfterIdle({
			idleExitMs: 60000,
			idleSince: 1000,
			now: 61000,
			processed: 0,
		})).toBe(true);
		expect(shouldExitWorkerLoopAfterIdle({
			idleExitMs: 60000,
			idleSince: 1000,
			now: 61000,
			processed: 1,
		})).toBe(false);
		expect(shouldExitWorkerLoopAfterIdle({
			idleExitMs: 0,
			idleSince: 1000,
			now: 61000,
			processed: 0,
		})).toBe(false);
	});

	it('executes manager-materialized agent trigger tasks with the provided invocation', async () => {
		taskContext = {
			task: {
				id: 'task-2',
				agentId: 'planner-agent',
				payloadJson: JSON.stringify({
					executionKind: 'agent_trigger',
					agentSlug: 'planner-agent',
					invocation: {
						kind: 'startup',
						source: 'startup',
						trigger: { type: 'startup', name: 'startup' },
					},
				}),
			},
			agent: { slug: 'planner-agent' },
		};
		queue.pull.mockResolvedValue({
			messages: [{
				body: { taskId: 'task-2' },
				attempts: 2,
				leaseId: 'lease-2',
			}],
		});

		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		const result = await runWorkerCycle();

		expect(result).toMatchObject({ ok: true, processed: 1 });
		expect(runAgentMock).toHaveBeenCalledWith(
			'planner-agent',
			'manual',
			expect.objectContaining({
				kind: 'startup',
				source: 'startup',
			}),
		);
		expect(sdk.completeTask).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-2',
			summary: expect.objectContaining({
				status: 'completed',
				summary: 'Agent completed.',
			}),
		}));
		expect(queue.ack).toHaveBeenCalledWith(['lease-2']);
	});

	it('executes planning tasks as non-mutating proposal normalization', async () => {
		taskContext = {
			task: {
				id: 'planning-1',
				workDayId: 'workday-1',
				agentId: 'planner-agent',
				type: 'planning_task',
				parentTaskId: 'source-1',
				payloadJson: JSON.stringify({
					executionKind: 'planning',
					planning: {
						sourceTaskId: 'source-1',
						sourceTaskType: 'agent_trigger',
						planningDepth: 0,
						proposedTasks: [
							{ id: 'verify', type: 'workflow_followup', taskSignature: 'workflow.dispatch', estimatedCreditsP50: 2, estimatedCreditsP90: 4, payload: { executionKind: 'workflow_dispatch', operation: 'verify' } },
						],
					},
				}),
			},
			agent: { slug: 'planner-agent' },
		};
		queue.pull.mockResolvedValue({
			messages: [{
				body: { taskId: 'planning-1', workDayId: 'workday-1' },
				attempts: 1,
				leaseId: 'lease-planning',
			}],
		});

		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		const result = await runWorkerCycle();

		expect(result).toMatchObject({ ok: true, processed: 1 });
		expect(runAgentMock).not.toHaveBeenCalled();
		expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
			id: 'planning-1',
			appendEvent: expect.objectContaining({ kind: 'plan_proposed' }),
		}));
		expect(sdk.completeTask).toHaveBeenCalledWith(expect.objectContaining({
			id: 'planning-1',
			output: expect.objectContaining({
				executionKind: 'planning',
				planningProposal: expect.objectContaining({
					tasks: [expect.objectContaining({ id: 'verify' })],
				}),
			}),
		}));
		expect(queue.ack).toHaveBeenCalledWith(['lease-planning']);
	});

	it('checkpoints over-budget work as continuation_required instead of completing it', async () => {
		taskContext = {
			task: {
				id: 'task-3',
				workDayId: 'workday-1',
				agentId: 'planner-agent',
				type: 'agent_trigger',
				payloadJson: JSON.stringify({
					executionKind: 'agent_trigger',
					agentSlug: 'planner-agent',
					taskSignature: 'engineer.small_fix',
					actualCredits: 3,
					attentionEstimate: {
						attentionWeight: 3,
						coordinationWeight: 1,
						totalAttentionWeight: 4,
						estimatedContextTokens: 2000,
					},
					capacity: {
						providerId: 'provider-1',
						laneId: 'lane-1',
						reservationId: 'reservation-1',
						reservedCredits: 2,
					},
				}),
			},
			agent: { slug: 'planner-agent' },
		};
		runAgentMock.mockResolvedValue({
			status: 'completed',
			summary: 'Agent changed files but needs more capacity.',
			metadata: { changedPaths: ['packages/agent/src/foo.ts'] },
		});
		queue.pull.mockResolvedValue({
			messages: [{
				body: { taskId: 'task-3', workDayId: 'workday-1' },
				attempts: 1,
				leaseId: 'lease-3',
			}],
		});

		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		const result = await runWorkerCycle();

		expect(result).toMatchObject({ ok: true, processed: 1 });
		expect(sdk.completeTask).not.toHaveBeenCalled();
		expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-3',
			state: 'continuation_required',
			appendEvent: expect.objectContaining({ kind: 'continuation_required' }),
		}));
		expect(reporter.createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'continuation_required',
			taskId: 'task-3',
		}));
		expect(reporter.reportCapacityUsage).toHaveBeenCalledWith(expect.objectContaining({
			usageActual: expect.objectContaining({
				metadata: expect.objectContaining({
					attentionEstimate: expect.objectContaining({ totalAttentionWeight: 4 }),
				}),
			}),
		}));
		expect(queue.ack).toHaveBeenCalledWith(['lease-3']);
	});

	it('routes low-confidence hybrid escalations through admission before creating followup work', async () => {
		taskContext = {
			task: {
				id: 'task-4',
				workDayId: 'workday-1',
				agentId: 'engineer',
				type: 'agent_trigger',
				priority: 42,
				payloadJson: JSON.stringify({
					executionKind: 'agent_trigger',
					agentSlug: 'engineer',
					hybridExecutionPlan: {
						planId: 'hybrid-1',
						phases: [
							{ kind: 'implementation', executionProfileId: 'standard-code-model' },
							{ kind: 'review', executionProfileId: 'cheap-review-model', mutationAllowed: false },
						],
					},
				}),
			},
			agent: { slug: 'engineer' },
		};
		runAgentMock.mockResolvedValue({
			status: 'completed',
			summary: 'Patch created, but reviewer confidence is low.',
			confidence: 'low',
			insufficientConfidence: true,
		});
		queue.pull.mockResolvedValue({
			messages: [{
				body: { taskId: 'task-4', workDayId: 'workday-1' },
				attempts: 1,
				leaseId: 'lease-4',
			}],
		});

		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		const result = await runWorkerCycle();

		expect(result).toMatchObject({ ok: true, processed: 1 });
		expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
			type: 'hybrid_escalation',
			state: 'pending',
			parentTaskId: 'task-4',
			payload: expect.objectContaining({
				taskSignature: 'review.verify',
				executionProfileId: 'cheap-review-model',
				taskClassification: expect.objectContaining({
					taskSignature: 'review.verify',
				}),
				taskAdmission: expect.objectContaining({
					outcome: 'admitted',
				}),
				capacityEnvelope: expect.objectContaining({
					metadata: expect.objectContaining({
						admissionOutcome: 'admitted',
					}),
				}),
			}),
		}));
		expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-followup',
			appendEvent: expect.objectContaining({ kind: 'classified' }),
		}));
		expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-followup',
			appendEvent: expect.objectContaining({ kind: 'admission_decided' }),
		}));
		expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
			id: 'task-4',
			appendEvent: expect.objectContaining({
				kind: 'hybrid_escalation_created',
				data: expect.objectContaining({ admissionOutcome: 'admitted' }),
			}),
		}));
		expect(queue.ack).toHaveBeenCalledWith(['lease-4']);
	});
});
