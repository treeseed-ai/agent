import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	extractGeneratedArtifactsFromTaskOutputs,
	seedResearchKnowledgeWorkdayTasks,
} from '../../src/services/research-knowledge-workday.ts';
import {
	buildKnowledgeDraft,
	TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS,
} from '../../src/agents/knowledge/pipeline.ts';
import type { ResearchNote } from '../../src/agents/contracts/research.ts';
import { writeWorkdayContentSnapshot } from '../../src/services/workday-content.ts';

const tasks: Array<Record<string, unknown>> = [];
const taskOutputs: unknown[] = [];
const taskOutputRecords: Array<Record<string, unknown>> = [];
const approvalRequests: Array<Record<string, unknown>> = [];
const inboxItems: Array<Record<string, unknown>> = [];
const WORKDAY_ORCHESTRATION_TEST_TIMEOUT_MS = 30_000;

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
		taskOutputRecords.push({
			id: `output-${taskOutputRecords.length + 1}`,
			taskId: request.id,
			outputJson: JSON.stringify(request.output),
			createdAt: '2026-05-13T12:00:00.000Z',
		});
		return { payload: { id: request.id, state: 'completed' } };
	}),
	failTask: vi.fn(async () => ({ payload: {} })),
	searchTasks: vi.fn(async () => ({ payload: tasks })),
	search: vi.fn(async (request) => {
		if (request.model === 'task_output') {
			const inFilter = request.filters?.find((filter: Record<string, unknown>) => filter.field === 'task_id');
			const ids = Array.isArray(inFilter?.value) ? inFilter.value.map(String) : [];
			return { payload: taskOutputRecords.filter((output) => !ids.length || ids.includes(String(output.taskId))) };
		}
		return { payload: [] };
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
	createApprovalRequest: vi.fn(async (request) => {
		const existing = approvalRequests.find((approval) => approval.id === request.id);
		if (existing) return { payload: existing };
		const approval = {
			id: request.id,
			teamId: request.teamId,
			projectId: request.projectId,
			workDayId: request.workDayId,
			taskId: request.taskId,
			kind: request.kind,
			state: 'pending',
			severity: request.severity ?? 'medium',
			title: request.title,
			summary: request.summary,
			options: request.options ?? [],
			recommendation: request.recommendation ?? {},
			policySnapshot: request.policySnapshot ?? {},
			metadata: request.metadata ?? {},
			createdAt: '2026-05-13T12:00:00.000Z',
			updatedAt: '2026-05-13T12:00:00.000Z',
		};
		approvalRequests.push(approval);
		return { payload: approval };
	}),
	upsertTeamInboxItem: vi.fn(async (request) => {
		const item = {
			id: request.id,
			teamId: request.teamId,
			projectId: request.projectId,
			kind: request.kind,
			state: request.state,
			title: request.title,
			summary: request.summary ?? null,
			href: request.href ?? null,
			itemKey: request.itemKey ?? null,
			metadata: request.metadata ?? {},
			createdAt: '2026-05-13T12:00:00.000Z',
			updatedAt: '2026-05-13T12:00:00.000Z',
		};
		inboxItems.push(item);
		return { payload: item };
	}),
	scopeForAgent: vi.fn(function scopeForAgent() {
		return this;
	}),
};

function sourceMappedResearchNote(overrides: Partial<ResearchNote> = {}): ResearchNote {
	return {
		id: 'research:runtime-v1',
		kind: 'research_note',
		questionId: 'question:treeseed-agent-runtime-workday',
		state: 'draft',
		contextQueries: [{
			id: 'runtime',
			purpose: 'research',
			source: 'task_payload',
			includedNodeIds: ['node:runtime'],
			warnings: [],
		}],
		contextPackSummary: 'Runtime source context.',
		sourceRefs: [{
			ref: 'packages/agent/src/services/worker.ts',
			kind: 'path',
			title: 'Worker Service',
		}],
		sourceMap: [{
			claim: 'The worker executes claimed tasks.',
			sourceFiles: ['packages/agent/src/services/worker.ts'],
			sourceSymbolsOrSections: ['runWorkerCycle'],
			evidenceStrength: 'direct',
			uncertainty: '',
			lastObservedRef: 'graph-1',
		}],
		observedFacts: ['The worker executes claimed tasks.'],
		inferences: [{
			statement: 'The workday flow moves from queue claim to handler execution.',
			sourceRefs: ['packages/agent/src/services/worker.ts'],
			confidence: 'medium',
		}],
		uncertainties: [{
			statement: 'Human review should confirm the source map before promotion.',
			impact: 'medium',
		}],
		recommendedKnowledgeArtifacts: ['knowledge:agent-runtime-workday'],
		recommendedImplementationProposal: null,
		createdAt: '2026-05-13T12:00:00.000Z',
		...overrides,
	};
}

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
		taskOutputRecords.splice(0);
		approvalRequests.splice(0);
		inboxItems.splice(0);
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
		expect(approvalRequests).toEqual([expect.objectContaining({
			id: expect.stringContaining('promotion:knowledge:'),
			kind: 'promote_knowledge_draft',
			state: 'pending',
			taskId: promotionTask?.id,
			metadata: expect.objectContaining({
				approvalKind: 'promote_knowledge_draft',
				sourceMapRefs: expect.any(Array),
				artifactRefs: expect.any(Array),
			}),
		})]);
		expect(inboxItems).toEqual([expect.objectContaining({
			kind: 'approval_required',
			state: 'waiting_for_approval',
			metadata: expect.objectContaining({ approvalKind: 'promote_knowledge_draft' }),
		})]);
		expect(sdk.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
			taskId: optimizeTask?.id,
			kind: 'approval_request_created',
		}));
		expect(sdk.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
			taskId: optimizeTask?.id,
			kind: 'team_inbox_item_created',
		}));

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
	}, WORKDAY_ORCHESTRATION_TEST_TIMEOUT_MS);

	it('creates a revision draft task when optimization recommends revise', async () => {
		const [question] = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS;
		const note = sourceMappedResearchNote({
			sourceMap: [{
				claim: 'Runtime evidence needs a concrete source file.',
				sourceFiles: [],
				sourceSymbolsOrSections: ['runWorkerCycle'],
				evidenceStrength: 'supporting',
				uncertainty: 'The source file was not captured by the scanner artifact.',
				lastObservedRef: 'graph-1',
			}],
		});
		const draft = buildKnowledgeDraft({
			question,
			note,
			today: '2026-05-13',
			nowIso: '2026-05-13T12:00:00.000Z',
			state: 'draft',
		});
		const task = await sdk.createTask({
			workDayId: 'workday-1',
			agentId: 'knowledge-optimizer-agent',
			type: 'optimize_knowledge_draft',
			priority: 85,
			idempotencyKey: 'workday-1:optimize_knowledge_draft:test-revise',
			payload: {
				executionKind: 'research_knowledge_pipeline',
				researchNote: note,
				knowledgeDraft: draft,
				question,
				taskKind: 'optimize_knowledge_draft',
			},
			graphVersion: 'graph-1',
		});
		const { runWorkerCycle } = await import('../../src/services/worker.ts');

		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: task.payload.id }, attempts: 1, leaseId: 'lease-revise' }],
		});
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });

		const revisionTask = tasks.find((candidate) =>
			candidate.type === 'generate_knowledge_draft'
			&& String(candidate.idempotencyKey).startsWith('workday-1:generate_knowledge_draft_revision:optimization:'),
		);
		expect(revisionTask).toBeTruthy();
		expect(JSON.parse(String(revisionTask?.payloadJson))).toMatchObject({
			taskKind: 'generate_knowledge_draft',
			revisionOfDraftId: draft.id,
			previousKnowledgeDraft: { id: draft.id },
			optimizationReport: {
				recommendation: 'revise',
				remainingIssues: expect.arrayContaining(['Source map is incomplete.']),
			},
		});
		expect(tasks.find((candidate) => candidate.type === 'promote_knowledge_draft_request')).toBeUndefined();
		expect(taskOutputs[0]).toMatchObject({
			artifactKind: 'optimization_report',
			optimizationReport: { recommendation: 'revise' },
			nextTaskId: revisionTask?.id,
		});
		expect(pushQueue.enqueue).toHaveBeenCalledTimes(1);
	}, WORKDAY_ORCHESTRATION_TEST_TIMEOUT_MS);

	it('does not create promotion followups for defer or reject optimization decisions', async () => {
		const [question] = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS;
		const inferredNote = sourceMappedResearchNote({
			id: 'research:runtime-inferred-v1',
			sourceMap: [{
				claim: 'Runtime flow could not be directly verified.',
				sourceFiles: ['packages/agent/src/services/worker.ts'],
				sourceSymbolsOrSections: [],
				evidenceStrength: 'inferred',
				uncertainty: 'Only inferred evidence was available.',
				lastObservedRef: 'graph-1',
			}],
			observedFacts: ['Runtime flow could not be directly verified.'],
		});
		const inferredDraft = buildKnowledgeDraft({
			question,
			note: inferredNote,
			today: '2026-05-13',
			nowIso: '2026-05-13T12:00:00.000Z',
			state: 'draft',
		});
		const rejectNote = sourceMappedResearchNote({
			id: 'research:runtime-unsupported-v1',
			observedFacts: ['Unsupported core claim: the worker releases docs without approval.'],
		});
		const rejectDraft = buildKnowledgeDraft({
			question,
			note: rejectNote,
			today: '2026-05-13',
			nowIso: '2026-05-13T12:00:00.000Z',
			state: 'draft',
		});
		const deferTask = await sdk.createTask({
			workDayId: 'workday-1',
			agentId: 'knowledge-optimizer-agent',
			type: 'optimize_knowledge_draft',
			priority: 85,
			idempotencyKey: 'workday-1:optimize_knowledge_draft:test-defer',
			payload: {
				executionKind: 'research_knowledge_pipeline',
				researchNote: inferredNote,
				knowledgeDraft: inferredDraft,
				question,
				taskKind: 'optimize_knowledge_draft',
			},
			graphVersion: 'graph-1',
		});
		const rejectTask = await sdk.createTask({
			workDayId: 'workday-1',
			agentId: 'knowledge-optimizer-agent',
			type: 'optimize_knowledge_draft',
			priority: 85,
			idempotencyKey: 'workday-1:optimize_knowledge_draft:test-reject',
			payload: {
				executionKind: 'research_knowledge_pipeline',
				researchNote: rejectNote,
				knowledgeDraft: rejectDraft,
				question,
				taskKind: 'optimize_knowledge_draft',
			},
			graphVersion: 'graph-1',
		});
		const { runWorkerCycle } = await import('../../src/services/worker.ts');

		pullQueue.pull
			.mockResolvedValueOnce({ messages: [{ body: { taskId: deferTask.payload.id }, attempts: 1, leaseId: 'lease-defer' }] })
			.mockResolvedValueOnce({ messages: [{ body: { taskId: rejectTask.payload.id }, attempts: 1, leaseId: 'lease-reject' }] });
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });
		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });

		expect(taskOutputs.map((output) => (output as any).optimizationReport?.recommendation)).toEqual(['defer', 'reject']);
		expect(tasks.filter((candidate) => candidate.type === 'promote_knowledge_draft_request')).toHaveLength(0);
		expect(tasks.filter((candidate) => candidate.type === 'generate_knowledge_draft')).toHaveLength(0);
		expect(pushQueue.enqueue).not.toHaveBeenCalled();
	}, WORKDAY_ORCHESTRATION_TEST_TIMEOUT_MS);

	it('loads latest codebase inventory into research question context', async () => {
		const scanTask = await sdk.createTask({
			workDayId: 'workday-1',
			agentId: 'treeseed-codebase-cartographer',
			type: 'scan_codebase_documentation_surface',
			priority: 100,
			idempotencyKey: 'workday-1:scan_codebase_documentation_surface',
			payload: {},
			graphVersion: 'graph-1',
		});
		taskOutputRecords.push({
			id: 'scan-output-1',
			taskId: scanTask.payload.id,
			outputJson: JSON.stringify({
				artifactKind: 'codebase_inventory',
				codebaseInventory: {
					id: 'codebase_inventory:test',
					kind: 'codebase_inventory',
					title: 'Test Inventory',
					generatedAt: '2026-05-13T12:00:00.000Z',
					graphVersion: 'graph-1',
					repoRef: 'commit-test',
					scanTargets: [],
					ignoredPatterns: [],
					packages: [{
						name: 'agent',
						purpose: 'Agent runtime.',
						root: 'packages/agent',
						entrypoints: ['packages/agent/src/index.ts'],
						publicExports: ['AgentKernel'],
						commands: [],
						runtimeServices: [],
						moduleCount: 1,
						fileCount: 1,
						tests: [],
						relatedDocs: [],
						knownGaps: [],
						modules: [],
						warnings: [],
					}],
					modules: [{
						path: 'packages/agent/src/services',
						packageName: 'agent',
						responsibility: 'Worker and manager services.',
						fileCount: 1,
						importantFiles: ['packages/agent/src/services/worker.ts'],
						exportedSymbols: ['runWorkerCycle'],
						imports: ['@treeseed/sdk'],
						tests: [],
						relatedDocs: [],
						warnings: [],
					}],
					knowledgeGaps: [],
					warnings: [],
				},
			}),
			createdAt: '2026-05-13T12:00:00.000Z',
		});
		const question = {
			...TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS[0],
			contextQueries: [{
				id: 'worker-code',
				purpose: 'research',
				query: 'worker service',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/services'],
				required: true,
			}],
		};
		const [researchTask] = await seedResearchKnowledgeWorkdayTasks({
			sdk,
			workDay: { id: 'workday-1', graphVersion: 'graph-1' },
			projectId: 'project-1',
			graphVersion: 'graph-1',
			questions: [question],
		});
		const { runWorkerCycle } = await import('../../src/services/worker.ts');
		pullQueue.pull.mockResolvedValueOnce({
			messages: [{ body: { taskId: researchTask.id }, attempts: 1, leaseId: 'lease-code' }],
		});

		await expect(runWorkerCycle()).resolves.toMatchObject({ ok: true, processed: 1 });

		expect(taskOutputs[0]).toMatchObject({
			artifactKind: 'research_note',
			researchNote: {
				sourceRefs: expect.arrayContaining([
					expect.objectContaining({ ref: 'packages/agent/src/services/worker.ts' }),
				]),
				sourceMap: expect.arrayContaining([
					expect.objectContaining({
						sourceFiles: expect.arrayContaining(['packages/agent/src/services/worker.ts']),
						sourceSymbolsOrSections: expect.arrayContaining(['runWorkerCycle']),
						evidenceStrength: 'direct',
						lastObservedRef: 'commit-test',
					}),
				]),
			},
			nextTaskId: expect.any(String),
		});
		const generateTask = tasks.find((task) => task.type === 'generate_knowledge_draft');
		expect(generateTask).toBeTruthy();
	}, WORKDAY_ORCHESTRATION_TEST_TIMEOUT_MS);

	it('extracts codebase inventory generated artifacts from task outputs', () => {
		const artifacts = extractGeneratedArtifactsFromTaskOutputs([{
			taskId: 'scan-1',
			artifactKind: 'codebase_inventory',
			codebaseInventory: {
				id: 'codebase_inventory:2026-05-14',
				kind: 'codebase_inventory',
				title: 'TreeSeed Codebase Documentation Surface Inventory',
				generatedAt: '2026-05-14T12:00:00.000Z',
				graphVersion: 'graph-1',
				repoRef: 'local',
				scanTargets: [],
				ignoredPatterns: [],
				packages: [],
				modules: [{
					path: 'packages/agent/src/services',
					importantFiles: ['packages/agent/src/services/worker.ts'],
				}],
				knowledgeGaps: [],
				warnings: [],
			},
			generatedArtifacts: [],
		}]);

		expect(artifacts).toEqual([
			expect.objectContaining({
				artifactKind: 'codebase_inventory',
				id: 'codebase_inventory:2026-05-14',
				taskId: 'scan-1',
				sourceRefs: ['packages/agent/src/services/worker.ts'],
			}),
		]);
	});

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
				}, {
					artifactKind: 'promotion_request',
					id: 'promotion:runtime',
					approvalKind: 'promote_knowledge_draft',
					draftId: 'knowledge:runtime',
					targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
					recommendation: 'promote',
				}, {
					artifactKind: 'docs_mutation_result',
					id: 'mutation:runtime',
					draftId: 'knowledge:runtime',
					targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
					changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
					verificationStatus: 'failed',
					repairTaskId: 'repair:runtime',
				}],
				repairTasks: [{ id: 'repair:runtime', kind: 'knowledge_promotion_verification_repair', targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx' }],
				releases: [],
				generatedAt: '2026-05-13T12:00:00.000Z',
			});
			const document = readFileSync(join(repoRoot, result.relativePath), 'utf8');
			expect(result.status).toBe('failed');
			expect(result.docsAutomation).toMatchObject({
				knowledgeDraftCount: 1,
				promotionRequestCount: 1,
				docsMutationCount: 1,
				verificationFailureCount: 2,
				repairTaskCount: 1,
			});
			expect(document).toContain('id: workday:workday-1');
			expect(document).toContain('title: TreeSeed Documentation Automation Workday - 2026-05-13');
			expect(document).toContain('status: failed');
			expect(document).toContain('work_day_id: workday-1');
			expect(document).toContain('generated_by: treeseed-agent');
			expect(document).toContain('updated: 2026-05-13');
			expect(document).toContain('# Summary');
			expect(document).toContain('## What agents analyzed');
			expect(document).toContain('## Knowledge created');
			expect(document).toContain('## Drafts pending review');
			expect(document).toContain('## Approved changes');
			expect(document).toContain('## Verification outcomes');
			expect(document).toContain('## Governance decisions');
			expect(document).toContain('## Open questions');
			expect(document).toContain('## Next workday recommendations');
			expect(document).toContain('## Generated Artifacts');
			expect(document).toContain('## Operation Events');
			expect(document).toContain('## Worktree Snapshots');
			expect(document).toContain('## Staging And Release');
			expect(document).toContain('## Repair Tasks');
			expect(document).toContain('Runtime Knowledge');
			expect(document).toContain('promotion:runtime');
			expect(document).toContain('mutation:runtime');
			expect(document).toContain('knowledge_promotion_verification_repair');
			expect(document).toContain('generatedArtifacts:');
			expect(document).toContain('operationEvents:');
			expect(document).toContain('linkedArtifacts:');
			expect(document).toContain('linkedApprovals:');
			expect(document).toContain('linkedMutations:');
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
