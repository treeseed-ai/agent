import { expect, it } from 'vitest';
import { timingAwarenessContract, timingRecoveryEligible } from '../../../../src/sandbox/guest.ts';

const value = { startedAt: '2026-10-04T00:00:00.000Z', deadlineAt: '2026-10-04T00:00:30.000Z', observedAt: '2026-10-04T00:00:00.000Z', remainingSeconds: 30 };
const payload = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
it('recovers a separate final check when the first clock was also the last tool', () => {
	const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx',
		tool: 'treeseed_time_status', status: 'completed', error: null, result: payload } };
	const single = timingAwarenessContract([clock]);
	expect(single).toMatchObject({ completedChecks: 1, firstToolCompliant: true, finalToolCompliant: true });
	expect(timingRecoveryEligible(single, 20_000)).toBe(true);
	expect(timingRecoveryEligible(single, 10_000)).toBe(false);
	expect(timingRecoveryEligible(timingAwarenessContract([clock, clock]), 20_000)).toBe(false);
	const command = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', error: null } };
	expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock, command]), 20_000)).toBe(true);
	expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock, command]), 10_000)).toBe(false);
});

it('requires finite numeric remaining authority for final clock recovery without coercion or resetting the boundary', () => {
	const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx',
		tool: 'treeseed_time_status', status: 'completed', error: null, result: payload } };
	const contract = timingAwarenessContract([clock]), before = structuredClone(contract);
	for (const remaining of [15_000, 15_000.5, 20_000]) expect(timingRecoveryEligible(contract, remaining)).toBe(true);
	const values: unknown[] = [14_999, 0, -1, NaN, Infinity, -Infinity, undefined, null, '', '15000', '20000', true, [], [20_000], {}];
	const outcomes = values.map(value => {
		const supplied = Object.assign({ remainingMs: 15_000 }, { remainingMs: value });
		const immutable = structuredClone(supplied);
		const allowed = timingRecoveryEligible(contract, supplied.remainingMs);
		expect(supplied).toEqual(immutable); return allowed;
	});
	expect(outcomes).toEqual(values.map(() => false)); expect(contract).toEqual(before);
});

it('denies contradictory private timing recovery observations rather than trusting a compliant flag alone', () => {
	const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx',
		tool: 'treeseed_time_status', status: 'completed', error: null, result: payload } };
	const original = timingAwarenessContract([clock]);
	const mutations = [
		{ schemaVersion: 'unknown' }, { requiredChecks: 0 }, { firstTool: 'command_execution' },
		{ firstTool: null }, { firstToolSucceeded: false }, { firstToolCompliant: 'true' },
		{ completedChecks: -1 }, { completedChecks: NaN }, { completedChecks: Infinity },
		{ completedChecks: 1.5 }, { completedChecks: '1' }, { finalToolCompliant: 'false' },
	];
	const outcomes = mutations.map(mutation => {
		const supplied = Object.assign(structuredClone(original), mutation), before = structuredClone(supplied);
		const allowed = timingRecoveryEligible(supplied, 20_000);
		expect(supplied).toEqual(before); return allowed;
	});
	expect(outcomes).toEqual(mutations.map(() => false));
	// These are the existing reducer's private partial observations, not a
	// fabricated successful SDK receipt or actual model-clock proof.
});
