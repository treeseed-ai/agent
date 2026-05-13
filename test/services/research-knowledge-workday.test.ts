import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	extractGeneratedArtifactsFromTaskOutputs,
	seedResearchKnowledgeWorkdayTasks,
} from '../../src/services/research-knowledge-workday.ts';
import { TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS } from '../../src/agents/knowledge/pipeline.ts';
import { writeWorkdayContentSnapshot } from '../../src/services/workday-content.ts';

const tasks: Array<Record<string, unknown>> = [];
const taskOutputs: unknown[] = [];

const pullQueue = {
	pull: vi.fn(),
	ack: vi.fn(async () => undefined),
	retry: vi.fn(async () => undefined),
};

const pushQueue = {
	enqueue: vi.fn(async () => undefined),
};

const sdk = {
	claimTask: vi.fn(async () => ({ payload: {} })),
	recordTaskProgress: vi.fn(async () => ({ payload: {} })),
	completeTask: vi.fn(async (request) => {
		taskOutputs.push(request.output);
		return { payload: { id: request.id, state: 'completed' } };
	}),
	failTask: vi.fn(async () => ({ payload: {} })),
	searchTasks: vi.fn(async () => ({ payload: tasks })),
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
		};
		tasks.push(task);
		return { payload: task };
	}),
	recordTaskCredits: vi.fn(async () => ({ payload: {} })),
	buildContextPack: vi.fn(async () => ({
		seedIds: ['node:runtime'],
		totalTokenEstimate: 40,
		includedNodeIds: ['node:runtime'],
		nodes: [{
			node: {
				id: 'node:runtime',
				title: 'Agent Runtime',
				data: { relativePath: 'packages/agent/src/agents/kernel/agent-kernel.ts' },
			},
		}],
		edges: [],
	})),
	createMessage: vi.fn(async () => ({ payload: {} })),
	appendTaskEvent: vi.fn(async () => ({ payload: {} })),
	scopeForAgent: vi.fn(function scopeForAgent() {
		return this;
	}),
};

vi.mock('../../src/services/common.ts', () => ({
	buildTaskContext: vi.fn(async (_sdk, taskId: string) => ({
		task: tasks.find((task) => task.id === taskId) ?? null,
		agent: null,
	})),
	createQueueClient: vi.fn(() => pullQueue),
	createQueuePushClient: vi.fn(() => pushQueue),
	createServiceSdk: vi.fn(() => sdk),
	queueEnvelopeForTask: vi.fn((task) => ({
		messageId: `message-${task.id}`,
		taskId: task.id,
		workDayId: task.workDayId,
		agentId: task.agentId,
		taskType: task.type,
		idempotencyKey: task.idempotencyKey,
		attempt: 1,
		payloadRef: `d1:tasks/${task.id}`,
		graphVersion: task.graphVersion ?? null,
		budgetHint: 1,
	})),
	resolveServiceRepoRoot: vi.fn(() => '/tmp/treeseed'),
	resolveWorkerConfig: vi.fn(() => ({
		workerId: 'worker-test',
		batchSize: 1,
		maxLocalWorkers: 1,
		visibilityTimeoutMs: 1000,
		pollIntervalMs: 1000,
		leaseSeconds: 120,
		volumeRoot: '.treeseed-runner',
		projectId: 'project-1',
		environment: 'local',
		runnerServiceName: 'worker-test',
		volumeIdentity: 'volume-test',
		idleExitMs: 0,
	})),
}));

vi.mock('../../src/agents/kernel/agent-kernel.ts', () => ({
	AgentKernel: class MockAgentKernel {},
}));

describe('research and knowledge workday orchestration', () => {
	beforeEach(() => {
		tasks.splice(0);
		taskOutputs.splice(0);
		vi.clearAllMocks();
		pullQueue.ack.mockResolvedValue(undefined);
		pullQueue.retry.mockResolvedValue(undefined);
		pushQueue.enqueue.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('seeds deterministic research tasks without duplicates', async () => {
		const workDay = { id: 'workday-1', graphVersion: 'graph-1' };

		const first = await seedResearchKnowledgeWorkdayTasks({
			sdk,
			workDay,
			projectId: 'project-1',
			graphVersion: 'graph-1',
		});
		const second = await seedResearchKnowledgeWorkdayTasks({
			sdk,
			workDay,
			projectId: 'project-1',
			graphVersion: 'graph-1',
		});

		expect(first).toHaveLength(TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length);
		expect(second).toHaveLength(0);
		expect(tasks.map((task) => task.type)).toEqual(
			TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map(() => 'research_question'),
		);
		expect(tasks.map((task) => JSON.parse(String(task.payloadJson)).question.targetPath)).toEqual(
			TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.targetPath),
		);
		expect(new Set(tasks.map((task) => task.idempotencyKey)).size).toBe(tasks.length);
	});

	it('runs research -> draft -> optimize and creates a promotion request task', async () => {
		const [question] = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS;
		const [researchTask] = await seedResearchKnowledgeWorkdayTasks({
			sdk,
			workDay: { id: 'workday-1', graphVersion: 'graph-1' },
			projectId: 'project-1',
			graphVersion: 'graph-1',
			questions: [question],
		});
		const { runWorkerCycle } = await import('../../src/services/worker.ts');

		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: researchTask.id }, attempts: 1, leaseId: 'lease-1' }],
		});
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });
		const generateTask = tasks.find((task) => task.type === 'generate_knowledge_draft');
		expect(generateTask).toBeTruthy();
		expect(taskOutputs[0]).toMatchObject({
			artifactKind: 'research_note',
			researchNote: {
				kind: 'research_note',
				contextQueries: [expect.objectContaining({ id: 'runtime-architecture' })],
			},
			generatedArtifacts: [expect.objectContaining({ artifactKind: 'research_note' })],
			nextTaskId: generateTask?.id,
		});

		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: generateTask?.id }, attempts: 1, leaseId: 'lease-2' }],
		});
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });
		const optimizeTask = tasks.find((task) => task.type === 'optimize_knowledge_draft');
		expect(taskOutputs[1]).toMatchObject({
			artifactKind: 'knowledge_draft',
			knowledgeDraft: {
				kind: 'knowledge_draft',
				targetPath: question.targetPath,
			},
			nextTaskId: optimizeTask?.id,
		});

		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: optimizeTask?.id }, attempts: 1, leaseId: 'lease-3' }],
		});
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });
		const promotionTask = tasks.find((task) => task.type === 'promote_knowledge_draft_request');
		expect(promotionTask).toMatchObject({
			state: 'waiting',
		});
		expect(taskOutputs[2]).toMatchObject({
			artifactKind: 'optimization_report',
			optimizationReport: {
				kind: 'knowledge_optimization_report',
				recommendation: 'promote',
			},
			promotionRequest: expect.objectContaining({
				draftId: expect.stringContaining('knowledge:'),
				targetPath: question.targetPath,
			}),
			nextTaskId: promotionTask?.id,
		});

		const artifacts = extractGeneratedArtifactsFromTaskOutputs(taskOutputs);
		expect(artifacts.map((artifact) => artifact.artifactKind)).toEqual(expect.arrayContaining([
			'research_note',
			'knowledge_draft',
			'optimization_report',
			'promotion_request',
		]));
		expect(pushQueue.enqueue).toHaveBeenCalledTimes(2);

		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: promotionTask?.id }, attempts: 1, leaseId: 'lease-4' }],
		});
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });
		expect(taskOutputs[3]).toMatchObject({
			artifactKind: 'promotion_request',
			summary: {
				status: 'waiting',
				summary: 'Knowledge draft promotion is waiting for an approval decision.',
			},
		});
	}, 15_000);

	it('renders generated artifacts into workday content reports', () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-generated-artifacts-report-'));
		try {
			const result = writeWorkdayContentSnapshot({
				repoRoot,
				projectId: 'project-1',
				teamId: 'team-1',
				environment: 'local',
				workDay: { id: 'workday-1', state: 'active', startedAt: '2026-05-13T12:00:00.000Z' },
				summary: {
					summary: 'Generated artifacts were recorded.',
					dailyTaskCreditBudget: 10,
					usedTaskCredits: 3,
					remainingTaskCredits: 7,
					creditLedgerEntries: 3,
				},
				prioritySnapshot: null,
				scaleDecision: {
					projectId: 'project-1',
					environment: 'local',
					poolName: 'pool',
					workDayId: 'workday-1',
					desiredWorkers: 0,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'test',
					metadata: {},
				},
				scaleResult: { applied: false, provider: 'noop', desiredWorkers: 0, metadata: {} },
				tasks: [],
				changedFiles: [],
				generatedArtifacts: [{
					artifactKind: 'knowledge_draft',
					id: 'knowledge:runtime',
					title: 'Runtime Knowledge',
					targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
				}],
				releases: [],
				generatedAt: '2026-05-13T12:00:00.000Z',
			});
			const document = readFileSync(join(repoRoot, result.relativePath), 'utf8');
			expect(document).toContain('## Generated Artifacts');
			expect(document).toContain('## Operation Events');
			expect(document).toContain('## Worktree Snapshots');
			expect(document).toContain('## Staging And Release');
			expect(document).toContain('## Repair Tasks');
			expect(document).toContain('Runtime Knowledge');
			expect(document).toContain('generatedArtifacts:');
			expect(document).toContain('operationEvents:');
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
