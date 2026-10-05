import { describe, expect, it, vi } from 'vitest';
import { orderConnectionsForFairPolling } from '../../../src/provider/teams/multi-team-runtime.ts';
import { publishProviderAvailability } from '../../../src/provider/lifecycle/lifecycle.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import type { ProviderConnectionRuntimeContext } from '../../../src/provider/configuration/config.ts';

const connections = ['a', 'b', 'c'].map((id) => ({ connection: { id }, teamId: id }));

describe('provider-global connection polling', () => {
	it('publishes exact retained connection assignment identities without leaking lease custody or inventing assignments for polling slots', async () => {
		const config: ProviderConnectionRuntimeContext = { dataDir: '/unused-unit-provider', environment: 'test', manifestPath: null,
			maxConcurrentRunners: 5, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
			env: {}, redactedEnv: {}, connectionId: 'owner', teamId: 'team', providerId: 'provider', membershipId: 'membership',
			controlPlaneUrl: 'http://unit.invalid', controlPlaneAudience: 'http://unit.invalid', accessToken: 'unit-token',
			adapters: [], lanes: [], providerCapacity: { maxConcurrentWorkers: 5 } };
		const claims = (['ready', 'running', 'recovery', 'polling'] as const).map((status, index) => ({
			id: `claim-${index}`, connectionId: 'owner', runnerId: `runner-${index}`, status,
			...(status === 'polling' ? {} : { assignmentId: `assignment-${index}` }), leaseToken: status === 'polling' ? undefined : '<redacted>',
			acquiredAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', expiresAt: '2026-10-05T00:01:00.000Z',
		}));
		claims.push({ ...claims[0]!, id: 'foreign-claim', connectionId: 'foreign', assignmentId: 'foreign-assignment' });
		claims.push({ ...claims[0]!, id: 'repeated-observation' });
		const native = { revision: 1, claims, events: [], activeSecondsByConnection: {} }, before = structuredClone(native);
		const availability = { adapters: [], lanes: [], capacity: { maxConcurrentWorkers: 5 }, activeWorkers: 5 }, held = structuredClone(availability);
		const store = new ProviderLocalCapacityStore(config.dataDir), bodies: unknown[] = [];
		vi.spyOn(store, 'snapshot').mockResolvedValue(native); vi.spyOn(store, 'session').mockResolvedValue(null);
		vi.spyOn(store, 'saveSession').mockImplementation(async (_key, session) => session);
		vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
			bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ data: { id: 'session', sequence: 1, status: 'open' } }),
				{ status: 200, headers: { 'content-type': 'application/json' } });
		}));
		try {
			await publishProviderAvailability(config, availability, store);
			expect(bodies).toHaveLength(1);
			expect(bodies[0]).toMatchObject({ runnerPressure: { activeWorkers: 5, maxConcurrentWorkers: 5,
				activeAssignmentIds: ['assignment-0', 'assignment-1', 'assignment-2'] } });
			expect(JSON.stringify(bodies)).not.toContain('leaseToken'); expect(JSON.stringify(bodies)).not.toContain('foreign-assignment');
			expect(native).toEqual(before); expect(availability).toEqual(held);
			const failure = new Error('Original local inventory unavailable');
			vi.mocked(store.snapshot).mockRejectedValueOnce(failure);
			await expect(publishProviderAvailability(config, availability, store)).rejects.toBe(failure);
			expect(bodies).toHaveLength(1); expect(native).toEqual(before);
		} finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
	});
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
