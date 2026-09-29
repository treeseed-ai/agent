import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';

import { commit, candidateCommit, digest, runtimeBuild, timingAwareness, request } from './provider-kernel-fixture.ts';

describe('provider AgentKernel governed output', () => {
	it('commits a structured Reviewer disposition through the kernel-owned TreeDX path', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['note', 'decision'] }, tools: ['verification'] } };
		const findingTarget = { store: 'treedx', model: 'note', id: 'review-finding', repository: 'treeseed-ai/sdk-library',
			commit, path: 'notes/review-finding.mdx' };
		const target = { store: 'treedx', model: 'decision', id: 'review-decision', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/review-decision.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [findingTarget, target], sourceRead: [], sourceWrite: [], tools: ['verification'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [findingTarget.path, target.path] };
		const written: Record<string, string> = {};
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') for (const file of value.body.files) written[file.path] = file.content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: value.body.paths.map((path: string) => ({ path, content: written[path] })) };
				return {};
			}) };
		const review = 'Candidate satisfies the exact acceptance criteria after reviewing the complete immutable proposal source and every cited requirement without relying on an inferred or mutable planning authority.';
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: review, responseMarkdown: review,
			outputs: { timingAwareness, activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1', summary: review, verification: [], reviewDisposition: 'approved' } },
			usage: [{ elapsedSeconds: 3 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [
			{ kind: 'treedx', commit: candidateCommit, path: findingTarget.path },
			{ kind: 'treedx', commit: candidateCommit, path: target.path },
		],
			usage: { elapsedSeconds: 3 } });
		expect(written[findingTarget.path]).toContain('classification: feedback');
		expect(written[target.path]).toContain('decisionClass: proposal');
		expect(written[target.path]).toContain('disposition: approved');
		expect(written[target.path].split('\n')).toContain(`rationale: ${review}`);
		expect(written[target.path]).toContain('findingRefs:');
	});

	it('commits the governed Reviewer decision when the model also cites the candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['note', 'decision'] }, tools: ['verification'] } };
		const findingTarget = { store: 'treedx', model: 'note', id: 'review-finding', repository: 'treeseed-ai/sdk-library',
			commit, path: 'notes/review-finding.mdx' };
		const target = { store: 'treedx', model: 'decision', id: 'review-decision', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/review-decision.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [findingTarget, target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['verification'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [findingTarget.path, target.path] };
		(input.assignment.workspaceContext as Record<string, any>).predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'actor-result', assignmentId: 'actor-assignment',
			status: 'completed', summary: 'Created the candidate.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit }],
			verification: [], usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-09-14T12:00:00.000Z',
		}];
		const written: Record<string, string> = {};
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') for (const file of value.body.files) written[file.path] = file.content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: value.body.paths.map((path: string) => ({ path, content: written[path] })) };
				return {};
			}) };
		const citedCandidate = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit, branch: 'treeseed/assignments/candidate' };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'The exact candidate requires the requested revision.',
			responseMarkdown: 'The exact candidate requires the requested revision.',
			outputs: { timingAwareness, contentReferences: [citedCandidate], activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'The exact candidate requires the requested revision.', verification: [], reviewDisposition: 'revision-required' } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		const assignmentResult = result.outputs?.assignmentResult as { references?: unknown[] } | undefined;
		expect(assignmentResult?.references).toEqual([
			expect.objectContaining({ kind: 'treedx', commit: candidateCommit, path: findingTarget.path }),
			expect.objectContaining({ kind: 'treedx', commit: candidateCommit, path: target.path }),
		]);
		expect(written[findingTarget.path]).toContain('classification: feedback');
		expect(written[target.path]).toContain('decisionClass: work-review');
		expect(written[target.path]).toContain('disposition: request-changes');
	});

	it('binds a read-only work review to the exact source when its predecessor produced no candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['note', 'decision'] }, tools: ['verification'] } };
		const findingTarget = { store: 'treedx', model: 'note', id: 'read-only-finding', repository: 'treeseed-ai/sdk-library',
			commit, path: 'notes/read-only-finding.mdx' };
		const target = { store: 'treedx', model: 'decision', id: 'read-only-review', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/read-only-review.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [findingTarget, target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['verification'] };
		attempt.contextRefs = [{ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit }];
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [findingTarget.path, target.path] };
		(input.assignment.workspaceContext as Record<string, any>).predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'architect-result', assignmentId: 'architect-assignment',
			status: 'completed', summary: 'Inspected exact source.', references: [], verification: [],
			usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-09-14T12:00:00.000Z',
		}];
		const written: Record<string, string> = {};
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') for (const file of value.body.files) written[file.path] = file.content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: value.body.paths.map((path: string) => ({ path, content: written[path] })) };
				return {};
			}) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'The exact source satisfies the read-only acceptance criteria.',
			responseMarkdown: 'The exact source satisfies the read-only acceptance criteria.',
			outputs: { timingAwareness, activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'The exact source satisfies the read-only acceptance criteria.', verification: [], reviewDisposition: 'approved' } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(written[target.path]).toContain(`store: ${attempt.sourceRef.store}`);
		expect(written[target.path]).toContain(`id: ${attempt.sourceRef.id}`);
	});

	it('commits EstimateHandler output as the one proposal-owned execution plan', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'estimating', handler: 'estimate',
			permissionCeiling: { content: { read: ['objective'], write: ['proposal'] }, tools: ['source.read'] } };
		const target = { store: 'treedx', model: 'proposal', id: 'estimated-proposal', repository: 'treeseed-ai/sdk-library',
			commit, path: 'proposals/estimated-proposal.mdx' };
		attempt.sourceRef = target;
		attempt.contextRefs = [target];
		attempt.limits = { ...attempt.limits, maximumContextBytes: 10000, maximumContextTokens: 5000 };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['source.read'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written || 'Exact proposal source', frontmatter: proposal }] };
				return {};
			}) };
		const proposal = {
			schemaVersion: 'treeseed.proposal/v1', id: 'estimated-proposal', projectId: 'project-1', title: 'Implement the accepted change',
			request: 'Implement the accepted change.', summary: 'One bounded implementation unit.', status: 'ready',
			executionPlan: { workItems: [{ id: 'implement-change', activity: 'acting', agentClass: 'engineer', workspace: 'read-only',
				review: 'none', objective: 'Describe the implementation.', estimate: { expectedSeconds: 60, maximumSeconds: 120 },
				requiredCapabilities: ['treeseed.engineering.architecture'],
				dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
				acceptanceCriteria: ['The implementation is described from exact source evidence.'] }] },
		};
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'Estimated one bounded work item.', responseMarkdown: 'Estimated one bounded work item.',
			outputs: { timingAwareness, activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1', summary: 'Estimated one bounded work item.',
				verification: [], reviewDisposition: null, contentOutput: { model: 'proposal', body: 'This proposal has one bounded work item.',
					frontmatter: { executionPlan: { workItems: [{ estimate: proposal.executionPlan.workItems[0]?.estimate }] } } } } },
			usage: [{ elapsedSeconds: 3 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status, JSON.stringify(result)).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [{ kind: 'treedx', commit: candidateCommit, path: target.path }] });
		expect(written).toContain('executionPlan:');
		expect(written).toContain('expectedSeconds: 60');
		const incomplete = { executionPlan: { workItems: [] } };
		const invalidExecutor: AgentExecutor = { ...executor, execute: vi.fn(async (request): Promise<AgentExecutionResult> => {
			const response = await executor.execute(request);
			return { ...response, outputs: { ...response.outputs, activityCompletion: {
				schemaVersion: 'treeseed.activity-completion/v1', summary: 'Dropped other work items.', verification: [],
				reviewDisposition: null, contentOutput: { model: 'proposal', body: 'Incomplete plan.', frontmatter: incomplete },
			} } };
		}) };
		const denied = await executeKernelAssignment({ executor: invalidExecutor, request: input, runtimeBuild });
		expect(denied.status).toBe('failed');
		expect(denied.summary).toBe('estimate_proposal_patch_scope_invalid:expected=implement-change:actual=');
		expect(denied.outputs?.activityCompletion).toMatchObject({ contentOutput: { frontmatter: incomplete } });
		expect(denied.usage).toEqual([{ elapsedSeconds: 3 }]);
	});

	it('selects a project-owned handler compiled into the exact runtime build', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'chat', handler: 'sdk/project-answer',
			handlerOrigin: 'project-runtime', permissionCeiling: { content: { read: [], write: [] }, tools: [] } };
		attempt.grant = { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] };
		attempt.contextRefs = [];
		attempt.workspace = { mode: 'read-only' };
		const handler: Handler = { id: 'sdk/project-answer', run: async (context, runtime) => ({
			schemaVersion: 'treeseed.assignment-result/v1', id: 'project-result', assignmentId: context.assignment.id,
			status: 'completed', summary: 'Project behavior ran.', references: [], verification: [],
			usage: { elapsedSeconds: 0 }, diagnostics: [], completedAt: runtime.now(),
		}) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild, handlers: [handler] });
		expect(result.outputs?.assignmentResult).toMatchObject({ id: 'project-result', summary: 'Project behavior ran.' });
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('gives a project handler only verification actually observed inside its Kata guest', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'chat', handler: 'sdk/verified-answer',
			handlerOrigin: 'project-runtime', permissionCeiling: { content: { read: [], write: [] }, tools: ['verification'] } };
		attempt.grant = { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: ['verification'] };
		attempt.contextRefs = [];
		attempt.workspace = { mode: 'read-only' };
		const handler: Handler = { id: 'sdk/verified-answer', run: async (context, runtime) => {
			const model = await runtime.invokeModel({ prompt: 'Verify the source.', context: [] });
			await expect(runtime.runVerification({ command: 'git status --short' })).rejects.toThrow('verification_command_not_observed_in_guest');
			const verified = await runtime.runVerification({ command: 'git rev-parse HEAD' });
			return { schemaVersion: 'treeseed.assignment-result/v1', id: 'verified-result', assignmentId: context.assignment.id,
				status: 'completed', summary: model.text, references: [], verification: [verified],
				usage: model.usage, diagnostics: [], timingAwareness: model.timingAwareness, completedAt: runtime.now() };
		} };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (execution) => {
			await execution.beginExecution?.();
			return { status: 'responded' as const, summary: 'Verified.', outputs: { timingAwareness,
				verificationRecords: [{ command: 'git rev-parse HEAD', status: 'passed', exitCode: 0,
					outputDigest: digest, durationSeconds: 1 }] }, usage: [{ elapsedSeconds: 2 }] };
		}) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild, handlers: [handler] });
		expect(result.status).toBe('responded');
		expect(result.outputs?.assignmentResult).toMatchObject({ verification: [{ command: 'git rev-parse HEAD', outputDigest: digest }] });
	});

	it('serves only an exact granted and materialized context reference to a project handler', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		const source = attempt.contextRefs[0];
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'chat', handler: 'sdk/source-reader',
			handlerOrigin: 'project-runtime', permissionCeiling: { content: { read: [], write: [] }, tools: ['source.read'] } };
		attempt.grant = { contentRead: [], contentWrite: [], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['source.read'] };
		attempt.workspace = { mode: 'read-only' };
		const handler: Handler = { id: 'sdk/source-reader', run: async (context, runtime) => {
			const value = await runtime.readContext(source);
			await expect(runtime.readContext({ ...source, commit: candidateCommit })).rejects.toThrow(/denied/u);
			return { schemaVersion: 'treeseed.assignment-result/v1', id: 'read-result', assignmentId: context.assignment.id,
				status: 'completed', summary: JSON.stringify(value), references: [], verification: [],
				usage: { elapsedSeconds: 0 }, diagnostics: [], completedAt: runtime.now() };
		} };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild, handlers: [handler] });
		expect(result.status, JSON.stringify(result)).toBe('responded');
		expect(result.summary).toContain('treeseed-ai/sdk');
	});

	it('returns chat text for the provider-owned discussion commit without creating a generic note', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		const target = { store: 'treedx', model: 'discussion', id: 'message-1', repository: 'sdk-library',
			commit, path: 'discussion-messages/discussion-1/message-1.mdx', digest };
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'chat', handler: 'writer',
			permissionCeiling: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] } };
		attempt.grant = { contentRead: [target], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: ['discussion', 'source.read'] };
		attempt.sourceRef = target;
		attempt.contextRefs = [target];
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1', invoke: vi.fn(async () => ({
			resolvedRef: commit, files: [{ path: target.path, requestedPath: target.path, content: 'Question', frontmatter: {} }],
		})) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'Source-grounded response.', responseMarkdown: 'Source-grounded response.', outputs: { timingAwareness }, usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status, JSON.stringify(result)).toBe('responded');
		expect(result.responseMarkdown).toBe('Source-grounded response.');
		expect(vi.mocked(input.treeDx.invoke).mock.calls.map(([operation]) => operation)).toEqual(['treedx.repositories.files.read']);
	});
});
