import { expect, it } from 'vitest';
import { activityAllowsVerification, assertTesterFailureEvidence, attachObservedTesterFailures,
	correctObservedTestFirstRedVerification } from '../../../src/sandbox/guest-contract.ts';
import type { ActivityCompletionReport } from '../../../src/activity-completion.ts';

// Architecture ownership: assigned criteria select evidence; identity never selects policy.
const criteria = ['Report failing test names and paths for tests that fail on the frozen base.'];
const command = 'npx vitest run tests/unit/example.test.ts';
const events = [{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 1,
	aggregated_output: ' FAIL  tests/unit/example.test.ts > contract > rejects duplicates\nAssertionError: expected exact authority' } }];
const report: ActivityCompletionReport = { schemaVersion: 'treeseed.activity-completion/v1', summary: 'Inspected exact candidate.',
	contentOutput: null, reviewDisposition: 'approved', verification: [{ status: 'passed', summary: 'Claimed red suite', commands: [command] }] };

it('keeps verification admission unchanged when only the agent class is renamed', () => {
	for (const workspace of ['read-only', 'treedx', 'git']) {
		for (const activity of ['planning', 'estimating', 'acting', 'reviewing', 'chat']) {
				expect(activityAllowsVerification(activity, 'architect', workspace), `${activity}/${workspace}`)
					.toBe(activityAllowsVerification(activity, 'configured-author', workspace));
				for (const agentClass of ['architect', 'configured-author']) {
					expect(activityAllowsVerification(activity, agentClass, workspace, ['Do not claim test verification.'])).toBe(false);
				}
		}
	}
});

it('requires assigned failing-test evidence for arbitrary configured actors', () => {
	expect(() => assertTesterFailureEvidence(report, 'contract-author', 'acting', criteria))
		.toThrow('test_first_failure_evidence_missing');
	const exact = { ...report, summary: 'Frozen-base failing tests:\n- tests/unit/example.test.ts: rejects duplicates' };
	expect(() => assertTesterFailureEvidence(exact, 'contract-author', 'acting', criteria)).not.toThrow();
});

it('attaches real observed failure names independently of the actor identity', () => {
	const expected = attachObservedTesterFailures(report, events, 'tester', 'acting', criteria);
	expect(expected?.summary).toContain('tests/unit/example.test.ts: FAIL');
	expect(attachObservedTesterFailures(report, events, 'contract-author', 'acting', criteria)).toEqual(expected);
});

it('records the same observed red status for renamed actors and reviewers', () => {
	const expected = correctObservedTestFirstRedVerification(report, events, 'tester', 'acting', criteria);
	expect(expected.verification[0]?.status).toBe('failed');
	for (const [agentClass, activity] of [['contract-author', 'acting'], ['independent-inspector', 'reviewing']] as const) {
		expect(correctObservedTestFirstRedVerification(report, events, agentClass, activity, criteria)).toEqual(expected);
	}
});

it('does not mutate the reported verification or invent an observation during evidence correction', () => {
	const before = structuredClone(report);
	correctObservedTestFirstRedVerification(report, events, 'tester', 'acting', criteria);
	attachObservedTesterFailures(report, events, 'tester', 'acting', criteria);
	expect(report).toEqual(before);
	for (const name of ['tester', 'contract-author']) {
		expect(correctObservedTestFirstRedVerification(report, [], name, 'acting', criteria)).toEqual(report);
		expect(attachObservedTesterFailures(report, [], name, 'acting', criteria)).toEqual(report);
	}
});

it('does not infer a test-first evidence requirement from an agent name or malformed criteria', () => {
	for (const scope of [undefined, null, '', {}, [], ['Implementation tests must pass.']]) {
		expect(() => assertTesterFailureEvidence(report, 'tester', 'acting', scope)).not.toThrow();
		expect(attachObservedTesterFailures(report, events, 'tester', 'acting', scope)).toEqual(report);
		expect(correctObservedTestFirstRedVerification(report, events, 'tester', 'acting', scope)).toEqual(report);
	}
});
