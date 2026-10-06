import { describe, expect, it, vi } from 'vitest';
import { orderConnectionsForFairPolling } from '../../../src/provider/teams/multi-team-runtime.ts';
import { publishProviderAvailability } from '../../../src/provider/lifecycle/lifecycle.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import type { ProviderConnectionRuntimeContext } from '../../../src/provider/configuration/config.ts';
import * as manifestLoader from '../../../src/provider/configuration/manifest.ts';
import * as leaseRecovery from '../../../src/provider/coordination/lease-recovery.ts';
import * as diskCapacity from '../../../src/provider/runtime/disk-capacity.ts';
import { CapacityProviderCoordinator } from '../../../src/provider/coordination/coordinator.ts';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';
import { runMultiTeamProviderManager, runMultiTeamProviderRunners } from '../../../src/provider/teams/multi-team-runtime.ts';

const connections = ['a', 'b', 'c'].map((id) => ({ connection: { id }, teamId: id }));

describe('provider-global connection polling', () => {
	it('uses one freshly validated manifest per manager or runner invocation without rereading or caching authority across invocations', async () => {
		const digest = `sha256:${'d'.repeat(64)}`, manifest = createManagedProviderManifestV5({ release: 'unit-invocation',
			guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
		const config = { dataDir: '/unused-unit-manifest', manifestPath: '/unused-unit-manifest/manifest.yaml', environment: 'test',
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
			env: { TREESEED_PROVIDER_RUNTIME_BUILD: digest }, redactedEnv: {} };
		const loaded = { path: config.manifestPath, directory: config.dataDir, dataDirectory: config.dataDir, manifest };
		const before = structuredClone({ config, loaded }), failure = new Error('Original independent manifest read refused');
		const loader = vi.spyOn(manifestLoader, 'loadProviderManifest');
		const reconcile = vi.spyOn(CapacityProviderCoordinator.prototype, 'reconcileAll').mockResolvedValue([]);
		vi.spyOn(ProviderLocalCapacityStore.prototype, 'snapshot').mockResolvedValue({ revision: 1, claims: [], events: [], activeSecondsByConnection: {} });
		vi.spyOn(leaseRecovery, 'recoverProviderLocalLeases').mockResolvedValue([]);
		vi.spyOn(diskCapacity, 'observeProviderDiskCapacity').mockResolvedValue(diskCapacity.evaluateProviderDiskCapacity({
			path: config.dataDir, totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }));
		try {
			for (const run of [runMultiTeamProviderManager, runMultiTeamProviderRunners]) {
				loader.mockReset(); reconcile.mockClear(); loader.mockResolvedValueOnce(loaded).mockRejectedValue(failure);
				const result = await run(config);
				expect(result.ok).toBe(true); expect(loader).toHaveBeenCalledExactlyOnceWith(config.manifestPath, config.dataDir);
				expect(reconcile).toHaveBeenCalledTimes(1);
				await expect(run(config)).rejects.toBe(failure);
				expect(loader).toHaveBeenCalledTimes(2); expect(reconcile).toHaveBeenCalledTimes(1);
				expect({ config, loaded }).toEqual(before);
			}
		} finally { vi.restoreAllMocks(); }
	});
	it('preserves original availability session authority on every non-recoverable refresh failure and recreates only the owning closed or changed session conflict', async () => {
		const config: ProviderConnectionRuntimeContext = { dataDir: '/unused-unit-provider', environment: 'test', manifestPath: null,
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
			env: {}, redactedEnv: {}, connectionId: 'owner', teamId: 'team', providerId: 'provider', membershipId: 'membership',
			controlPlaneUrl: 'http://unit.invalid', controlPlaneAudience: 'http://unit.invalid', accessToken: 'unit-token',
			adapters: [], lanes: [], providerCapacity: { maxConcurrentWorkers: 1 } };
		const store = new ProviderLocalCapacityStore(config.dataDir), prior = { connectionId: 'owner|team|provider', id: 'original-session', sequence: 7, updatedAt: '2026-10-05T00:00:00.000Z' };
		const availability = { adapters: [], lanes: [], capacity: { maxConcurrentWorkers: 1 } }, before = structuredClone({ availability, prior });
		vi.spyOn(store, 'snapshot').mockResolvedValue({ revision: 1, claims: [], events: [], activeSecondsByConnection: {} });
		vi.spyOn(store, 'session').mockResolvedValue(prior); const remove = vi.spyOn(store, 'removeSession').mockResolvedValue();
		const save = vi.spyOn(store, 'saveSession').mockImplementation(async (_key, session) => session);
		const outcomes = []; let status = 200, code = '', fault = '', methods: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
			methods.push(String(init.method));
			if (init.method === 'PUT' && fault === 'reset') throw new Error('Original transport interruption');
			return new Response(init.method === 'PUT' && fault === 'json' ? '{' : JSON.stringify(init.method === 'PUT' && status !== 200
				? { type: 'about:blank', title: 'Original denial', status, code }
				: { data: { id: 'new-session', sequence: 1, status: 'open' } }),
				{ status: init.method === 'PUT' ? status : 200, headers: { 'content-type': 'application/json' } });
		}));
		try {
			for (const failure of [{ status: 401 }, { status: 403 }, { status: 400 }, { status: 503 }, { status: 409 },
				{ status: 200, fault: 'reset' }, { status: 200, fault: 'json' }]) {
				status = failure.status; code = 'isolated_denial'; fault = failure.fault ?? ''; methods = []; remove.mockClear(); save.mockClear();
				let cause: unknown; try { await publishProviderAvailability(config, availability, store); } catch (error) { cause = error; }
				outcomes.push({ failed: cause instanceof Error, methods: [...methods], removes: remove.mock.calls.length, saves: save.mock.calls.length });
			}
			status = 409; code = 'provider_availability_refresh_conflict'; fault = ''; methods = []; remove.mockClear(); save.mockClear();
			await publishProviderAvailability(config, availability, store);
			expect(methods).toEqual(['PUT', 'POST']); expect(remove).toHaveBeenCalledWith(prior.connectionId);
			expect(save).toHaveBeenCalledWith(prior.connectionId, { id: 'new-session', sequence: 1 });
			expect({ availability, prior }).toEqual(before);
			expect(outcomes).toEqual(Array.from({ length: 7 }, () => ({ failed: true, methods: ['PUT'], removes: 0, saves: 0 })));
		} finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
	});
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
