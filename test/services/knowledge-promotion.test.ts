import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDraft } from '../../src/agents/contracts/knowledge.ts';
import {
	defaultReleaseGrant,
	normalizeKnowledgePromotionTaskInput,
	runKnowledgePromotionToStaging,
} from '../../src/services/knowledge-promotion.ts';
import { AgentWorktreeManager } from '../../src/services/agent-worktrees.ts';

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
			type: 'architecture',
			title: 'Agent Processing Platform',
			summary: 'How the TreeSeed agent platform works.',
			status: 'pending_review',
			generated_by: 'treeseed-agent',
			agent_role: 'knowledge_generator',
			source_question: 'question:runtime',
			source_research: ['research:runtime-v1'],
			review_state: 'pending_review',
			book_target: 'architecture',
			section_target: 'runtime',
			confidence: 'medium',
			source_map: [{
				claim: 'The agent worker executes queued tasks.',
				sourceFiles: ['packages/agent/src/services/manager.ts'],
				sourceSymbolsOrSections: ['runWorkerCycle'],
				evidenceStrength: 'direct',
				uncertainty: '',
				lastObservedRef: 'graph-1',
			}],
			updated: '2026-05-13',
			related: { objectives: [], questions: ['question:runtime'], proposals: [], decisions: [] },
		},
		body: [
			'# Agent Processing Platform',
			'',
			'## What this explains',
			'It lets TreeSeed explain itself.',
			'',
			'## Current implementation',
			'The agent worker executes queued tasks.',
			'',
			'## Main flow',
			'Queued tasks are claimed, executed, and completed.',
			'',
			'## Important files',
			'- packages/agent/src/services/manager.ts',
			'',
			'## Source map',
			'- packages/agent/src/services/manager.ts',
			'',
			'## Governance and safety boundaries',
			'Promotion remains approval gated.',
			'',
			'## Open questions',
			'- None recorded.',
			'',
			'## Verification notes',
			'Run package verification before release.',
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
		vi.unstubAllEnvs();
	});

	it('writes an approved draft in a worktree, merges to staging, and creates a release approval request', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const worktrees = fakeWorktrees({ root });
		const sdk = { createMessage: vi.fn(async () => ({ payload: {} })) };

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
		expect(readFileSync(`${root}/${draft().targetPath}`, 'utf8')).toContain('status: canonical');
		expect(worktrees.stageAndCommit).toHaveBeenCalledWith(expect.objectContaining({
			changedPaths: [draft().targetPath],
		}));
		expect(sdk.createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'agent.operation_event',
		}));
	});

	it('reports untracked nested files instead of their parent directories', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-git-`);
		roots.push(root);
		execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
		mkdirSync(`${root}/src/content/knowledge/cli/dev`, { recursive: true });
		writeFileSync(`${root}/src/content/knowledge/cli/dev/local-surfaces.mdx`, '# Local surfaces\n', 'utf8');

		const manager = new AgentWorktreeManager(root);
		await expect(manager.inspectChangedPaths(root)).resolves.toEqual([
			'src/content/knowledge/cli/dev/local-surfaces.mdx',
		]);
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
		expect(result.repairTask).toEqual(expect.objectContaining({
			kind: 'knowledge_promotion_verification_repair',
			sourceTaskId: 'task-1',
			failedCommands: [],
			verificationErrors: ['bad links'],
		}));
		expect(result.snapshots).toEqual([expect.objectContaining({ kind: 'failure' })]);
		expect(worktrees.stageAndCommit).not.toHaveBeenCalled();
	});

	it('fails before verification when changed paths violate approved scope', async () => {
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const worktrees = fakeWorktrees({ root, changedPaths: ['src/lib/private.ts'] });
		const verify = vi.fn(async () => ({ ok: true, summary: 'ok', commandsRun: [], errors: [] }));

		const result = await runKnowledgePromotionToStaging({
			task: taskInput(root),
			dependencies: {
				worktrees: worktrees as never,
				verify,
			},
		});

		expect(result.status).toBe('failed');
		expect(result.error?.code).toBe('changed_path_scope_violation');
		expect(result.snapshots).toEqual([expect.objectContaining({ kind: 'failure' })]);
		expect(verify).not.toHaveBeenCalled();
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

	it('does not synthesize mutation grants in hosted runtime mode', async () => {
		vi.stubEnv('TREESEED_AGENT_RUNTIME_MODE', 'hosted');
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		roots.push(root);
		const task = taskInput(root);

		expect(task.operationGrants).toEqual([]);

		const result = await runKnowledgePromotionToStaging({
			task,
			dependencies: { worktrees: fakeWorktrees({ root }) as never },
		});

		expect(result.status).toBe('waiting');
		expect(result.error?.code).toBe('repository_claim_required');
	});

	it('uses an active hosted repository claim as the mutation root', () => {
		vi.stubEnv('TREESEED_AGENT_RUNTIME_MODE', 'hosted');
		const root = mkdtempSync(`${tmpdir()}/treeseed-promotion-`);
		const hostedRoot = mkdtempSync(`${tmpdir()}/treeseed-hosted-claim-`);
		roots.push(root, hostedRoot);
		const normalized = normalizeKnowledgePromotionTaskInput({
			task: { id: 'task-1', workDayId: 'workday-1' },
			repoRoot: root,
			projectId: 'project-1',
			environment: 'staging',
			payload: {
				knowledgeDraft: draft(),
				approvalDecision: {
					approvalId: 'promotion:knowledge-runtime',
					decision: 'approve_as_book_content',
					actor: 'user-1',
				},
				allowedPaths: [draft().targetPath],
				forbiddenPaths: [],
				projectId: 'project-1',
				environment: 'staging',
				repositoryClaim: {
					id: 'claim-1',
					repositoryId: 'repo-1',
					runnerId: 'runner-1',
					claimState: 'active',
					volumeIdentity: hostedRoot,
					metadata: {
						repositoryRoot: hostedRoot,
					},
				},
			},
		});

		expect(normalized).toMatchObject({
			repoRoot: hostedRoot,
			repositoryClaim: {
				id: 'claim-1',
				claimState: 'active',
				runnerId: 'runner-1',
			},
		});
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
