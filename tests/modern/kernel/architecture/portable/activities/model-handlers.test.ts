import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentTimingAwarenessReceiptSchema, type AssignmentContext } from '@treeseed/sdk/agent-capacity';
import type { AgentRuntime } from '../../../../../../src/kernel/contracts.ts';
import { ActorHandler, EstimateHandler, ReleaserHandler, ReviewerHandler, WriterHandler } from '../../../../../../src/kernel/handlers/model-handler.ts';
import { prepareTreeDxContent } from '../../../../../../src/kernel/treedx-content-commit.ts';
import { request, timingAwareness } from '../../../provider-kernel-fixture.ts';

const handlers = [WriterHandler, ActorHandler, EstimateHandler, ReviewerHandler, ReleaserHandler];
const activities = ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'] as const;

function input(activity: typeof activities[number], handler: string) {
	const assignment = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	assignment.agentClass = 'renamed-specialist';
	assignment.effectiveProfile = { ...assignment.effectiveProfile, activity, handler,
		prompt: { system: 'Perform the configured activity using only the supplied authority.' } };
	const target = (model: string) => ({ store: 'treedx' as const, model, id: `${model}-output`, repository: 'repo',
		path: `${model}s/output.mdx`, commit: 'a'.repeat(40), revision: 1, digest: `sha256:${'b'.repeat(64)}` });
	assignment.grant.contentWrite = [target('note'), target('decision'), target('proposal')];
	if (activity !== 'acting') assignment.workspace = { mode: 'treedx', workspaceId: 'workspace', repository: 'repo',
		baseCommit: 'a'.repeat(40), writablePaths: ['.'] };
	const estimate = { expectedSeconds: 10, maximumSeconds: 20, rationale: 'Controlled unit input.' };
	const proposal = { executionPlan: { workItems: [{ id: assignment.workItemId, agentClass: assignment.agentClass }] } };
	const context: AssignmentContext = { assignment, context: [{ ref: assignment.sourceRef, digest: assignment.sourceRef.digest!,
		mediaType: 'application/json', value: { frontmatter: proposal } }], predecessorResults: [] };
	if (activity === 'reviewing') context.predecessorResults = [{ schemaVersion: 'treeseed.assignment-result/v1', id: 'candidate-result',
		assignmentId: 'original', status: 'completed', summary: 'Controlled predecessor input.',
		references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: 'b'.repeat(40) }], verification: [],
		usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-10-23T00:00:00Z' }];
	const boundary: AgentRuntime = {
		now: () => '2026-10-23T00:00:01Z', readContext: vi.fn(), runVerification: vi.fn(),
		invokeModel: vi.fn<AgentRuntime['invokeModel']>(async () => ({ text: 'Configured activity output.', timingAwareness: assignmentTimingAwarenessReceiptSchema.parse(timingAwareness), usage: { elapsedSeconds: 1 },
			changedPaths: ['src/output.ts'], activityCompletion: { summary: 'Configured activity output.',
				reviewDisposition: activity === 'reviewing' ? 'approved' as const : null,
				contentOutput: activity === 'estimating' ? { model: 'proposal', body: 'Existing proposal request.',
					frontmatter: { executionPlan: { workItems: [{ id: assignment.workItemId, estimate }] } } } : null } })),
		commitSource: vi.fn(async () => ({ kind: 'git' as const, repository: 'treeseed-ai/sdk', commit: 'b'.repeat(40) })),
		commitTreeDx: vi.fn<AgentRuntime['commitTreeDx']>(async ({ writes }) => writes.map(({ target }) => ({ kind: 'treedx' as const,
			projectId: assignment.projectId, repository: target.repository!, path: target.path!, commit: 'b'.repeat(40) }))),
	};
	return { context, boundary };
}

describe('nondeterministic handlers support all configured activities', () => {
	// Planning publishes a complete document; it must not silently invent patch
	// composition. Per-item removal authority is outside this regression.
	it.each(handlers.flatMap(Handler => ['omitted', 'fragment', 'complete'].map(mode => [new Handler().id, mode, Handler] as const)))
	('requires a complete shared planning document through %s when executionPlan is %s', async (id, mode, Handler) => {
		const handler = new Handler(), { context, boundary } = input('planning', id), assignment = context.assignment;
		const target = assignment.grant.contentWrite.find(reference => reference.model === 'proposal')!;
		assignment.sourceRef = target; assignment.contextRefs = [target];
		const estimate = { expectedSeconds: 10, maximumSeconds: 20, rationale: 'Controlled historical estimate fixture.' };
		const peer = { id: 'peer-document', activity: 'acting', workspace: 'read-only', review: 'required',
			maximumReviewCycles: 2, objective: 'Document the existing interface.', estimate, reviewEstimate: estimate,
			estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-peer-estimate', revision: 1 },
			dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] },
			acceptanceCriteria: ['Describe the actual interface.'] };
		const own = { id: 'new-regression', activity: peer.activity, workspace: peer.workspace, review: peer.review,
			maximumReviewCycles: peer.maximumReviewCycles, objective: 'Reproduce the documented interface failure.',
			dependsOn: [peer.id], requestedPermissions: peer.requestedPermissions,
			acceptanceCriteria: ['Reproduce the documented interface failure.'] };
		const metadata = { schemaVersion: 'treeseed.proposal/v2', id: target.id, projectId: assignment.projectId,
			groupIds: ['provider-runtime'], title: 'Retain group planning contributions', status: 'discussing',
			request: 'Refine the existing group proposal without losing peer work.', summary: 'Existing governed group scope.' };
		const base = { ...metadata, executionPlan: { workItems: [peer] } };
		context.context = [{ ref: target, digest: target.digest!, mediaType: 'application/json', value: { frontmatter: base } }];
		const frontmatter = { ...metadata, summary: 'Refined by the current admitted planner.',
			...(mode === 'omitted' ? {} : { executionPlan: { workItems: mode === 'fragment' ? [own] : [peer, own] } }) };
		vi.mocked(boundary.invokeModel).mockResolvedValue({ text: 'Refined the retained proposal.',
			timingAwareness: assignmentTimingAwarenessReceiptSchema.parse(timingAwareness), usage: { elapsedSeconds: 1 },
			activityCompletion: { summary: 'Refined the retained proposal.', reviewDisposition: null,
				contentOutput: { model: 'proposal', body: 'Source-grounded planning refinement.', frontmatter } } });
		const published: unknown[] = [];
		vi.mocked(boundary.commitTreeDx).mockImplementation(async ({ writes }) => {
			for (const write of writes) prepareTreeDxContent(write.target, write.value);
			published.push(...writes.map(write => write.value));
			return writes.map(({ target: written }) => ({ kind: 'treedx' as const, projectId: assignment.projectId,
				repository: written.repository!, path: written.path!, commit: 'b'.repeat(40) }));
		});
		const before = structuredClone(context);
		try {
			if (mode !== 'complete') {
				await expect(handler.run(context, boundary)).rejects.toThrow();
				expect(published).toEqual([]);
			} else {
				const result = await handler.run(context, boundary);
				expect(result.status).toBe('completed'); expect(boundary.commitTreeDx).toHaveBeenCalledOnce();
				expect(published).toEqual([{ body: 'Source-grounded planning refinement.', frontmatter }]);
			}
		} finally { expect(context).toEqual(before); }
	});
	it.each(handlers.map(Handler => [new Handler().id, Handler] as const))('publishes an authorized planning proposal through %s without replacing it with a Note', async (id, Handler) => {
		const handler = new Handler(), { context, boundary } = input('planning', id);
		const target = context.assignment.grant.contentWrite.find(reference => reference.model === 'proposal')!;
		const frontmatter = { schemaVersion: 'treeseed.proposal/v2', id: target.id, projectId: context.assignment.projectId,
			groupIds: ['provider-runtime'], title: 'Preserve authorized TreeDX read scopes', status: 'discussing',
			request: 'Deliver the group-discussed source-read repair through the shared backend.',
			summary: 'The group will supply its own contributions and estimates.' };
		const body = 'Retain the discussed objective and let every subscribed contributor estimate its own work.';
		vi.mocked(boundary.invokeModel).mockResolvedValue({ text: 'Proposed the discussed repair.',
			timingAwareness: assignmentTimingAwarenessReceiptSchema.parse(timingAwareness), usage: { elapsedSeconds: 1 },
			activityCompletion: { summary: 'Proposed the discussed repair.', reviewDisposition: null,
				contentOutput: { model: 'proposal', body, frontmatter } } });
		const before = structuredClone(context);
		const result = await handler.run(context, boundary);
		expect(boundary.commitTreeDx).toHaveBeenCalledExactlyOnceWith({ writes: [{ target, value: { body, frontmatter } }] });
		expect(result.references).toEqual([expect.objectContaining({ kind: 'treedx', repository: target.repository, path: target.path })]);
		expect(result.summary).toContain('Proposed the discussed repair.');
		expect(boundary.commitSource).not.toHaveBeenCalled();
		expect(context).toEqual(before);
	});
	it('commits each group subscriber own V2 contribution through every configured model handler and retains peer scopes', async () => {
		for (const Handler of handlers) {
			const handler = new Handler(), { context, boundary } = input('estimating', handler.id), assignment = context.assignment;
			delete assignment.workItemId;
			const proposal = { schemaVersion: 'treeseed.proposal/v2', id: assignment.sourceRef.id, projectId: assignment.projectId,
				groupIds: ['provider-runtime'], title: 'Repair prepared workload inputs', status: 'discussing',
				request: 'Document, reproduce and repair the actual request handoff.', summary: 'Own source contributions from the whole subscribed team.' };
			const estimate = { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Controlled author estimate, not measured model work.' };
			const work = { id: 'document-handoff', activity: 'acting', workspace: 'read-only', review: 'required', maximumReviewCycles: 2,
				objective: 'Document the prepared handler request boundary.', estimate, reviewEstimate: estimate,
				estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: assignment.id, revision: assignment.attempt },
				dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] }, acceptanceCriteria: ['Describe the real request contract.'] };
			const peer = { ...work, id: 'reproduce-handoff', estimateRef: { ...work.estimateRef, id: 'peer-estimate' } };
			context.context[0]!.value = { frontmatter: { ...proposal, executionPlan: { workItems: [peer] } } };
			vi.mocked(boundary.invokeModel).mockResolvedValue({ text: 'Own documented estimate.', timingAwareness: assignmentTimingAwarenessReceiptSchema.parse(timingAwareness), usage: { elapsedSeconds: 1 },
				activityCompletion: { summary: 'Own documented estimate.', reviewDisposition: null,
					contentOutput: { model: 'proposal', body: 'Existing proposal request.', frontmatter: { executionPlan: { workItems: [work] } } } } });
			const before = structuredClone(context), result = await handler.run(context, boundary);
			expect(result.status, handler.id).toBe('completed'); expect(boundary.commitTreeDx).toHaveBeenCalledOnce();
			const write = vi.mocked(boundary.commitTreeDx).mock.calls[0]![0].writes[0]!;
			expect(write.value).toEqual({ body: 'Existing proposal request.', frontmatter: { ...proposal, executionPlan: { workItems: [work, peer] } } });
			expect(result.references).toHaveLength(1); expect(context).toEqual(before);
		}
	});
	it('executes all six activities with every model handler without handler-name filtering', async () => {
		for (const Handler of handlers) for (const activity of activities) {
			const handler = new Handler(), { context, boundary } = input(activity, handler.id);
			const before = structuredClone(context);
			const result = await handler.run(context, boundary);
			expect(result.status, `${handler.id}/${activity}`).toBe('completed');
			expect(boundary.invokeModel).toHaveBeenCalledOnce();
			expect(boundary.invokeModel).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(context.assignment.effectiveProfile.prompt.system) }));
			expect(boundary.commitSource).toHaveBeenCalledTimes(activity === 'acting' ? 1 : 0);
			expect(boundary.commitTreeDx).toHaveBeenCalledTimes(['acting', 'chat'].includes(activity) ? 0 : 1);
			expect(context).toEqual(before);
		}
	});
	it('requires the same exact review finding grant for every handler', async () => {
		for (const Handler of handlers) {
			const handler = new Handler(), { context, boundary } = input('reviewing', handler.id);
			context.assignment.grant.contentWrite = context.assignment.grant.contentWrite.filter(ref => ref.model !== 'note');
			await expect(handler.run(context, boundary)).rejects.toThrow('review_finding_commit_grant_required');
			expect(boundary.commitTreeDx).not.toHaveBeenCalled();
		}
	});
	it('retains explicitly granted reporting products without allowing them to bypass review dispositions', async () => {
		for (const Handler of handlers) {
			const handler = new Handler();
			for (const activity of ['reporting', 'reviewing'] as const) {
				const { context, boundary } = input(activity, handler.id);
				const target = context.assignment.grant.contentWrite.find(reference => reference.model === 'proposal')!;
				const output = { model: 'proposal', body: 'Governed reporting product.', frontmatter: { id: target.id } };
				const original = await boundary.invokeModel({ prompt: '', context: [] });
				vi.mocked(boundary.invokeModel).mockClear();
				vi.mocked(boundary.invokeModel).mockResolvedValue({ ...original, activityCompletion: {
					summary: 'Governed reporting product.', reviewDisposition: null, contentOutput: output } });
				if (activity === 'reviewing') {
					await expect(handler.run(context, boundary)).rejects.toThrow('review_disposition_required');
					expect(boundary.commitTreeDx).not.toHaveBeenCalled();
				} else {
					await handler.run(context, boundary);
					expect(boundary.commitTreeDx).toHaveBeenCalledExactlyOnceWith({ writes: [{ target, value: { body: output.body, frontmatter: output.frontmatter } }] });
				}
			}
		}
	});
});
