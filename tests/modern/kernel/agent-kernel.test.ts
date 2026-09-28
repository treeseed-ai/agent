import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssignmentContext, AssignmentReference } from '@treeseed/sdk/agent-capacity';
import { AgentKernel } from '../../../src/kernel/agent-kernel.ts';
import type { AgentRuntime, Handler } from '../../../src/kernel/contracts.ts';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import { ReporterHandler } from '../../../src/kernel/handlers/reporter.ts';
import { ReviewerHandler, WriterHandler } from '../../../src/kernel/handlers/model-handler.ts';

const commit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const runtimeBuild = `sha256:${'c'.repeat(64)}`;
const reportTarget = { store: 'treedx' as const, model: 'note', id: 'workday-report', revision: 1,
	digest, repository: 'treeseed-ai/team-library' };

function assignmentContext(): AssignmentContext {
	return {
		assignment: {
			schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1-attempt-1',
			teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1', nodeId: 'node-1', agentClass: 'reporter', workItemId: 'report-workday', nodeRevision: 1, graphRevision: 1,
			sourceRef: { store: 'postgresql', model: 'workday', id: 'workday-1', revision: 1, digest }, authorityRefs: [{ store: 'treedx', model: 'decision', id: 'decision-1', revision: 1, digest }],
			effectiveProfile: {
				profileRef: { store: 'treedx', model: 'agent', id: 'reporter-1', revision: 1, digest }, activity: 'reporting', handler: 'reporter',
				handlerOrigin: 'agent-package', prompt: { system: 'Record an exact deterministic report for the closing workday.' },
				permissionCeiling: { content: { read: ['note'], write: ['note'] }, tools: [] },
			},
			requiredCapabilities: [], grant: { contentRead: [], contentWrite: [reportTarget], sourceRead: [], sourceWrite: [], tools: [] },
			provider: { providerId: 'provider-1', offerId: 'offer-1', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild },
			contextRefs: [{ store: 'postgresql', model: 'workday', id: 'workday-1', revision: 1, digest }], predecessorResultIds: [],
			acceptanceCriteria: ['Commit one exact report.'],
			workspace: { mode: 'treedx', workspaceId: 'workspace-1', repository: 'treeseed-ai/team-library', baseCommit: commit, writablePaths: ['notes'] },
			estimate: { minimumSeconds: 1, expectedSeconds: 10, maximumSeconds: 30 }, limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
			deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1', attempt: 1, status: 'running', createdAt: '2026-09-13T12:00:00.000Z',
		},
		context: [{ ref: { store: 'postgresql', model: 'workday', id: 'workday-1', revision: 1, digest },
			mediaType: 'application/json', digest, value: { teamId: 'team-1', workdayId: 'workday-1',
				nodes: [], edges: [], attempts: [], reservations: [], usage: [] } }], predecessorResults: [],
	};
}

function runtime(commits: unknown[]): AgentRuntime {
	return {
		now: () => '2026-09-13T12:00:01.000Z',
		readContext: async () => null,
		invokeModel: async () => { throw new Error('reporter_must_not_invoke_model'); },
		runVerification: async () => { throw new Error('unexpected_verification'); },
		commitSource: async () => { throw new Error('unexpected_source_commit'); },
		commitTreeDx: async (request): Promise<AssignmentReference[]> => {
			commits.push(...request.writes.map(({ value }) => value));
			return request.writes.map(({ target }) => ({ kind: 'treedx' as const, projectId: 'project-1',
				repository: 'treeseed-ai/team-library', commit, path: target.path ?? 'notes/workday-report.yml', workspaceId: 'workspace-1' }));
		},
	};
}

describe('AgentKernel', () => {
	afterEach(() => vi.useRealTimers());

	it('does not charge preparation time against the productive execution limit', async () => {
		vi.useFakeTimers();
		const context = assignmentContext();
		context.assignment.effectiveProfile.handler = 'timed';
		context.assignment.limits.maximumSeconds = 1;
		let startExecution!: () => void;
		const executionStarted = new Promise<void>((resolve) => { startExecution = resolve; });
		const never = new Promise<never>(() => undefined);
		const handler: Handler = { id: 'timed', run: async () => never };
		const running = new AgentKernel(new HandlerRegistry([handler])).runAssignment({
			context, runtimeBuild, runtime: runtime([]), executionStarted,
		});
		let settled = false;
		void running.then(() => { settled = true; }, () => { settled = true; });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(settled).toBe(false);
		startExecution();
		await vi.advanceTimersByTimeAsync(1_001);
		await expect(running).rejects.toMatchObject({ message: 'assignment_timeout', code: 'assignment_timeout' });
	});

	it('enforces the absolute assignment deadline even before productive execution begins', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
		const context = assignmentContext();
		context.assignment.effectiveProfile.handler = 'waiting';
		context.assignment.deadline = '2026-09-13T12:00:02.000Z';
		const handler: Handler = { id: 'waiting', run: async () => new Promise<never>(() => undefined) };
		const executionStarted = new Promise<void>(() => undefined);
		const running = new AgentKernel(new HandlerRegistry([handler])).runAssignment({
			context, runtimeBuild, runtime: runtime([]), executionStarted,
		});
		const failure = expect(running).rejects.toMatchObject({ message: 'assignment_timeout', code: 'assignment_timeout' });
		await vi.advanceTimersByTimeAsync(2_001);
		await failure;
	});

	it('refuses a completed handler result at the exact deadline', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
		const context = assignmentContext();
		context.assignment.deadline = '2026-09-13T12:00:01.000Z';
		const boundary = runtime([]);
		const commitTreeDx = boundary.commitTreeDx;
		boundary.commitTreeDx = async (request) => {
			await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			return commitTreeDx(request);
		};
		const running = new AgentKernel(new HandlerRegistry([new ReporterHandler()]))
			.runAssignment({ context, runtimeBuild, runtime: boundary });
		const failure = expect(running).rejects.toMatchObject({ message: 'assignment_timeout', code: 'assignment_timeout' });
		await vi.advanceTimersByTimeAsync(1_000);
		await failure;
	});

	it('runs Reporter deterministically through the one assignment entry point', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const firstCommits: unknown[] = [];
		const secondCommits: unknown[] = [];
		const first = await kernel.runAssignment({ context: assignmentContext(), runtimeBuild, runtime: runtime(firstCommits) });
		const second = await kernel.runAssignment({ context: assignmentContext(), runtimeBuild, runtime: runtime(secondCommits) });
		expect(first).toEqual(second);
		expect(firstCommits).toEqual(secondCommits);
		expect(first.references[0]).toMatchObject({ kind: 'treedx', path: 'notes/workday-report.yml' });
	});

	it('measures native Reporter publication time without invoking a model', async () => {
		const boundary = runtime([]);
		boundary.now = vi.fn().mockReturnValueOnce('2026-09-13T12:00:01.000Z')
			.mockReturnValue('2026-09-13T12:00:02.250Z');
		const result = await new ReporterHandler().run(assignmentContext(), boundary);
		expect(result.usage.elapsedSeconds).toBe(2);
		expect(result.completedAt).toBe('2026-09-13T12:00:02.250Z');
	});

	it('fails closed on unknown handlers and wrong runtime builds', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const unknown = assignmentContext();
		unknown.assignment.effectiveProfile.handler = 'missing';
		await expect(kernel.runAssignment({ context: unknown, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('unknown_handler:missing');
		await expect(kernel.runAssignment({ context: assignmentContext(), runtimeBuild: digest, runtime: runtime([]) })).rejects.toThrow('runtime_build_mismatch');
	});
	it('rejects expired authority, cancellation, and invalid handler results before publication', async () => {
		const context = assignmentContext();
		context.assignment.effectiveProfile.handler = 'invalid';
		const handler: Handler = { id: 'invalid', run: vi.fn(async () => ({ status: 'completed' }) as never) };
		const kernel = new AgentKernel(new HandlerRegistry([handler]));
		const expired = structuredClone(context);
		expired.assignment.deadline = '2000-01-01T00:00:00.000Z';
		await expect(kernel.runAssignment({ context: expired, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('assignment_expired');
		expect(handler.run).not.toHaveBeenCalled();
		const cancelled = new AbortController(); cancelled.abort();
		await expect(kernel.runAssignment({ context, runtimeBuild, runtime: runtime([]), signal: cancelled.signal }))
			.rejects.toThrow('assignment_cancelled');
		expect(handler.run).not.toHaveBeenCalled();
		await expect(kernel.runAssignment({ context, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('agent_kernel_result_invalid');
		expect(handler.run).toHaveBeenCalledOnce();
	});

	it('rejects a result claiming a different assignment branch', async () => {
		const context = assignmentContext();
		context.assignment.workspace = { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: commit,
			branch: 'treeseed/assignments/assignment-1', writablePaths: ['src'] };
		context.assignment.grant.contentWrite = [];
		context.assignment.grant.sourceWrite = ['treeseed-ai/sdk'];
		context.assignment.effectiveProfile.handler = 'branch-result';
		const handler: Handler = { id: 'branch-result', run: async () => ({
			schemaVersion: 'treeseed.assignment-result/v1', id: 'result-1', assignmentId: context.assignment.id,
			status: 'completed', summary: 'Candidate.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk',
				branch: 'staging', commit }], verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [],
			completedAt: '2026-09-13T12:00:01.000Z',
		}) };
		await expect(new AgentKernel(new HandlerRegistry([handler])).runAssignment({ context, runtimeBuild, runtime: runtime([]) }))
			.rejects.toThrow('assignment_result_reference_denied');
	});
	it('enforces the exact TreeDX write grant at the runtime boundary', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const denied = assignmentContext();
		denied.assignment.grant.contentWrite = [];
		await expect(kernel.runAssignment({ context: denied, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('reporter_note_grant_required');
	});
	it('revokes captured runtime operations after the one completion path closes', async () => {
		const context = assignmentContext(); context.assignment.effectiveProfile.handler = 'capture';
		let captured: AgentRuntime | undefined;
		const handler: Handler = { id: 'capture', run: async (value, scoped) => {
			captured = scoped;
			return new ReporterHandler().run(value, scoped);
		} };
		const commits: unknown[] = [];
		await new AgentKernel(new HandlerRegistry([handler])).runAssignment({ context, runtimeBuild, runtime: runtime(commits) });
		expect(commits).toHaveLength(1);
		expect(() => captured!.commitTreeDx({ writes: [{ target: reportTarget, value: {} }] }))
			.toThrow('assignment_execution_closed');
		expect(commits).toHaveLength(1);
	});
	it('revokes captured runtime even when a project handler throws synchronously', async () => {
		const context = assignmentContext(); context.assignment.effectiveProfile.handler = 'capture';
		let captured: AgentRuntime | undefined;
		const handler: Handler = { id: 'capture', run: (_context, scoped) => { captured = scoped; throw new Error('handler_crash'); } };
		const commits: unknown[] = [];
		await expect(new AgentKernel(new HandlerRegistry([handler])).runAssignment({ context, runtimeBuild, runtime: runtime(commits) }))
			.rejects.toThrow('handler_crash');
		expect(() => captured!.commitTreeDx({ writes: [{ target: reportTarget, value: {} }] }))
			.toThrow('assignment_execution_closed');
		expect(commits).toHaveLength(0);
	});
	it('denies a runtime mutation at the deadline before invoking TreeDX', async () => {
		vi.useFakeTimers();
		const context = assignmentContext(); context.assignment.effectiveProfile.handler = 'capture';
		const handler: Handler = { id: 'capture', run: async (_context, scoped) => {
			vi.setSystemTime(new Date(context.assignment.deadline));
			await scoped.commitTreeDx({ writes: [{ target: reportTarget, value: {} }] });
			throw new Error('expired_publication_was_not_rejected');
		} };
		const commits: unknown[] = [];
		await expect(new AgentKernel(new HandlerRegistry([handler])).runAssignment({ context, runtimeBuild, runtime: runtime(commits) }))
			.rejects.toThrow('assignment_timeout');
		expect(commits).toHaveLength(0);
	});
	it('denies productive-budget overrun even before a starved timeout callback can run', async () => {
		let measured = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => measured);
		try {
			const context = assignmentContext(); context.assignment.effectiveProfile.handler = 'capture';
			context.assignment.limits.maximumSeconds = 1;
			const handler: Handler = { id: 'capture', run: async (_context, scoped) => {
				measured = 1001;
				await scoped.commitTreeDx({ writes: [{ target: reportTarget, value: {} }] });
				throw new Error('overrun_publication_was_not_rejected');
			} };
			const commits: unknown[] = [];
			await expect(new AgentKernel(new HandlerRegistry([handler])).runAssignment({ context, runtimeBuild, runtime: runtime(commits) }))
				.rejects.toThrow('assignment_timeout');
			expect(commits).toHaveLength(0);
		} finally { clock.mockRestore(); }
	});

	it.each(['book', 'knowledge'])('binds a TreeDX review to the exact %s candidate, not its proposal', async (model) => {
		const context = assignmentContext();
		context.assignment.effectiveProfile.activity = 'reviewing';
		context.assignment.effectiveProfile.handler = 'reviewer';
		context.assignment.grant.contentWrite = [
			{ ...reportTarget, id: 'review-finding', model: 'note', path: 'notes/review-finding.mdx' },
			{ ...reportTarget, model: 'decision', path: 'decisions/review-decision.mdx' },
		];
		const candidate = { store: 'treedx' as const, model, id: 'actor-output', repository: 'library',
			commit: 'd'.repeat(40), path: `${model}s/actor-output.mdx` };
		context.context = [{ ref: candidate, mediaType: 'text/markdown', digest, value: { frontmatter: { id: candidate.id } } }];
		context.predecessorResults = [{ schemaVersion: 'treeseed.assignment-result/v1', id: 'actor-result',
			assignmentId: 'actor-assignment', status: 'completed', summary: 'Exact source findings.',
			references: [{ kind: 'treedx', projectId: 'project-1', repository: candidate.repository,
				commit: candidate.commit, path: candidate.path }], verification: [], usage: { elapsedSeconds: 1 },
			diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z' }];
		const commits: unknown[] = [];
		const boundary = runtime(commits);
		boundary.invokeModel = async () => ({ text: 'Verified exact candidate.', usage: { elapsedSeconds: 1 },
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true },
			activityCompletion: { summary: 'Verified exact candidate.', reviewDisposition: 'approved', contentOutput: null } });
		await new ReviewerHandler().run(context, boundary);
		expect(commits[1]).toMatchObject({ frontmatter: { decisionClass: 'work-review', subjectRef: candidate } });
		context.context[0]!.ref = { ...candidate, commit: 'e'.repeat(40) };
		await expect(new ReviewerHandler().run(context, boundary)).rejects.toThrow('review_candidate_reference_missing');
		expect(commits).toHaveLength(2);
	});

	it.each(['book', 'knowledge'])('commits acting Writer %s output instead of a Note', async (model) => {
		const context = assignmentContext();
		context.assignment.effectiveProfile.activity = 'acting';
		context.assignment.effectiveProfile.handler = 'writer';
		context.assignment.grant.contentWrite = [{ ...reportTarget, model }];
		const commits: unknown[] = [];
		const boundary = runtime(commits);
		boundary.invokeModel = async () => ({ text: 'Published exact source findings.',
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true }, usage: { elapsedSeconds: 1 },
			activityCompletion: { summary: 'Published exact source findings.', reviewDisposition: null,
				contentOutput: { model, body: 'Substantive governed findings.', frontmatter: { id: reportTarget.id } } } });
		const result = await new WriterHandler().run(context, boundary);
		expect(commits).toEqual([{ body: 'Substantive governed findings.', frontmatter: { id: reportTarget.id } }]);
		expect(result.references).toHaveLength(1);
		expect(result.summary).toContain('AgentKernel committed governed TreeDX content');
		context.assignment.grant.contentWrite = [reportTarget];
		await expect(new WriterHandler().run(context, boundary)).rejects.toThrow('writer_content_commit_grant_required');
		expect(commits).toHaveLength(1);
		const invoke = boundary.invokeModel;
		boundary.invokeModel = async (request) => ({ ...await invoke(request), activityCompletion: undefined });
		await expect(new WriterHandler().run(context, boundary)).rejects.toThrow('writer_content_output_required');
		expect(commits).toHaveLength(1);
		boundary.invokeModel = async () => { throw new Error('model_failed'); };
		await expect(new WriterHandler().run(context, boundary)).rejects.toThrow('model_failed');
	});

	it('commits a planning synthesis from the completion summary as one governed Note', async () => {
		const context = assignmentContext();
		context.assignment.effectiveProfile.activity = 'planning';
		context.assignment.effectiveProfile.handler = 'writer';
		const commits: unknown[] = [];
		const boundary = runtime(commits);
		boundary.invokeModel = async () => ({ text: 'result-a supplied scope; result-b supplied risks.',
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true }, usage: { elapsedSeconds: 1 },
			activityCompletion: { summary: 'result-a supplied scope; result-b supplied risks.', reviewDisposition: null, contentOutput: null } });
		const result = await new WriterHandler().run(context, boundary);
		expect(result.summary).toBe('result-a supplied scope; result-b supplied risks.');
		expect(commits).toMatchObject([{ body: result.summary }]);
	});

	it('requires Architect acting output to extend the exact authorized published Book', async () => {
		const context = assignmentContext();
		context.assignment.agentClass = 'architect';
		context.assignment.effectiveProfile.activity = 'acting';
		context.assignment.effectiveProfile.handler = 'writer';
		const bookRef = { store: 'treedx' as const, model: 'book', id: 'sdk-core', revision: 3, digest,
			repository: 'treeseed-ai/sdk-library', commit, path: 'books/sdk-core.md' };
		context.assignment.contextRefs.push(bookRef);
		context.assignment.grant.contentRead.push(bookRef);
		context.context = [{ ref: bookRef, mediaType: 'text/markdown', digest,
			value: { frontmatter: { schemaVersion: 'treeseed.book/v3', id: bookRef.id, projectId: 'project-1',
				revision: 3, status: 'published', title: 'SDK Core' } } }];
		context.assignment.grant.contentWrite = [{ ...reportTarget, model: 'knowledge', id: 'sdk.architecture.authority' }];
		const commits: unknown[] = [], boundary = runtime(commits);
		let prompt = '', calls = 0;
		boundary.invokeModel = async (request) => { calls += 1; prompt = request.prompt; return ({ text: 'Extended the governed architecture.', usage: { elapsedSeconds: 1 },
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true },
			activityCompletion: { summary: 'Extended architecture.', reviewDisposition: null, contentOutput: {
				model: 'knowledge', body: 'The SDK has one contract authority.', frontmatter: {
					schemaVersion: 'treeseed.knowledge-page/v2', id: 'sdk.architecture.authority', projectId: 'project-1',
					bookRef, slug: 'authority', title: 'Authority', status: 'published', visibility: 'team', order: 1,
				} } } }); };
		await new WriterHandler().run(context, boundary);
		expect(commits).toHaveLength(1);
		expect(prompt).toContain('exact authorized Book reference');
		context.context = [];
		await expect(new WriterHandler().run(context, boundary)).rejects.toThrow('architect_architecture_book_context_required');
		expect(calls).toBe(1);
		context.context = [{ ref: bookRef, mediaType: 'text/markdown', digest,
			value: { frontmatter: { schemaVersion: 'treeseed.book/v3', id: bookRef.id, projectId: 'project-1',
				revision: 3, status: 'draft', title: 'SDK Core' } } }];
		await expect(new WriterHandler().run(context, boundary)).rejects.toThrow('architect_architecture_book_context_required');
		expect(calls).toBe(1);
	});
});
