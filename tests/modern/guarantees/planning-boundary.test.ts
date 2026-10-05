import { describe, expect, it, vi } from 'vitest';
import { enforcePlanningBoundary } from '../../acceptance/planning-boundary.ts';

const start = Date.parse('2026-09-27T01:00:00Z');
const run = { executionMode: 'simulation', status: 'running', startedAt: new Date(start).toISOString(),
	parameters: { durationSeconds: 7200, planningPercent: 20 } };
describe('automatic planning boundary (fixtures are not campaign acceptance)', () => {
	it('does not stop a healthy completed collaboration boundary', () => {
		const stop = vi.fn();
		enforcePlanningBoundary(run, start + 1440000, () => {}, stop);
		expect(stop).not.toHaveBeenCalled();
	});
	it('stops once and retains the exact criterion failure rather than passing cleanup', () => {
		const failure = new Error('ACCEPTANCE_PLANNING_ROLE_TURNS: Missing second cycle'), stop = vi.fn();
		expect(() => enforcePlanningBoundary(run, start + 1440000, () => { throw failure; }, stop)).toThrow(failure);
		expect(stop).toHaveBeenCalledTimes(1);
	});
	it('never stops production, terminal, early or malformed-window runs', () => {
		for (const [snapshot, now] of [[{ ...run, executionMode: 'production' }, start + 1440000],
			[{ ...run, status: 'completed' }, start + 1440000], [run, start + 1],
			[{ ...run, startedAt: 'invalid' }, start + 1440000]] as const) {
			const verify = vi.fn(), stop = vi.fn();
			expect(() => enforcePlanningBoundary(snapshot, now, verify, stop)).toThrow();
			expect(verify).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
		}
	});
	it('does not mistake transport errors for criterion failure and fails closed on stop failure', () => {
		const stop = vi.fn();
		expect(() => enforcePlanningBoundary(run, start + 1440000, () => { throw new Error('transport'); }, stop)).toThrow('transport');
		expect(stop).not.toHaveBeenCalled();
		expect(() => enforcePlanningBoundary(run, start + 1440000,
			() => { throw new Error('ACCEPTANCE_ESTIMATE_ROLES: missing'); },
			() => { throw new Error('private backend details'); })).toThrow('ACCEPTANCE_GUARD_STOP_FAILED');
	});
});
