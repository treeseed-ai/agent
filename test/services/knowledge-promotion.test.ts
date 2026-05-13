import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDraft } from '../../src/agents/contracts/knowledge.ts';
import {
	defaultReleaseGrant,
	normalizeKnowledgePromotionTaskInput,
	runKnowledgePromotionToStaging,
} from '../../src/services/knowledge-promotion.ts';

function draft(): KnowledgeDraft {
	return {
		id: 'knowledge:runtime',
		kind: 'knowledge_draft',
		title: 'Agent Processing Platform',
		book: 'architecture',
		section: 'runtime',
		targetPath: 'src/content/knowledge/architecture/runtime/agent-processing-platform.mdx',
		state: 'draft',
		sourceQuestionId: 'question:runtime',
		sourceResearchIds: ['research:runtime-v1'],
		frontmatter: {
			title: 'Agent Processing Platform',
			summary: 'How the TreeSeed agent platform works.',
			status: 'draft',
			generated_by: 'treeseed-agent',
			agent_role: 'knowledge_generator',
			source_question: 'question:runtime',
			source_research: ['research:runtime-v1'],
			review_state: 'pending_review',
			book_target: 'architecture',
			section_target: 'runtime',
			confidence: 'medium',
			updated: '2026-05-13',
			related: { objectives: [], questions: ['question:runtime'], proposals: [] },
		},
		body: [
			'# Agent Processing Platform',
			'',
			'## Why this matters',
			'It lets TreeSeed explain itself.',
			'',
			'## Source map',
			'- packages/agent/src/services/worker.ts',
		].join('\n'),
		reviewState: 'pending_review',
		createdAt: '2026-05-13T00:00:00.000Z',
		updatedAt: '2026-05-13T00:00:00.000Z',
	};
}

function fakeWorktrees(input: {
	root: string;
	changedPaths?: string[];
	merge?: 'success' | 'conflict';
}) {
	return {
		plannedWorktreePath: vi.fn(() => input.root),
		createOrResumeWorktree: vi.fn(async () => ({
			branchName: 'agent/knowledge-promotion/task-1',
			worktreeRoot: input.root,
			created: true,
		})),
		inspectChangedPaths: vi.fn(async () => input.changedPaths ?? [draft().targetPath]),
		assertChangedPathsAllowed: vi.fn((scope) => {
			const changed = scope.changedPaths as string[];
			const allowed = scope.allowedPaths as string[];
			const bad = changed.filter((path) => !allowed.includes(path));
			if (bad.length) throw new Error(`Changed paths outside approved scope: ${bad.join(', ')}`);
		}),
		saveSnapshot: vi.fn(async (snapshot) => ({
			kind: snapshot.kind,
			ref: `${input.root}/${snapshot.kind}.json`,
			summary: snapshot.summary,
			changedPaths: snapshot.changedPaths,
			createdAt: '2026-05-13T00:00:00.000Z',
		})),
		stageAndCommit: vi.fn(async () => 'feature-sha'),
		mergeToStaging: vi.fn(async () => input.merge === 'conflict'
			? {
					status: 'failed',
					mergedToStaging: false,
					mergeFailure: {
						targetBranch: 'staging',
						featureBranch: 'agent/knowledge-promotion/task-1',
						conflictedPaths: [draft().targetPath],
						message: 'conflict',
					},
				}
			: {
					status: 'completed',
					mergedToStaging: true,
					commitSha: 'staging-sha',
				}),
	};
}

function taskInput(root: string) {
	const payload = {
		knowledgeDraft: draft(),
		approvalDecision: {
			approvalId: 'promotion:knowledge-runtime',
			decision: 'approve_as_book_content',
			actor: 'user-1',
		},
		allowedPaths: [draft().targetPath],
		forbiddenPaths: [],
		projectId: 'project-1',
		environment: 'local',
	};
	const normalized = normalizeKnowledgePromotionTaskInput({
		task: { id: 'task-1', workDayId: 'workday-1' },
		payload,
		repoRoot: root,
		projectId: 'project-1',
		environment: 'local',
	});
	expect(normalized).not.toBeNull();
	return normalized!;
}

describe('knowledge promotion to staging', () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('writes an approved draft in a worktree, merges to staging, and creates a release approval request', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const worktrees = fakeWorktrees({ root });
		const sdk = { appendTaskEvent: vi.fn(async () => ({ payload: {} })) };

		const result = await runKnowledgePromotionToStaging({
			task: taskInput(root),
			sdk,
			dependencies: {
				worktrees: worktrees as never,
				verify: vi.fn(async () => ({ ok: true, summary: 'ok', commandsRun: [], errors: [] })),
			},
		});

		expect(result.status).toBe('staged');
		expect(result.mergedToStaging).toBe(true);
		expect(result.releaseRequest).toEqual(expect.objectContaining({
			id: 'release:knowledge:runtime',
			approvalKind: 'release_staged_knowledge',
			targetPath: draft().targetPath,
			releaseInput: { bump: 'patch' },
		}));
		expect(worktrees.stageAndCommit).toHaveBeenCalledWith(expect.objectContaining({
			changedPaths: [draft().targetPath],
		}));
		expect(sdk.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'operation_event',
		}));
	});

	it('saves a failure snapshot when verification fails', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const worktrees = fakeWorktrees({ root });

		const result = await runKnowledgePromotionToStaging({
			task: taskInput(root),
			dependencies: {
				worktrees: worktrees as never,
				verify: vi.fn(async () => ({ ok: false, summary: 'bad links', commandsRun: [], errors: ['bad links'] })),
			},
		});

		expect(result.status).toBe('failed');
		expect(result.error?.code).toBe('verification_failed');
		expect(result.snapshots).toEqual([expect.objectContaining({ kind: 'failure' })]);
		expect(worktrees.stageAndCommit).not.toHaveBeenCalled();
	});

	it('returns repair context when merge to staging conflicts', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const worktrees = fakeWorktrees({ root, merge: 'conflict' });

		const result = await runKnowledgePromotionToStaging({
			task: taskInput(root),
			dependencies: {
				worktrees: worktrees as never,
				verify: vi.fn(async () => ({ ok: true, summary: 'ok', commandsRun: [], errors: [] })),
			},
		});

		expect(result.status).toBe('merge_failed');
		expect(result.repairTask).toEqual(expect.objectContaining({
			kind: 'knowledge_promotion_merge_repair',
			targetPath: draft().targetPath,
		}));
		expect(result.mergeFailure?.conflictedPaths).toEqual([draft().targetPath]);
	});

	it('requires operation grants before mutating', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const task = taskInput(root);
		task.operationGrants = [];

		const result = await runKnowledgePromotionToStaging({
			task,
			dependencies: { worktrees: fakeWorktrees({ root }) as never },
		});

		expect(result.status).toBe('waiting');
		expect(result.error?.code).toBe('operation_permission_required');
	});

	it('builds a release grant that requires the matching release approval', () => {
		expect(defaultReleaseGrant({
			taskId: 'task-release-1',
			projectId: 'project-1',
			environment: 'local',
			approvalId: 'release:knowledge:runtime',
		})).toEqual(expect.objectContaining({
			operations: ['release'],
			requiresApproval: true,
			approvalIds: ['release:knowledge:runtime'],
		}));
	});
});
