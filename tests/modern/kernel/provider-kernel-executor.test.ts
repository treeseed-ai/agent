import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';

const commit = 'a'.repeat(40);
const candidateCommit = 'b'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const runtimeBuild = `sha256:${'d'.repeat(64)}`;

function request(): AgentExecutionRequest {
	const assignmentAttempt = {
		schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1',
		teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1', nodeId: 'node-1', workItemId: 'implement-change', nodeRevision: 1, graphRevision: 1,
		sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal-1', revision: 1, digest },
		authorityRefs: [{ store: 'treedx', model: 'decision', id: 'decision-1', revision: 1, digest }],
		effectiveProfile: {
			profileRef: { store: 'treedx', model: 'agent', id: 'engineer', revision: 1, digest },
			activity: 'acting', handler: 'actor', handlerOrigin: 'agent-package',
			prompt: { system: 'Implement the accepted change.' },
			permissionCeiling: { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read', 'source.write'] },
		},
		requiredCapabilities: [],
		grant: { contentRead: [], contentWrite: [], sourceRead: ['treeseed-ai/sdk'], sourceWrite: ['treeseed-ai/sdk'], tools: ['source.read', 'source.write'] },
		provider: { providerId: 'provider-1', offerId: 'codex', offerRevision: 1, runtimeBuild },
		contextRefs: [{ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit }], predecessorResultIds: [],
		acceptanceCriteria: ['Commit the exact source change.'],
		workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: commit, branch: 'treeseed/assignments/assignment-1', writablePaths: ['src'] },
		estimate: { minimumSeconds: 1, expectedSeconds: 10, maximumSeconds: 30 },
		limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
		deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1', attempt: 1,
		status: 'leased', createdAt: '2026-09-13T12:00:00.000Z',
	};
	return {
		assignment: { id: 'assignment-1', assignmentAttempt, workspaceContext: { assignmentAttempt, predecessorResults: [] } },
		assignmentId: 'assignment-1', leaseToken: 'lease-token', runnerId: 'runner-1',
		treeDx: { projectId: 'project-1', handleId: 'handle-1', repositoryId: null, workspaceId: null, invoke: vi.fn() },
	};
}

describe('provider AgentKernel execution', () => {
	it('routes a canonical acting assignment through AgentKernel and preserves the verified Git reference', async () => {
		const executor: AgentExecutor = {
			id: 'codex', observe: async () => ({ available: true }),
			execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
				status: 'completed', summary: 'Implemented and verified.',
				outputs: { sourceReference: { kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit,
					branch: 'treeseed/assignments/assignment-1' } },
				usage: [{ elapsedSeconds: 4, inputTokens: 20, outputTokens: 10 }],
			}; }),
		};
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(vi.mocked(executor.execute).mock.calls[0]?.[0].assignment.workspaceContext).toMatchObject({
			authorizedContext: [{ ref: { id: 'sdk-source', commit }, value: { repository: 'treeseed-ai/sdk', commit } }],
		});
		expect(result.status).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({
			assignmentId: 'assignment-1', status: 'completed',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit }],
		});
	});

	it('fails closed before transport when the provider runtime build differs', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild: digest });
		expect(result).toMatchObject({ status: 'failed', code: 'agent_kernel_failed', summary: 'runtime_build_mismatch' });
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('returns timing noncompliance for a bounded retry instead of terminalizing the graph node', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request) => {
			await request.beginExecution?.();
			throw new Error('Kata guest exited 1: Agent timing-awareness contract requires two completed treeseed_time_status checks; observed 0.');
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'returned', code: 'assignment_timing_awareness_missing', retryable: true });
	});

	it('runs an Actor verification in a read-only source workspace without publishing a candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.workspace = { mode: 'read-only' };
		attempt.grant = { ...attempt.grant, sourceWrite: [], tools: ['source.read', 'verification'] };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'Verified exact source without publication.',
			outputs: { verificationRecords: [{ command: 'git rev-parse HEAD', status: 'passed', exitCode: 0,
				outputDigest: digest, durationSeconds: 1 }],
				activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'Verified exact source without publication.', verification: [{ command: 'git rev-parse HEAD',
					status: 'passed', exitCode: 0, outputDigest: digest, durationSeconds: 1 }], reviewDisposition: null } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [],
			verification: [{ command: 'git rev-parse HEAD', status: 'passed' }] });
	});

	it('runs the deterministic Reporter through the scoped TreeDX runtime without invoking a model', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.sourceRef = { store: 'postgresql', model: 'workday', id: 'workday-1', revision: 1, digest };
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reporting', handler: 'reporter',
			permissionCeiling: { content: { read: ['note'], write: ['note'] }, tools: [] } };
		const target = { store: 'treedx', model: 'note', id: 'workday-report', repository: 'treeseed-ai/sdk-library',
			commit, path: 'notes/workday-report.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] };
		attempt.contextRefs = [];
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: ['notes'] };
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			readRepositories: [{ projectId:'team-project', projectSlug:'team', repositoryId:target.repository, baseRef:commit, allowedPaths:['notes/workday-report.mdx'], allowedModels:['note'], source:'team-library' }],
			invoke: vi.fn(async (operation, value: any) => {
				expect(value.path.projectId).toBe('team-project');
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(executor.execute).not.toHaveBeenCalled();
		expect(result.outputs?.assignmentResult).toMatchObject({
			status: 'completed', references: [{ kind: 'treedx', projectId:'team-project', commit: candidateCommit, path: target.path }],
		});
		expect(written).toContain('classification');
	});

	it('commits a structured Reviewer disposition through the kernel-owned TreeDX path', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['decision'] }, tools: ['verification'] } };
		const target = { store: 'treedx', model: 'decision', id: 'review-decision', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/review-decision.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: ['verification'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const review = 'Candidate satisfies the exact acceptance criteria after reviewing the complete immutable proposal source and every cited requirement without relying on an inferred or mutable planning authority.';
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: review, responseMarkdown: review,
			outputs: { activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1', summary: review, verification: [], reviewDisposition: 'approved' } },
			usage: [{ elapsedSeconds: 3 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [{ kind: 'treedx', commit: candidateCommit, path: target.path }] });
		expect(written).toContain('decisionClass: proposal');
		expect(written).toContain('disposition: approved');
		expect(written.split('\n')).toContain(`rationale: ${review}`);
	});

	it('commits the governed Reviewer decision when the model also cites the candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['decision'] }, tools: ['verification'] } };
		const target = { store: 'treedx', model: 'decision', id: 'review-decision', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/review-decision.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['verification'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		(input.assignment.workspaceContext as Record<string, any>).predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'actor-result', assignmentId: 'actor-assignment',
			status: 'completed', summary: 'Created the candidate.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit }],
			verification: [], usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-09-14T12:00:00.000Z',
		}];
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const citedCandidate = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit, branch: 'treeseed/assignments/candidate' };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'The exact candidate requires the requested revision.',
			responseMarkdown: 'The exact candidate requires the requested revision.',
			outputs: { contentReferences: [citedCandidate], activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'The exact candidate requires the requested revision.', verification: [], reviewDisposition: 'revision-required' } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		const assignmentResult = result.outputs?.assignmentResult as { references?: unknown[] } | undefined;
		expect(assignmentResult?.references).toEqual([
			expect.objectContaining({ kind: 'treedx', commit: candidateCommit, path: target.path }),
		]);
		expect(written).toContain('decisionClass: work-review');
		expect(written).toContain('disposition: request-changes');
	});

	it('binds a read-only work review to the exact source when its predecessor produced no candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reviewing', handler: 'writer',
			permissionCeiling: { content: { read: ['proposal'], write: ['decision'] }, tools: ['verification'] } };
		const target = { store: 'treedx', model: 'decision', id: 'read-only-review', repository: 'treeseed-ai/sdk-library',
			commit, path: 'decisions/read-only-review.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['verification'] };
		attempt.contextRefs = [{ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit }];
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		(input.assignment.workspaceContext as Record<string, any>).predecessorResults = [{
			schemaVersion: 'treeseed.assignment-result/v1', id: 'architect-result', assignmentId: 'architect-assignment',
			status: 'completed', summary: 'Inspected exact source.', references: [], verification: [],
			usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-09-14T12:00:00.000Z',
		}];
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'The exact source satisfies the read-only acceptance criteria.',
			responseMarkdown: 'The exact source satisfies the read-only acceptance criteria.',
			outputs: { activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'The exact source satisfies the read-only acceptance criteria.', verification: [], reviewDisposition: 'approved' } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(written).toContain(`store: ${attempt.sourceRef.store}`);
		expect(written).toContain(`id: ${attempt.sourceRef.id}`);
	});

	it('commits EstimateHandler output as the one proposal-owned execution plan', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'estimating', handler: 'estimate',
			permissionCeiling: { content: { read: ['objective'], write: ['proposal'] }, tools: ['source.read'] } };
		const target = { store: 'treedx', model: 'proposal', id: 'estimated-proposal', repository: 'treeseed-ai/sdk-library',
			commit, path: 'proposals/estimated-proposal.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['source.read'] };
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: [target.path] };
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			invoke: vi.fn(async (operation, value: any) => {
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const proposal = {
			schemaVersion: 'treeseed.proposal/v1', id: 'estimated-proposal', projectId: 'project-1', title: 'Implement the accepted change',
			request: 'Implement the accepted change.', summary: 'One bounded implementation unit.', status: 'ready',
			executionPlan: { workItems: [{ id: 'implement', activity: 'acting', agentClass: 'architect', workspace: 'read-only',
				review: 'none', objective: 'Describe the implementation.', estimate: { minimumSeconds: 30, expectedSeconds: 60, maximumSeconds: 120 },
				requiredCapabilities: ['treeseed.engineering.architecture'],
				dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
				acceptanceCriteria: ['The implementation is described from exact source evidence.'] }] },
		};
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'Estimated one bounded work item.', responseMarkdown: 'Estimated one bounded work item.',
			outputs: { activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1', summary: 'Estimated one bounded work item.',
				verification: [], reviewDisposition: null, contentOutput: { model: 'proposal', body: 'This proposal has one bounded work item.', frontmatter: proposal } } },
			usage: [{ elapsedSeconds: 3 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status, JSON.stringify(result)).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [{ kind: 'treedx', commit: candidateCommit, path: target.path }] });
		expect(written).toContain('executionPlan:');
		expect(written).toContain('expectedSeconds: 60');
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
			status: 'completed', summary: 'Source-grounded response.', responseMarkdown: 'Source-grounded response.', usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status, JSON.stringify(result)).toBe('responded');
		expect(result.responseMarkdown).toBe('Source-grounded response.');
		expect(vi.mocked(input.treeDx.invoke).mock.calls.map(([operation]) => operation)).toEqual(['treedx.repositories.files.read']);
	});
});
