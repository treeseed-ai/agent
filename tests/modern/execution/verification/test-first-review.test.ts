import { expect, it, vi } from 'vitest';
import { verifyReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { correctObservedTestFirstRedVerification } from '../../../../src/sandbox/guest-contract.ts';

it('preserves observed red tests in paired review without inventing passing verification', async () => {
	const command = 'npx vitest run tests/unit/example.test.ts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const,
		summary: 'The exact test-only candidate has the expected frozen-base failures.',
		reviewDisposition: 'approved' as const, contentOutput: null, verification: [
			{ status: 'passed' as const, summary: 'Focused red suite inspected.', commands: [command] },
			{ status: 'passed' as const, summary: 'Clean test diff.', commands: ['git diff --check'] },
		] };
	const events = [{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 1 } }];
	const criteria = ['Tester commits failing-on-base SDK tests for the accepted contract.'];
	const corrected = correctObservedTestFirstRedVerification(report, events, 'reviewer', 'reviewing', criteria);
	expect(corrected.verification[0]?.status).toBe('failed');
	expect(corrected.reviewDisposition).toBe('approved');
	const replay = vi.fn(async () => {});
	await verifyReportedActivityCommands(corrected, replay);
	expect(replay.mock.calls).toEqual([['git diff --check']]);
	await expect(verifyReportedActivityCommands(corrected, async () => { throw new Error('exit 1'); }))
		.rejects.toThrow('Runner-observed verification failed');
	for (const [agentClass, activity, scopedCriteria] of [
		['engineer', 'acting', criteria], ['reviewer', 'planning', criteria],
		['reviewer', 'reviewing', ['Implementation tests must pass.']],
	] as const) {
		expect(correctObservedTestFirstRedVerification(report, events, agentClass, activity, scopedCriteria)).toEqual(report);
	}
	expect(correctObservedTestFirstRedVerification(report, [], 'reviewer', 'reviewing', criteria)).toEqual(report);
	expect(correctObservedTestFirstRedVerification(report, [...events,
		{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } }],
		'reviewer', 'reviewing', criteria)).toEqual(report);
});
