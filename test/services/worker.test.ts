import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDraft } from '../../src/agents/contracts/knowledge.ts';

function docsDraft(): KnowledgeDraft {
	return {
		id: 'knowledge:worker',
		kind: 'knowledge_draft',
		title: 'Worker Docs',
		book: 'architecture',
		section: 'runtime',
		targetPath: 'src/content/knowledge/architecture/runtime/worker-docs.mdx',
		state: 'draft',
		sourceQuestionId: 'question:worker',
		sourceResearchIds: ['research:worker'],
		frontmatter: {
			type: 'architecture',
			title: 'Worker Docs',
			summary: 'Worker docs.',
			status: 'pending_review',
			generated_by: 'treeseed-agent',
			agent_role: 'knowledge_generator',
			source_question: 'question:worker',
			source_research: ['research:worker'],
			review_state: 'pending_review',
			book_target: 'architecture',
			section_target: 'runtime',
			confidence: 'medium',
			source_map: [{
				claim: 'Worker executes tasks.',
				sourceFiles: ['packages/agent/src/services/worker.ts'],
				sourceSymbolsOrSections: ['executeResearchKnowledgeTask'],
				evidenceStrength: 'direct',
				uncertainty: '',
				lastObservedRef: 'graph-1',
			}],
			updated: '2026-05-13',
			related: { objectives: [], questions: ['question:worker'], proposals: [], decisions: [] },
		},
		body: [
			'# Worker Docs',
			'',
			'## What this explains',
			'Worker docs.',
			'',
			'## Current implementation',
			'Worker executes tasks.',
			'',
			'## Main flow',
			'Task is claimed and executed.',
			'',
			'## Important files',
			'- packages/agent/src/services/worker.ts',
			'',
			'## Source map',
			'- Worker executes tasks. (packages/agent/src/services/worker.ts)',
			'',
			'## Governance and safety boundaries',
			'Promotion is approval gated.',
			'',
			'## Open questions',
			'- None recorded.',
			'',
			'## Verification notes',
			'Run tests.',
		].join('\n'),
		reviewState: 'pending_review',
		createdAt: '2026-05-13T00:00:00.000Z',
		updatedAt: '2026-05-13T00:00:00.000Z',
	};
}

function fakeMutationWorktrees(changedPaths = ['docs/worker.md']) {
	return {
		plannedWorktreePath: vi.fn(() => '/tmp/treeseed/.agent-worktrees/docs-mutation'),
		createOrResumeWorktree: vi.fn(async () => ({ branchName: 'agent/docs-mutation/task-1', worktreeRoot: '/tmp/treeseed/.agent-worktrees/docs-mutation', created: true })),
		inspectChangedPaths: vi.fn(async () => changedPaths),
		assertChangedPathsAllowed: vi.fn(),
		saveSnapshot: vi.fn(async (snapshot) => ({
			kind: snapshot.kind,
			ref: `/tmp/${snapshot.kind}.json`,
			summary: snapshot.summary,
			changedPaths: snapshot.changedPaths,
			createdAt: '2026-05-13T00:00:00.000Z',
		})),
		stageAndCommit: vi.fn(async () => 'feature-sha'),
		mergeToStaging: vi.fn(async () => ({ status: 'completed', mergedToStaging: true, commitSha: 'staging-sha' })),
	};
}

const sdk = {
	scopeForAgent: vi.fn(function scopeForAgent() {
		return sdk;
	}),
	searchTasks: vi.fn(),
	claimTask: vi.fn(),
	createTask: vi.fn(),
	recordTaskProgress: vi.fn(),
	appendTaskEvent: vi.fn(),
	createMessage: vi.fn(),
	completeTask: vi.fn(),
	failTask: vi.fn(),
	recordWorkerRunner: vi.fn(),
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
const resolveServiceRepoRootMock = vi.hoisted(() => vi.fn(() => '/tmp/treeseed'));

vi.mock('@treeseed/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@treeseed/sdk')>();
	return {
		...actual,
		createControlPlaneReporter: vi.fn(() => reporter),
	};
});

vi.mock('../../src/services/common.ts', () => ({
	buildTaskContext: vi.fn(async () => taskContext),
	createServiceSdk: vi.fn(() => sdk),
	resolveServiceRepoRoot: resolveServiceRepoRootMock,
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
		sdk.searchTasks.mockResolvedValue({ payload: [] });
		sdk.claimTask.mockResolvedValue({ payload: { id: 'task-1' } });
		sdk.createTask.mockResolvedValue({ payload: { id: 'task-followup' } });
		sdk.recordTaskProgress.mockResolvedValue({ payload: { id: 'task-1', state: 'running' } });
		sdk.appendTaskEvent.mockResolvedValue({ payload: { id: 'event-1' } });
		sdk.createMessage.mockResolvedValue({ payload: { id: 1 } });
		sdk.completeTask.mockResolvedValue({ payload: { id: 'task-1', state: 'completed' } });
		sdk.failTask.mockResolvedValue({ payload: { id: 'task-1', state: 'failed' } });
		sdk.recordWorkerRunner.mockResolvedValue({ payload: { id: 'runner-1' } });
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
		resolveServiceRepoRootMock.mockReturnValue('/tmp/treeseed');
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
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'task-1', attemptCount: 0 }] });

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
	}, 60_000);

	it('executes codebase documentation scanner tasks and emits capped gap messages', async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-worker-scan-'));
		try {
			mkdirSync(join(repoRoot, 'packages/agent/src/services'), { recursive: true });
			writeFileSync(join(repoRoot, 'packages/agent/src/services/worker.ts'), 'export function workerLoop() { return true; }\n', 'utf8');
			writeFileSync(join(repoRoot, 'packages/agent/src/services/manager.ts'), 'export function managerLoop() { return true; }\n', 'utf8');
			mkdirSync(join(repoRoot, 'packages/agent/src/agents'), { recursive: true });
			writeFileSync(join(repoRoot, 'packages/agent/src/agents/registry.ts'), 'export const registry = new Map();\n', 'utf8');
			resolveServiceRepoRootMock.mockReturnValue(repoRoot);
			taskContext = {
				task: {
					id: 'scan-1',
					workDayId: 'workday-1',
					agentId: 'treeseed-codebase-cartographer',
					type: 'scan_codebase_documentation_surface',
					graphVersion: 'graph-1',
					payloadJson: JSON.stringify({
						executionKind: 'codebase_documentation_scan',
						maxKnowledgeGapMessages: 1,
					}),
				},
				agent: { slug: 'treeseed-codebase-cartographer' },
			};
			sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'scan-1', workDayId: 'workday-1', attemptCount: 0 }] });

			const { runWorkerCycle } = await import('../../src/services/worker.ts');
			const result = await runWorkerCycle();

			expect(result).toMatchObject({ ok: true, processed: 1 });
			expect(sdk.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
				taskId: 'scan-1',
				kind: 'codebase_inventory_completed',
				data: expect.objectContaining({
					knowledgeGapCount: expect.any(Number),
					emittedGapMessages: 1,
				}),
			}));
			expect(sdk.createMessage).toHaveBeenCalledTimes(1);
			expect(sdk.createMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'knowledge_gap_detected',
				payload: expect.objectContaining({
					recommendedTaskKind: 'research_code_surface',
					sourcePaths: expect.any(Array),
				}),
				relatedModel: 'codebase_inventory',
			}));
			expect(sdk.completeTask).toHaveBeenCalledWith(expect.objectContaining({
				id: 'scan-1',
				output: expect.objectContaining({
					artifactKind: 'codebase_inventory',
					codebaseInventory: expect.objectContaining({ kind: 'codebase_inventory' }),
					generatedArtifacts: [expect.objectContaining({ artifactKind: 'codebase_inventory' })],
				}),
			}));
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
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

	it('records worker runner heartbeat state during idle and active cycles', async () => {
		const { runWorkerCycle } = await import('../../src/services/worker.ts');

		await runWorkerCycle();
		expect(sdk.recordWorkerRunner).toHaveBeenCalledWith(expect.objectContaining({
			runnerId: 'worker-test',
			state: 'active',
			activeLocalWorkers: 0,
			metadata: expect.objectContaining({ phase: 'polling' }),
		}));
		expect(sdk.recordWorkerRunner).toHaveBeenCalledWith(expect.objectContaining({
			runnerId: 'worker-test',
			state: 'idle',
			activeLocalWorkers: 0,
			metadata: expect.objectContaining({ phase: 'idle' }),
		}));

		sdk.recordWorkerRunner.mockClear();
		taskContext = {
			task: {
				id: 'task-heartbeat',
				workDayId: 'workday-1',
				agentId: 'workflow-dispatch',
				payloadJson: JSON.stringify({
					executionKind: 'workflow_dispatch',
					namespace: 'workflow',
					operation: 'verify',
				}),
			},
			agent: null,
		};
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'task-heartbeat', workDayId: 'workday-1', attemptCount: 0 }] });

		await runWorkerCycle();
		expect(sdk.recordWorkerRunner).toHaveBeenCalledWith(expect.objectContaining({
			state: 'active',
			activeLocalWorkers: 1,
			metadata: expect.objectContaining({ phase: 'processing', selectedMessageCount: 1 }),
		}));
		expect(sdk.recordWorkerRunner).toHaveBeenCalledWith(expect.objectContaining({
			state: 'idle',
			activeLocalWorkers: 0,
			metadata: expect.objectContaining({ phase: 'cycle_complete', processed: 1 }),
		}));
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
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'task-2', attemptCount: 1 }] });

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
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'planning-1', workDayId: 'workday-1', attemptCount: 0 }] });

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
	});

	it('creates a visible repair task when approved deterministic docs promotion fails verification', async () => {
		const { executeResearchKnowledgeTask } = await import('../../src/services/worker.ts');
		const draft = docsDraft();
		const output = await executeResearchKnowledgeTask({
			sdk: sdk as any,
			task: {
				id: 'task-promote',
				workDayId: 'workday-1',
				type: 'promote_knowledge_to_staging',
				graphVersion: 'graph-1',
				payloadJson: JSON.stringify({
					taskKind: 'promote_knowledge_to_staging',
					projectId: 'project-1',
					environment: 'local',
					knowledgeDraft: draft,
					approvalDecision: {
						approvalId: 'promotion:worker',
						decision: 'approve_as_book_content',
						actor: 'user-1',
					},
					allowedPaths: [draft.targetPath],
					forbiddenPaths: [],
					verificationCommands: ['npm run test:unit'],
				}),
			},
			taskKind: 'promote_knowledge_to_staging',
			workerId: 'worker-test',
			queueAttempt: 1,
			promotionDependencies: {
				worktrees: {
					plannedWorktreePath: vi.fn(() => '/tmp/promotion'),
					createOrResumeWorktree: vi.fn(async () => ({ branchName: 'agent/knowledge-promotion/task-promote', worktreeRoot: '/tmp/promotion', created: true })),
					inspectChangedPaths: vi.fn(async () => [draft.targetPath]),
					assertChangedPathsAllowed: vi.fn(),
					saveSnapshot: vi.fn(async (snapshot) => ({
						kind: snapshot.kind,
						ref: `/tmp/${snapshot.kind}.json`,
						summary: snapshot.summary,
						changedPaths: snapshot.changedPaths,
						createdAt: '2026-05-13T00:00:00.000Z',
					})),
					stageAndCommit: vi.fn(),
					mergeToStaging: vi.fn(),
				} as any,
				verify: vi.fn(async () => ({ ok: false, summary: 'links failed', commandsRun: ['npm run test:unit'], errors: ['links failed'] })),
			},
		});

		expect(output).toMatchObject({
			artifactKind: 'docs_mutation_result',
			summary: { status: 'failed', summary: 'links failed' },
			nextTaskId: 'task-followup',
			repairTask: expect.objectContaining({
				kind: 'knowledge_promotion_verification_repair',
				taskId: 'task-followup',
			}),
		});
		expect(output.generatedArtifacts).toEqual([expect.objectContaining({
			artifactKind: 'docs_mutation_result',
			id: 'task-promote',
			verificationStatus: 'failed',
		})]);
		expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
			type: 'create_repair_task',
			idempotencyKey: 'workday-1:create_repair_task:verification:task-promote',
			payload: expect.objectContaining({
				repairTask: expect.objectContaining({
					kind: 'knowledge_promotion_verification_repair',
					failedCommands: ['npm run test:unit'],
				}),
			}),
			state: 'waiting',
		}));
	});

	it('delegates approved docs mutation tasks to the existing Codex docs lifecycle', async () => {
		const { executeResearchKnowledgeTask } = await import('../../src/services/worker.ts');
		const operationGrants = [{
			id: 'grant-docs-mutation',
			state: 'active',
			operations: ['switch', 'dev', 'verify', 'save', 'stage', 'merge_to_staging', 'close'],
			modes: ['dry_run', 'read_only', 'mutating'],
			agentRoles: ['engineer'],
			taskKinds: ['apply_approved_docs_mutation'],
			projectIds: ['project-1'],
			environments: ['local'],
			allowedPaths: ['docs/**'],
			forbiddenPaths: [],
		}];
		const output = await executeResearchKnowledgeTask({
			sdk: sdk as any,
			task: {
				id: 'task-docs-mutation',
				workDayId: 'workday-1',
				type: 'apply_approved_docs_mutation',
				graphVersion: 'graph-1',
				payloadJson: JSON.stringify({
					provider: 'codex',
					projectId: 'project-1',
					environment: 'local',
					agentRole: 'engineer',
					goal: 'Update docs/worker.md',
					featureBranch: 'agent/docs-mutation/task-docs-mutation',
					approval: { id: 'approval:docs', kind: 'apply_docs_mutation', state: 'approved' },
					allowedPaths: ['docs/**'],
					forbiddenPaths: [],
					verificationCommands: ['npm run test:unit'],
					operationGrants,
				}),
			},
			taskKind: 'apply_approved_docs_mutation',
			workerId: 'worker-test',
			queueAttempt: 1,
			docsMutationDependencies: {
				worktrees: fakeMutationWorktrees(['docs/worker.md']) as any,
				runCodexTask: vi.fn(async () => ({
					provider: 'codex',
					status: 'completed',
					summary: 'Codex updated docs.',
					changedPaths: ['docs/worker.md'],
					usage: {},
				})),
				verification: {
					runChecks: vi.fn(async () => ({
						status: 'completed',
						summary: 'Verification passed.',
						stdout: '',
						stderr: '',
					})),
				},
			},
		});

		expect(output).toMatchObject({
			artifactKind: 'docs_mutation_result',
			summary: {
				status: 'completed',
				summary: 'Codex docs mutation task-docs-mutation merged to staging.',
			},
			docsMutationResult: expect.objectContaining({
				status: 'staged',
				changedPaths: ['docs/worker.md'],
				mergedToStaging: true,
			}),
		});
		expect(output.generatedArtifacts).toEqual([expect.objectContaining({
			artifactKind: 'docs_mutation_result',
			id: 'task-docs-mutation',
			mergedToStaging: true,
		})]);
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
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'task-3', workDayId: 'workday-1', attemptCount: 0 }] });

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
		sdk.searchTasks.mockResolvedValueOnce({ payload: [{ id: 'task-4', workDayId: 'workday-1', attemptCount: 0 }] });

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
	});
});
