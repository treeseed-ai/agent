import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = {
	claimTask: vi.fn(),
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

vi.mock('../../src/services/common.ts', () => ({
	buildTaskContext: vi.fn(async () => taskContext),
	createQueueClient: vi.fn(() => queue),
	createServiceSdk: vi.fn(() => sdk),
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
	});

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
});
