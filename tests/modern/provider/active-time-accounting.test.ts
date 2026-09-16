import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';

afterEach(() => vi.useRealTimers());
describe('provider active-time accounting', () => {
	it('enforces capability and shared model caps atomically across teams and persists actual consumption', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-accounting-'));
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const reserve = async (connectionId: string, capabilityId: string, seconds: number) => {
				const claim = await store.claim({ connectionId, globalLimit: 4, connectionLimit: 4 });
				await store.attachLease(claim!.id, { assignmentId: claim!.id, leaseToken: 'test-only', leaseExpiresAt: '2026-09-17T01:00:00Z',
					requestedSeconds: seconds, dispatchEnvelope: {}, accounting: { modelConfigurationId: 'terra', capabilityId,
						dailyActiveSecondsLimit: 100, capabilityDailyActiveSecondsLimit: 60 } });
				return claim!;
			};
			const first = await reserve('team-a', 'implementation', 60);
			await expect(reserve('team-b', 'implementation', 1)).rejects.toThrow('exhausted');
			await expect(reserve('team-b', 'research', 41)).rejects.toThrow('exhausted');
			await store.claimDispatch(['team-a']);
			await store.beginActiveExecution(first.id);
			vi.setSystemTime(new Date('2026-09-16T12:00:20Z'));
			await store.finishActiveExecution(first.id);
			await expect(store.beginActiveExecution(first.id)).rejects.toThrow('cannot restart');
			await store.finalize(first.id, 'completed');
			const restarted = new ProviderLocalCapacityStore(root);
			const observation = await restarted.activeTimeObservation('terra', ['implementation']);
			expect(observation.modelUsage).toEqual({ day: '2026-09-16', activeSeconds: 20, reservedSeconds: 0 });
			expect(observation.capabilityUsage.implementation?.activeSeconds).toBe(20);
			await reserve('team-c', 'implementation', 40);
			await expect(reserve('team-d', 'implementation', 1)).rejects.toThrow('exhausted');
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	it('splits running consumption across UTC midnight without duplicate charges on restart or repeated observations', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-rollover-'));
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-16T23:59:50Z'));
		try {
			let store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'team', globalLimit: 1, connectionLimit: 1 });
			await store.attachLease(claim!.id, { assignmentId: 'assignment', leaseToken: 'test-only', leaseExpiresAt: '2026-09-17T01:00:00Z',
				requestedSeconds: 60, dispatchEnvelope: {}, accounting: { capabilityId: 'implementation', modelConfigurationId: 'terra',
					dailyActiveSecondsLimit: 100, capabilityDailyActiveSecondsLimit: 100 } });
			await store.claimDispatch(); await store.beginActiveExecution(claim!.id);
			vi.setSystemTime(new Date('2026-09-17T00:00:10Z'));
			store = new ProviderLocalCapacityStore(root);
			for (let attempt = 0; attempt < 2; attempt++) expect((await store.activeTimeObservation('terra', ['implementation'])).modelUsage)
				.toEqual({ day: '2026-09-17', activeSeconds: 10, reservedSeconds: 40 });
			await store.finishActiveExecution(claim!.id);
			vi.setSystemTime(new Date('2026-09-17T00:00:30Z'));
			expect((await store.activeTimeObservation('terra', ['implementation'])).modelUsage.activeSeconds).toBe(10);
			await store.finalize(claim!.id, 'completed');
			expect((await store.activeTimeObservation('terra', ['implementation'])).modelUsage.reservedSeconds).toBe(0);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	it('rejects nonfinite provider assignment bounds before persisting a reservation', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-invalid-accounting-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'team', globalLimit: 1, connectionLimit: 1 });
			await expect(store.attachLease(claim!.id, { assignmentId: 'assignment', leaseToken: 'test-only',
				leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), requestedSeconds: 60, dispatchEnvelope: {},
				accounting: { capabilityId: 'implementation', modelConfigurationId: 'terra', dailyActiveSecondsLimit: 100,
					capabilityDailyActiveSecondsLimit: 100, maximumAssignmentSeconds: NaN } })).rejects.toThrow('bounds are invalid');
			expect((await store.snapshot()).claims[0]?.status).toBe('polling');
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
