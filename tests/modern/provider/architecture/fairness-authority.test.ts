import { describe, expect, it } from 'vitest';
import { orderConnectionsForFairPolling } from '../../../../src/provider/teams/multi-team-runtime.ts';

const connections = [
	{ connection: { id: 'busy-1' }, teamId: 'busy-team' },
	{ connection: { id: 'busy-2' }, teamId: 'busy-team' },
	{ connection: { id: 'quiet-1' }, teamId: 'quiet-team' },
];
describe('document-wide provider-global fairness authority', () => {
	it('aggregates actual seconds across all connections before comparing eligible teams without mutating scheduling inputs', () => {
		const snapshot = { claims: [], events: [], activeSecondsByConnection: { 'busy-1': 3, 'busy-2': 4, 'quiet-1': 6 } };
		const original = structuredClone({ connections, snapshot });
		expect(orderConnectionsForFairPolling(connections, snapshot).map(item => item.connection.id)).toEqual(['quiet-1', 'busy-1', 'busy-2']);
		expect({ connections, snapshot }).toEqual(original);
	});
	it('uses team occupancy then team recency then connection occupancy and stable identity only after equal actual usage', () => {
		const snapshot = { claims: [{ connectionId: 'busy-1' }],
			events: [{ connectionId: 'quiet-1', outcome: 'leased' }, { connectionId: 'busy-1', outcome: 'leased' }],
			activeSecondsByConnection: { 'busy-1': 2, 'busy-2': 4, 'quiet-1': 6 } };
		expect(orderConnectionsForFairPolling(connections, snapshot).map(item => item.connection.id)).toEqual(['quiet-1', 'busy-2', 'busy-1']);
	});
	it('does not let extra connections foreign history or nonlease events manufacture a team fairness entitlement', () => {
		const snapshot = { claims: [{ connectionId: 'foreign' }], events: [
			{ connectionId: 'busy-1', outcome: 'leased' }, { connectionId: 'quiet-1', outcome: 'failed' },
			{ connectionId: 'foreign', outcome: 'leased' }], activeSecondsByConnection: { foreign: 900 } };
		expect(orderConnectionsForFairPolling(connections, snapshot).map(item => item.connection.id)).toEqual(['quiet-1', 'busy-2', 'busy-1']);
	});
	it('keeps stable global eligible-team ordering under connection inventory permutations and an empty initial history', () => {
		for (const inventory of [connections, [...connections].reverse(), [connections[1]!, connections[2]!, connections[0]!]]) {
			expect(orderConnectionsForFairPolling(inventory, { claims: [], events: [] }).map(item => item.connection.id))
				.toEqual(['busy-1', 'busy-2', 'quiet-1']);
		}
		expect(orderConnectionsForFairPolling([], { claims: [], events: [] })).toEqual([]);
	});
	it('denies negative nonfinite and coerced actual-second authority instead of selecting a successful global order', () => {
		const outcomes = [-1, NaN, Infinity, '3'].map(value => {
			// Deliberately malformed wire input, not a changed public schema or valid native measurement.
			const snapshot = JSON.parse(JSON.stringify({ claims: [], events: [], activeSecondsByConnection: { 'busy-1': value } }));
			try { orderConnectionsForFairPolling(connections, snapshot); return 'admitted'; } catch { return 'denied'; }
		});
		expect(outcomes).toEqual(['denied', 'denied', 'denied', 'denied']);
	});
});
