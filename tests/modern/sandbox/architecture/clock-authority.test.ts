import { describe, expect, it } from 'vitest';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { completedTimeStatusChecks, timingAwarenessContract } from '../../../../src/sandbox/guest.ts';
import { clockRequest } from './clock-fixture.ts';
const clock = (status = 'completed', error: unknown = null) => ({ type: 'item.completed', item: {
	type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status, error,
	result: { content: [{ type: 'text', text: JSON.stringify({ ...window, remainingSeconds: 30 }) }],
		structuredContent: { ...window, remainingSeconds: 30 } } } });
const command = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', error: null } };
const window = { startedAt: '2026-10-04T00:00:00.000Z', deadlineAt: '2026-10-04T00:00:30.000Z' };
const reading = (remainingSeconds: number) => ({ ...window, remainingSeconds });
const mcpResult = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const observedClock = (result: unknown) => ({ ...clock(), item: { ...clock().item, result } });

describe('original productive clock and actual first final tool boundary contract', () => {
	it('counts complete immutable clock result bytes including a zero final reading without inventing completion authority', () => {
		for (const finalSeconds of [20, 0]) {
			const events = [observedClock(mcpResult(reading(30))), command, observedClock(mcpResult(reading(finalSeconds)))];
			const before = structuredClone(events);
			expect(completedTimeStatusChecks(events)).toBe(2);
			expect(timingAwarenessContract(events)).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
			expect(events).toEqual(before);
		}
		// Supplied result values are unit inputs, not an API retrieval or actual
		// model actions. Zero is a valid clock diagnosis, not permission to finish late.
	});
	it('refuses successful clock flags with missing malformed contradictory or out of bounds MCP result values without repairing events', () => {
		const invalidValues: unknown[] = [undefined, null, {}, [], 'clock', 30,
			{ deadlineAt: window.deadlineAt, remainingSeconds: 20 }, { startedAt: window.startedAt, remainingSeconds: 20 }, { ...window },
			{ ...reading(20), startedAt: 'invalid' }, { ...reading(20), deadlineAt: 'invalid' },
			{ ...reading(20), startedAt: window.deadlineAt, deadlineAt: window.startedAt },
			...[-1, 0.5, '20', null, NaN, Infinity, -Infinity, 31].map(remainingSeconds => ({ ...window, remainingSeconds }))];
		const invalidResults: unknown[] = [undefined, null, {}, ...invalidValues.map(mcpResult),
			{ ...mcpResult(reading(20)), isError: true },
			{ ...mcpResult(reading(20)), content: [] },
			{ ...mcpResult(reading(20)), content: [{ type: 'text', text: '{' }] },
			{ ...mcpResult(reading(20)), content: [{ type: 'text', text: JSON.stringify(reading(21)) }] }];
		const admitted: boolean[] = [];
		for (const result of invalidResults) {
			const events = [observedClock(mcpResult(reading(30))), command, observedClock(result)], before = structuredClone(events);
			const contract = timingAwarenessContract(events);
			admitted.push(completedTimeStatusChecks(events) >= 2 || (contract.completedChecks >= 2 && contract.firstToolCompliant && contract.finalToolCompliant));
			expect(events).toEqual(before);
		}
		expect(admitted).toEqual(invalidResults.map(() => false));
	});
	it('denies substituted productive windows and increasing remaining values across otherwise complete first and final clock results', () => {
		const finalValues = [
			{ ...reading(10), startedAt: '2026-10-04T00:00:01.000Z' },
			{ ...reading(10), deadlineAt: '2026-10-04T00:00:31.000Z' },
			{ startedAt: '2026-10-05T00:00:00.000Z', deadlineAt: '2026-10-05T00:00:30.000Z', remainingSeconds: 10 }, reading(21)];
		const admitted: boolean[] = [];
		for (const value of finalValues) {
			const events = [observedClock(mcpResult(reading(20))), command, observedClock(mcpResult(value))], before = structuredClone(events);
			const contract = timingAwarenessContract(events); admitted.push(contract.completedChecks >= 2 && contract.firstToolCompliant && contract.finalToolCompliant);
			expect(events).toEqual(before);
		}
		expect(admitted).toEqual(finalValues.map(() => false));
	});
	it('retains the same exact original productive window in both readings without changing the complete attempt', async () => {
		const f = clockRequest(), before = structuredClone(f.input.assignment);
		const readings = await Promise.all([executeAssignmentTreeDxTool(f.input, 'treeseed_time_status', {}, f.execution),
			executeAssignmentTreeDxTool(f.input, 'treeseed_time_status', {}, f.execution)]);
		for (const value of readings) expect(value).toMatchObject({ startedAt: f.execution.startedAt, deadlineAt: f.attempt.deadline });
		expect(f.input.assignment).toEqual(before);
	});
	it('denies a clock read before productive execution instead of inventing a start or charging preparation', async () => {
		const f = clockRequest(), before = structuredClone(f.input.assignment);
		await expect(executeAssignmentTreeDxTool(f.input, 'treeseed_time_status', {})).rejects.toThrow('Productive execution has not started');
		expect(f.input.assignment).toEqual(before);
	});
	it('denies malformed future reversed and widened productive clock authority rather than returning successful remaining time', async () => {
		const f = clockRequest(), outcomes: boolean[] = [];
		for (const authority of [{ ...f.execution, startedAt: 'invalid' }, { ...f.execution, deadlineAt: 'invalid' },
			{ startedAt: f.attempt.deadline, deadlineAt: f.execution.startedAt },
			{ ...f.execution, deadlineAt: new Date(Date.parse(f.attempt.deadline) + 1).toISOString() },
			{ ...f.execution, startedAt: new Date(Date.parse(f.attempt.deadline) + 1).toISOString() }]) {
			const before = structuredClone(f.input.assignment);
			try { await executeAssignmentTreeDxTool(f.input, 'treeseed_time_status', {}, authority); outcomes.push(false); } catch { outcomes.push(true); }
			expect(f.input.assignment).toEqual(before);
		}
		expect(outcomes).toEqual(Array(5).fill(true));
	});
	it('requires two successful clock actions in actual first and final positions without granting compliance to failed checks', () => {
		expect(timingAwarenessContract([clock(), command, clock()])).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
		const outcomes = [[command, clock(), clock()], [clock(), clock(), command], [clock('failed', 'denied'), command, clock()],
			[clock(), command, clock('failed', 'denied')], [clock()], []].map(events => {
			const receipt = timingAwarenessContract(events); return receipt.completedChecks >= 2 && receipt.firstToolCompliant && receipt.finalToolCompliant;
		});
		expect(outcomes).toEqual(Array(6).fill(false));
	});
	it('reports zero remaining at the original expired boundary without increasing the allocation or retry allowance', async () => {
		const f = clockRequest(); f.attempt.createdAt = '2000-01-01T00:00:00.000Z'; f.attempt.deadline = '2000-01-01T00:00:30.000Z';
		const authority = { startedAt: f.attempt.createdAt, deadlineAt: f.attempt.deadline }, before = structuredClone(f.input.assignment);
		expect(await executeAssignmentTreeDxTool(f.input, 'treeseed_time_status', {}, authority)).toEqual({ ...authority, remainingSeconds: 0 });
		expect(f.input.assignment).toEqual(before);
	});
});
