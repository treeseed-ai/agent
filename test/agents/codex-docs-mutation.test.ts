import { describe, expect, it, vi } from 'vitest';
import type { AgentOperationGrant } from '@treeseed/sdk/operations/agent-tools';
import {
	normalizeCodexDocsMutationInput,
	runCodexDocsMutationLifecycle,
} from '../../src/agents/implementation/codex-docs-mutation.ts';
import { engineerHandler } from '../../src/agents/handlers/engineer.ts';
import { reviewerHandler } from '../../src/agents/handlers/reviewer.ts';
import { releaserHandler } from '../../src/agents/handlers/releaser.ts';
import type { CodexExecutionResult } from '../../src/agents/adapters/execution-codex.ts';
import type { CodexDocsMutationResult } from '../../src/agents/contracts/implementation.ts';
import type { AgentContext, AgentVerificationResult } from '../../src/agents/runtime-types.ts';
import type { AgentWorktreeManager } from '../../src/services/agent-worktrees.ts';

const approval = {
	id: 'approval:docs-mutation',
	kind: 'authorize_mutation_scope',
	state: 'approved' as const,
};

const grant: AgentOperationGrant = {
	id: 'grant:engineer-docs',
	operations: ['switch', 'dev', 'verify', 'save', 'stage', 'merge_to_staging', 'close'],
	modes: ['dry_run', 'read_only', 'mutating'],
	agentRoles: ['engineer'],
	taskKinds: ['implementation'],
	projectIds: ['market'],
	environments: ['local'],
	allowedPaths: ['docs/**', 'src/content/knowledge/**'],
	forbiddenPaths: ['src/content/knowledge/private/**'],
	requiresApproval: false,
};

function context(payload: Record<string, unknown>, verification?: Partial<AgentVerificationResult>): AgentContext {
	return {
		runId: 'run:engineer',
		repoRoot: '/repo',
		agent: {
			slug: 'engineer-agent',
			handler: 'engineer',
			enabled: true,
			systemPrompt: 'Implement carefully.',
			persona: 'Engineer',
			cli: {},
			triggers: [],
			permissions: [],
			execution: {
				maxConcurrency: 1,
				timeoutSeconds: 900,
				cooldownSeconds: 0,
				leaseSeconds: 300,
				retryLimit: 0,
				branchPrefix: 'agent',
			},
			outputs: { messageTypes: [], modelMutations: [] },
		} as AgentContext['agent'],
		trigger: {
			kind: 'message',
			source: 'test',
			trigger: { type: 'message' },
			message: {
				id: 1,
				type: 'test',
				status: 'claimed',
				payloadJson: JSON.stringify(payload),
				relatedModel: null,
				relatedId: null,
				priority: 100,
				availableAt: '',
				claimedBy: null,
				claimedAt: null,
				leaseExpiresAt: null,
				attempts: 0,
				maxAttempts: 1,
				createdAt: '',
				updatedAt: '',
			},
		},
		sdk: {
			appendTaskEvent: vi.fn(async () => ({ payload: {} })),
			createMessage: vi.fn(async () => ({ payload: {} })),
		} as unknown as AgentContext['sdk'],
		execution: {} as AgentContext['execution'],
		mutations: {} as AgentContext['mutations'],
		repository: {} as AgentContext['repository'],
		verification: {
			runChecks: vi.fn(async () => ({
				status: 'completed',
				summary: 'Verification completed.',
				stdout: '',
				stderr: '',
				...verification,
			})),
		} as AgentContext['verification'],
		notifications: {} as AgentContext['notifications'],
		research: {} as AgentContext['research'],
		operations: {} as AgentContext['operations'],
	};
}

function payload(overrides: Record<string, unknown> = {}) {
	return {
		taskId: 'task:docs-mutation',
		taskKind: 'implementation',
		agentRole: 'engineer',
		projectId: 'market',
		environment: 'local',
		provider: 'codex',
		goal: 'Update docs.',
		featureBranch: 'agent/docs-mutation',
		stagingBranch: 'staging',
		approval,
		operationGrants: [grant],
		allowedPaths: ['docs/**', 'src/content/knowledge/**'],
		forbiddenPaths: ['src/content/knowledge/private/**'],
		verificationCommands: ['npm run test:unit'],
		workPackage: {
			id: 'task:docs-mutation',
			kind: 'implementation',
		},
		...overrides,
	};
}

function codexResult(overrides: Partial<CodexExecutionResult> = {}): CodexExecutionResult {
	return {
		provider: 'codex',
		threadId: 'thread:docs',
		status: 'completed',
		finalResponse: 'Updated docs.',
		summary: 'Updated docs.',
		changedPaths: ['docs/agent-dev.md'],
		proposedCommands: ['npm run test:unit'],
		verificationHints: ['npm run test:unit'],
		rawEventRefs: ['item:1'],
		usage: {
			subscriptionPlan: 'pro',
			wallMs: 50,
		},
		...overrides,
	};
}

function fakeWorktrees(changedPaths: string[] = ['docs/agent-dev.md'], merge: Record<string, unknown> = {}) {
	const worktreeRoot = '/repo/.agent-worktrees/agent/docs-mutation';
	return {
		plannedWorktreePath: vi.fn(() => worktreeRoot),
		createOrResumeWorktree: vi.fn(async () => ({
			branchName: 'agent/docs-mutation',
			worktreeRoot,
			created: true,
		})),
		inspectChangedPaths: vi.fn(async () => changedPaths),
		saveSnapshot: vi.fn(async (input: { kind: string; summary: string; changedPaths: string[] }) => ({
			kind: input.kind,
			ref: `/repo/.treeseed/tmp/${input.kind}.json`,
			summary: input.summary,
			changedPaths: input.changedPaths,
			createdAt: '2026-05-13T00:00:00.000Z',
		})),
		stageAndCommit: vi.fn(async () => 'commit:feature'),
		mergeToStaging: vi.fn(async () => ({
			status: 'completed',
			mergedToStaging: true,
			commitSha: 'commit:staging',
			...merge,
		})),
	} as unknown as AgentWorktreeManager & Record<string, ReturnType<typeof vi.fn>>;
}

function taskFrom(payloadOverrides: Record<string, unknown> = {}) {
	const ctx = context(payload(payloadOverrides));
	return {
		ctx,
		task: normalizeCodexDocsMutationInput(payload(payloadOverrides), ctx),
	};
}

describe('Codex docs mutation lifecycle', () => {
	it('creates an isolated worktree and passes the worktree root to Codex', async () => {
		const { ctx, task } = taskFrom();
		const worktrees = fakeWorktrees();
		const runCodexTask = vi.fn(async (request) => {
			expect(request.worktreeRoot).toBe('/repo/.agent-worktrees/agent/docs-mutation');
			expect(request.sandboxMode).toBe('workspace_write');
			expect(request.allowedPaths).toEqual(['docs/**', 'src/content/knowledge/**']);
			return codexResult();
		});

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask,
		});

		expect(result.status).toBe('staged');
		expect(worktrees.createOrResumeWorktree).toHaveBeenCalledWith('agent/docs-mutation');
		expect(ctx.verification.runChecks).toHaveBeenCalledWith(expect.objectContaining({
			cwd: '/repo/.agent-worktrees/agent/docs-mutation',
			commands: ['npm run test:unit'],
		}));
		expect(result.operationResults.map((entry) => entry.operation)).toEqual([
			'switch',
			'dev',
			'verify',
			'save',
			'stage',
			'merge_to_staging',
			'close',
		]);
		expect((ctx.sdk as any).appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
			taskId: 'task:docs-mutation',
			kind: 'operation_event',
		}));
	});

	it('does not require human approval metadata before scoped worktree mutation', async () => {
		const { ctx, task } = taskFrom({ approval: undefined, approvalId: undefined });
		const worktrees = fakeWorktrees();
		const runCodexTask = vi.fn(async (request) => {
			expect(request.approvalPolicy).toBe('never');
			expect(request.approvalId).toBeUndefined();
			return codexResult();
		});

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask,
		});

		expect(result.status).toBe('staged');
		expect(worktrees.createOrResumeWorktree).toHaveBeenCalled();
		expect(runCodexTask).toHaveBeenCalled();
	});

	it('returns waiting before mutation when operation grants are missing', async () => {
		const { ctx, task } = taskFrom({ operationGrants: [] });
		const worktrees = fakeWorktrees();
		const runCodexTask = vi.fn();

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask,
		});

		expect(result).toMatchObject({
			status: 'waiting',
			error: { code: 'operation_permission_required' },
		});
		expect(worktrees.createOrResumeWorktree).not.toHaveBeenCalled();
		expect(runCodexTask).not.toHaveBeenCalled();
	});

	it('fails changed paths outside scope and does not stage them', async () => {
		const { ctx, task } = taskFrom();
		const worktrees = fakeWorktrees(['src/content/knowledge/private/secret.mdx']);

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask: vi.fn(async () => codexResult()),
		});

		expect(result).toMatchObject({
			status: 'failed',
			error: { code: 'changed_path_scope_violation' },
			changedPaths: ['src/content/knowledge/private/secret.mdx'],
		});
		expect(worktrees.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'failure',
		}));
		expect(worktrees.stageAndCommit).not.toHaveBeenCalled();
		expect(worktrees.mergeToStaging).not.toHaveBeenCalled();
	});

	it('saves a failure snapshot and closes failed when verification fails', async () => {
		const { ctx, task } = taskFrom();
		const verification = {
			status: 'failed' as const,
			summary: 'Verification command failed.',
			errorCategory: 'execution_error' as const,
		};
		ctx.verification.runChecks = vi.fn(async () => verification);
		const worktrees = fakeWorktrees();

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask: vi.fn(async () => codexResult()),
		});

		expect(result).toMatchObject({
			status: 'failed',
			verification,
			error: { code: 'execution_error' },
		});
		expect(worktrees.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'failure',
			summary: 'Verification command failed.',
		}));
		expect(result.operationResults.at(-1)).toMatchObject({
			operation: 'close',
			status: 'failed',
		});
		expect(worktrees.stageAndCommit).not.toHaveBeenCalled();
	});

	it('saves, stages, merges to staging, and closes staged after verification succeeds', async () => {
		const { ctx, task } = taskFrom();
		const worktrees = fakeWorktrees(['docs/agent-dev.md', 'src/content/knowledge/architecture/runtime/runtime.mdx']);

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask: vi.fn(async () => codexResult()),
		});

		expect(result).toMatchObject({
			status: 'staged',
			mergedToStaging: true,
			changedPaths: ['docs/agent-dev.md', 'src/content/knowledge/architecture/runtime/runtime.mdx'],
		});
		expect(worktrees.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'verified',
		}));
		expect(worktrees.stageAndCommit).toHaveBeenCalledWith(expect.objectContaining({
			changedPaths: ['docs/agent-dev.md', 'src/content/knowledge/architecture/runtime/runtime.mdx'],
		}));
		expect(worktrees.mergeToStaging).toHaveBeenCalledWith({
			taskId: 'task:docs-mutation',
			featureBranch: 'agent/docs-mutation',
			stagingBranch: 'staging',
		});
		expect(result.operationResults.at(-1)).toMatchObject({
			operation: 'close',
			status: 'completed',
		});
	});

	it('creates structured repair context when merge to staging conflicts', async () => {
		const { ctx, task } = taskFrom();
		const mergeFailure = {
			targetBranch: 'staging',
			featureBranch: 'agent/docs-mutation',
			conflictedPaths: ['docs/agent-dev.md'],
			message: 'CONFLICT in docs/agent-dev.md',
		};
		const worktrees = fakeWorktrees(['docs/agent-dev.md'], {
			status: 'failed',
			mergedToStaging: false,
			mergeFailure,
		});

		const result = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask: vi.fn(async () => codexResult()),
		});

		expect(result).toMatchObject({
			status: 'merge_failed',
			mergeFailure,
			repairTask: {
				taskKind: 'implementation_repair',
				sourceTaskId: 'task:docs-mutation',
				conflictedPaths: ['docs/agent-dev.md'],
			},
			error: { code: 'merge_to_staging_failed' },
		});
		expect(worktrees.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
			kind: 'merge_failure',
		}));
	});

	it('emits engineer and reviewer handler outputs for staged implementation results', async () => {
		const { ctx, task } = taskFrom();
		const worktrees = fakeWorktrees();
		const lifecycleResult = await runCodexDocsMutationLifecycle(ctx, task, {
			worktrees,
			runCodexTask: vi.fn(async () => codexResult()),
		});

		const engineerOutput = await engineerHandler.emitOutputs(ctx, lifecycleResult);
		expect(engineerOutput).toMatchObject({
			status: 'completed',
			metadata: {
				mergedToStaging: true,
			},
		});

		const reviewCtx = context({
			implementationResult: lifecycleResult,
			allowedPaths: ['docs/**', 'src/content/knowledge/**'],
			forbiddenPaths: ['src/content/knowledge/private/**'],
		});
		const reviewInputs = await reviewerHandler.resolveInputs(reviewCtx);
		const reviewResult = await reviewerHandler.execute(reviewCtx, reviewInputs);
		const reviewOutput = await reviewerHandler.emitOutputs(reviewCtx, reviewResult);

		expect(reviewOutput).toMatchObject({
			status: 'completed',
			summary: 'Verified staged implementation task task:docs-mutation.',
		});
		expect((reviewCtx.sdk as any).createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'task_verified',
		}));
	});

	it('keeps release human-approved and unavailable to this lifecycle', async () => {
		const ctx = context({
			taskId: 'task:release',
			approval: { id: 'approval:release', state: 'approved' },
		});
		const inputs = await releaserHandler.resolveInputs(ctx);
		const result = await releaserHandler.execute(ctx, inputs);
		const output = await releaserHandler.emitOutputs(ctx, result);

		expect(result.summary).toContain('human-controlled');
		expect(output).toMatchObject({
			status: 'waiting',
			metadata: {
				releaseAttempted: false,
			},
		});
	});
});
