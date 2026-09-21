import { describe, expect, it } from 'vitest';
import { orderConnectionsForFairPolling } from '../../../src/provider/teams/multi-team-runtime.ts';

const connections = ['a', 'b', 'c'].map((id) => ({ connection: { id }, teamId: id }));

describe('provider-global connection polling', () => {
	it('prefers never-served teams, then the least recently leased, with stable ties', () => {
		const ordered = orderConnectionsForFairPolling(connections, {
			claims: [], events: [
				{ connectionId: 'b', outcome: 'leased' },
				{ connectionId: 'a', outcome: 'leased' },
			],
		});
		expect(ordered.map((entry) => entry.connection.id)).toEqual(['c', 'b', 'a']);
	});

	it('prefers idle teams over one already holding a host slot', () => {
		const ordered = orderConnectionsForFairPolling(connections, {
			claims: [{ connectionId: 'c' }], events: [],
		});
		expect(ordered.map((entry) => entry.connection.id)).toEqual(['a', 'b', 'c']);
	});

	it('does not give a team extra priority for owning multiple connections', () => {
		const ordered = orderConnectionsForFairPolling([
			{ connection: { id: 'a1' }, teamId: 'a' },
			{ connection: { id: 'a2' }, teamId: 'a' },
			{ connection: { id: 'b1' }, teamId: 'b' },
		], { claims: [], events: [{ connectionId: 'a1', outcome: 'leased' }] });
		expect(ordered.map((entry) => entry.connection.id)).toEqual(['b1', 'a2', 'a1']);
	});

	it('uses persisted daily active time across every connection of a team', () => {
		const ordered = orderConnectionsForFairPolling([
			{ connection: { id: 'a1' }, teamId: 'a' },
			{ connection: { id: 'a2' }, teamId: 'a' },
			{ connection: { id: 'b1' }, teamId: 'b' },
		], { claims: [], events: [], activeSecondsByConnection: { a1: 30, a2: 20, b1: 40 } });
		expect(ordered[0]?.teamId).toBe('b');
	});
});
