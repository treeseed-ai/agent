import { expect, it, vi } from 'vitest';
import { observeReportedActivityCommands, verifyReportedActivityCommands } from '../../../../src/kernel/handlers/model-workload.ts';

it('replays truthful failed assertions without acceptance-prose or role selection and preserves authored claims', async () => {
	const command = 'npx vitest run tests/unit/example.test.ts';
	const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Actual regression evidence',
		reviewDisposition: null, contentOutput: null, verification: [{ status: 'failed' as const, summary: 'A real assertion failed.', commands: [command] }] };
	const evidence = { code: 'subprocess_nonzero_exit', exitCode: 1, stdout: 'FAIL tests/unit/example.test.ts > required behavior\nAssertionError: expected correct behavior\n', stderr: '' };
	for (const activity of ['planning', 'estimating', 'acting', 'reviewing', 'chat']) {
		const assignment = { agentClass: 'configured-contributor', effectiveProfile: { activity }, acceptanceCriteria: ['Develop executable regression coverage.'] };
		const held = structuredClone({ report, assignment, evidence });
		const execute = vi.fn(async () => { throw Object.assign(new Error('process exited 1'), evidence); });
		const observed = await observeReportedActivityCommands(report, [], execute, assignment);
		expect(execute).toHaveBeenCalledOnce(); expect(observed.report).toBe(report);
		expect(observed.verification).toEqual([expect.objectContaining({ command, status: 'failed', exitCode: 1, outputDigest: expect.stringMatching(/^sha256:/u) })]);
		expect({ report, assignment, evidence }).toEqual(held);
		await expect(observeReportedActivityCommands(report, [], async () => ({ stdout: 'unexpected pass', stderr: '' }), assignment))
			.rejects.toThrow('Runner-observed verification failed');
	}
});
import { correctObservedTestFirstRedVerification, isTestFirstVerification, reportedVerificationCommands } from '../../../../src/kernel/handlers/model-workload-contract.ts';

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
	expect(reportedVerificationCommands(corrected)).toEqual(['git diff --check']);
	expect(reportedVerificationCommands(corrected, isTestFirstVerification('reviewing', criteria))).toEqual([command, 'git diff --check']);
	for (const activity of ['acting', 'reviewing']) {
		expect(isTestFirstVerification(activity, criteria, command)).toBe(true);
		for (const unrelated of ['git diff --check', 'node -e "process.exit(1)"'])
			expect(isTestFirstVerification(activity, criteria, unrelated)).toBe(false);
	}
	for (const activity of ['chat', 'planning', 'estimating', 'reporting', '', 'unknown'])
		expect(isTestFirstVerification(activity, criteria, command)).toBe(false);
	for (const absent of [undefined, null, [], ['Implementation tests must pass.']])
		expect(isTestFirstVerification('acting', absent, command)).toBe(false);
	for (const bad of ['', 'git reset --hard', 'npm test; rm -rf .', 'npm test\0']) {
		const invalid = { ...corrected, verification: [{ status: 'failed' as const, summary: 'Invalid failed claim', commands: [bad] }] };
		expect(() => reportedVerificationCommands(invalid, true)).toThrow();
	}

	const replay = vi.fn(async () => {});
	await verifyReportedActivityCommands(corrected, replay);
	expect(replay.mock.calls).toEqual([['git diff --check']]);
	await expect(verifyReportedActivityCommands(corrected, async () => { throw new Error('exit 1'); }))
		.rejects.toThrow('Runner-observed verification failed');
	// Scope comes from the assigned work, never the first-party agent name.
	for (const [agentClass, activity] of [['engineer', 'acting'], ['contract-author', 'acting'],
		['independent-inspector', 'reviewing']] as const) {
		expect(correctObservedTestFirstRedVerification(report, events, agentClass, activity, criteria)).toEqual(corrected);
	}
	for (const [agentClass, activity, scopedCriteria] of [
		['engineer', 'acting', ['Implementation tests must pass.']], ['reviewer', 'planning', criteria],
		['reviewer', 'reviewing', ['Implementation tests must pass.']],
	] as const) {
		expect(correctObservedTestFirstRedVerification(report, events, agentClass, activity, scopedCriteria)).toEqual(report);
	}
	expect(correctObservedTestFirstRedVerification(report, [], 'reviewer', 'reviewing', criteria)).toEqual(report);
	expect(correctObservedTestFirstRedVerification(report, [...events,
		{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } }],
		'reviewer', 'reviewing', criteria)).toEqual(report);
});
