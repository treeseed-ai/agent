import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { enforceAssignmentGrant } from '../../../../src/kernel/granted-runtime.ts';

afterEach(() => vi.useRealTimers());
describe('ongoing authoritative time-budget discipline', () => {
	it('retains ongoing time discipline for independently verified Git work', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: { id: 'git-work',
			workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'actor', prompt: {} },
		}, context: [], predecessorResults: [] } }, 'low', 180);
		expect(prompt).toContain('before every potentially blocking command');
		expect(prompt).toContain('remaining time minus the closeout reserve');
		expect(prompt).toContain('concrete continuation proposal');
		expect(prompt).toContain('never mark a failure passed');
	});
	it.each(['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'])('instructs %s to remeasure, bound blocking work and hand off unfinished scope', activity => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'bounded', authorityRefs: [{ model: 'decision' }], effectiveProfile: { activity, handler: 'writer', prompt: {} },
		}, context: [], predecessorResults: [] } }, 'low', 180);
		expect(prompt).toContain('after each bounded batch of tool work');
		expect(prompt).toContain('before every potentially blocking command');
		expect(prompt).toContain('remaining time minus the closeout reserve');
		expect(prompt).toContain('concrete continuation proposal');
		expect(prompt).toContain('Never claim that a continuation proposal was committed');
		expect(prompt).toContain('FIRST tool action');
		expect(prompt).toContain('FINAL tool action');
		expect(prompt).toContain('fewer than two successful clock checks is rejected');
	});
	it('measures decreasing real authority without resetting time on repeated checks', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const startedAt = '2026-10-01T20:20:00.000Z', deadlineAt = '2026-10-01T20:23:00.000Z';
		for (const [at, remainingSeconds] of [['20:20:00', 180], ['20:21:20', 100], ['20:22:30', 30], ['20:23:01', 0]] as const) {
			vi.setSystemTime(new Date(`2026-10-01T${at}.000Z`));
			await expect(executeAssignmentTreeDxTool({} as never, 'treeseed_time_status', {}, { startedAt, deadlineAt }))
				.resolves.toEqual({ startedAt, deadlineAt, remainingSeconds });
		}
		await expect(executeAssignmentTreeDxTool({} as never, 'treeseed_time_status', {})).rejects.toThrow('Productive execution has not started');
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
