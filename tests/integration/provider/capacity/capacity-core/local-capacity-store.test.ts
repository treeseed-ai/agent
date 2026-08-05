import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderLocalCapacityStore } from '../../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { compileProviderLocalNativeLimit } from '../../../../../src/provider/capacity/capacity-core/native-capacity-limits.ts';

describe('durable provider-local capacity claims', () => {
	it('admits one simultaneous final slot and survives a new store instance', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-capacity-state-'));
		try {
			const firstProcess = new ProviderLocalCapacityStore(root);
			const secondProcess = new ProviderLocalCapacityStore(root);
			const claims = await Promise.all([
				firstProcess.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 }),
				secondProcess.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 }),
			]);
			expect(claims.filter(Boolean)).toHaveLength(1);
			const winner = claims.find((claim) => claim !== null)!;
			await firstProcess.attachLease(winner.id, { assignmentId: 'assignment-a', leaseToken: 'lease-secret', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: { ok: true, payload: { id: 'assignment-a' }, leaseToken: 'lease-secret' } });
			expect((await new ProviderLocalCapacityStore(root).snapshot()).claims).toEqual([expect.objectContaining({ id: winner.id, status: 'ready', leaseToken: '<redacted>' })]);
			expect(await new ProviderLocalCapacityStore(root).claimsForRecovery()).toEqual([]);
			expect(await secondProcess.claimDispatch()).toEqual(expect.objectContaining({ id: winner.id, status: 'running', dispatchEnvelope: expect.any(Object) }));
			const recovered = await new ProviderLocalCapacityStore(root).claimsForRecovery();
			expect(recovered).toEqual([expect.objectContaining({ id: winner.id, status: 'running', assignmentId: 'assignment-a', leaseToken: 'lease-secret' })]);
			expect(await secondProcess.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 })).toBeNull();
			await secondProcess.release(winner.id);
			expect(await firstProcess.finalize(winner.id, 'assignment-lifecycle-confirmed')).toBe(false);
			expect(await secondProcess.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 })).not.toBeNull();
			await firstProcess.saveSession('team-a|membership-a', { id: 'session-a', sequence: 2 });
			expect(await new ProviderLocalCapacityStore(root).session('team-a|membership-a')).toMatchObject({ id: 'session-a', sequence: 2 });
			await firstProcess.saveToken('team-a', { id: 'token-a', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', credentialId: 'credential-a', status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: 'token-secret', identityVersion: 1 });
			expect(await new ProviderLocalCapacityStore(root).token('team-a')).toMatchObject({ id: 'token-a', accessToken: 'token-secret' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('retains unconfirmed running work and records bounded terminal evidence', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-lifecycle-evidence-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Expected a local claim.');
			await store.attachLease(claim.id, { assignmentId: 'assignment-a', leaseToken: 'secret', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {} });
			await store.claimDispatch(['team-a']);
			await store.recordFailure(claim.id, 'control plane unavailable');
		expect((await store.snapshot()).claims).toEqual([expect.objectContaining({ id: claim.id, status: 'recovery' })]);
			await store.finalize(claim.id, 'assignment-lifecycle-confirmed');
			const snapshot = await store.snapshot();
			expect(snapshot.claims).toEqual([]);
			expect(snapshot.events).toEqual(expect.arrayContaining([
				expect.objectContaining({ claimId: claim.id, outcome: 'lifecycle-unconfirmed', message: 'control plane unavailable' }),
				expect.objectContaining({ claimId: claim.id, outcome: 'assignment-lifecycle-confirmed' }),
			]));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('serializes execution-provider and lane concurrency and native allowance', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-native-state-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const first = await store.claim({ connectionId: 'team-a', globalLimit: 2, connectionLimit: 2 });
			const second = await store.claim({ connectionId: 'team-b', globalLimit: 2, connectionLimit: 2 });
			if (!first || !second) throw new Error('Expected two generic claims.');
			const limit = { maxConcurrentRunners: 1, availableCredits: 5 };
			await store.attachLease(first.id, { assignmentId: 'assignment-a', leaseToken: 'lease-a', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {}, executionProviderId: 'codex', laneId: 'research', requestedCredits: 4, executionProviderLimit: limit, laneLimit: limit });
			await expect(store.attachLease(second.id, { assignmentId: 'assignment-b', leaseToken: 'lease-b', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {}, executionProviderId: 'codex', laneId: 'research', requestedCredits: 2, executionProviderLimit: limit, laneLimit: limit })).rejects.toThrow(/concurrency is exhausted/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('accounts arbitrary native units with configured reserve buffers', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-native-units-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const first = await store.claim({ connectionId: 'team-a', globalLimit: 2, connectionLimit: 2 });
			const second = await store.claim({ connectionId: 'team-b', globalLimit: 2, connectionLimit: 2 });
			if (!first || !second) throw new Error('Expected two generic claims.');
			const limit = compileProviderLocalNativeLimit({
				executionProviderId: 'codex', nativeLimits: { maxConcurrentRunners: 2 },
				budgets: { nativeCapacity: { executionProviders: [{ id: 'codex', name: 'Codex', kind: 'codex', nativeUnit: 'wall_minute', nativeLimits: [{ nativeUnit: 'wall_minute', limitAmount: 10, reserveBufferPercent: 20 }] }] } },
			});
			expect(limit.nativeAllowances).toEqual({ wall_minute: 8 });
			await store.attachLease(first.id, { assignmentId: 'assignment-a', leaseToken: 'lease-a', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {}, executionProviderId: 'codex', nativeUnit: 'wall_minute', requestedNativeAmount: 6, executionProviderLimit: limit });
			await expect(store.attachLease(second.id, { assignmentId: 'assignment-b', leaseToken: 'lease-b', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {}, executionProviderId: 'codex', nativeUnit: 'wall_minute', requestedNativeAmount: 3, executionProviderLimit: limit })).rejects.toThrow(/wall_minute allowance is exhausted/u);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
