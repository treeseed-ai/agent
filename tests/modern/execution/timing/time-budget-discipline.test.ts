import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptFromContext } from '../../../../src/kernel/handlers/model-workload-contract.ts';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { enforceAssignmentGrant } from '../../../../src/kernel/granted-runtime.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';

afterEach(() => vi.useRealTimers());
describe('ongoing authoritative time-budget discipline', () => {
	it('exposes the original execution budget as data without injecting task instructions', () => {
 const input = { canonicalAssignmentContext: { assignment: { id: 'original-budget', effectiveProfile: { activity: 'acting', handler: 'actor', prompt: { system: 'Perform the accepted work.' } } }, context: [], predecessorResults: [] } };
 const prompt = promptFromContext(input, 'low', 180);
 expect(JSON.parse(prompt.split('\n\n').at(-1)!)).toMatchObject({ executionSeconds: 180, reasoningEffort: 'low' });
 expect(prompt).not.toContain('mandatory runner replay');
});
	it('keeps instruction authority in the configured profile for Git work', () => {
 const profile = { system: 'Perform the accepted Git repair.', instructions: ['Retain the original deadline and report unfinished scope.'] };
 const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: { workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'actor', prompt: profile } } } });
 expect(prompt.split('\n\n').slice(0,-1)).toEqual([profile.system, ...profile.instructions]);
});
	it.each(['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'])('preserves configured deadline guidance for %s', activity => {
 const instructions = ['Check authoritative remaining time before blocking work.', 'Preserve unfinished scope before the original deadline.'];
 const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: { authorityRefs: [{ model: 'decision' }], effectiveProfile: { activity, handler: 'writer', prompt: { system: 'Follow the accepted scope.', instructions } } } } }, 'low', 180);
 expect(prompt.split('\n\n').slice(0,-1)).toEqual(['Follow the accepted scope.', ...instructions]);
});
	it('measures decreasing real authority without resetting time on repeated checks', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const startedAt = '2026-10-01T20:20:00.000Z', deadlineAt = '2026-10-01T20:23:00.000Z';
		const input = request(), original = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt);
		const attempt = assignmentAttemptSchema.parse({ ...original, createdAt: startedAt, deadline: deadlineAt,
			limits: { ...original.limits, maximumSeconds: 180 } });
		input.assignment = { ...input.assignment, assignmentAttempt: attempt };
		for (const [at, remainingSeconds] of [['20:20:00', 180], ['20:21:20', 100], ['20:22:30', 30], ['20:23:01', 0]] as const) {
			const observedAt = `2026-10-01T${at}.000Z`;
			vi.setSystemTime(new Date(observedAt));
			await expect(executeAssignmentTreeDxTool(input, 'treeseed_time_status', {}, { startedAt, deadlineAt }))
				.resolves.toEqual({ startedAt, deadlineAt, remainingSeconds, observedAt });
		}
		await expect(executeAssignmentTreeDxTool(input, 'treeseed_time_status', {})).rejects.toThrow('Productive execution has not started');
	});
	it('does not invent proposal publication authority when time runs short', () => {
		const commitTreeDx = vi.fn();
		const scoped = enforceAssignmentGrant({ now: () => '2026-10-01T20:22:30Z', readContext: vi.fn(),
			invokeModel: vi.fn(), runVerification: vi.fn(), commitSource: vi.fn(), commitTreeDx },
			{ contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] }, { mode: 'git' }, () => undefined);
		expect(() => scoped.commitTreeDx({ writes: [{ target: { store: 'treedx', model: 'proposal', id: 'continuation',
			revision: 1, digest: `sha256:${'a'.repeat(64)}` }, value: {} }] })).toThrow('assignment_grant_denied:treedx.write');
		expect(commitTreeDx).not.toHaveBeenCalled();
	});
});
