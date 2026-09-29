import { expect, it } from 'vitest';
import { timingAwarenessContract, timingRecoveryEligible } from '../../../../src/sandbox/guest.ts';

it('recovers a separate final check when the first clock was also the last tool', () => {
	const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx',
		tool: 'treeseed_time_status', status: 'completed', error: null } };
	const single = timingAwarenessContract([clock]);
	expect(single).toMatchObject({ completedChecks: 1, firstToolCompliant: true, finalToolCompliant: true });
	expect(timingRecoveryEligible(single, 20_000)).toBe(true);
	expect(timingRecoveryEligible(single, 10_000)).toBe(false);
	expect(timingRecoveryEligible(timingAwarenessContract([clock, clock]), 20_000)).toBe(false);
});
