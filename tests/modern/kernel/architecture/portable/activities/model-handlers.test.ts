import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentTimingAwarenessReceiptSchema, type AssignmentContext } from '@treeseed/sdk/agent-capacity';
import type { AgentRuntime } from '../../../../../../src/kernel/contracts.ts';
import { ActorHandler, EstimateHandler, ReleaserHandler, ReviewerHandler, WriterHandler } from '../../../../../../src/kernel/handlers/model-handler.ts';
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
});
