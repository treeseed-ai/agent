import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../kernel/provider-kernel-fixture.ts';

afterEach(() => vi.useRealTimers());
// UNIT substitutes only filesystem persistence. The ORIGINAL owning store still
// performs every transition; this is not an alternative runtime/store/clock.
async function suppliedRecoveryStore() {
	let bytes: string | undefined, pending = '';
	vi.resetModules();
	vi.doMock('node:fs/promises', () => ({
		mkdir: async () => undefined, rm: async () => undefined, stat: async () => ({ mtimeMs: Date.now() }),
		readFile: async () => { if (bytes === undefined) throw Object.assign(new Error('Supplied absent state'), { code: 'ENOENT' }); return bytes; },
		writeFile: async (_path: string, value: string) => { pending = value; }, rename: async () => { bytes = pending; },
	}));
	try {
		const { ProviderLocalCapacityStore: OriginalStore } = await import('../../../src/provider/capacity/capacity-core/local-capacity-store.ts');
		const store = new OriginalStore('/unit/no-files-created'), original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
		const createdAt = new Date().toISOString(), attempt = assignmentAttemptSchema.parse({ ...original, createdAt,
			deadline: new Date(Date.parse(createdAt) + original.limits.maximumSeconds * 1_000).toISOString() });
		const claim = await store.claim({ connectionId: 'unit-owner', globalLimit: 1, connectionLimit: 1 });
		if (!claim) throw new Error('Original supplied slot required');
		const lease = { assignmentId: attempt.id, leaseToken: 'unit-private-lease', leaseExpiresAt: attempt.deadline,
			executionProviderId: attempt.provider.executionProviderId, requestedSeconds: attempt.limits.maximumSeconds,
			dispatchEnvelope: { assignment: { id: attempt.id, assignmentAttempt: attempt } } };
		await store.attachLease(claim.id, lease); await store.claimDispatch(claim.id);
		return { store, claim, lease, attempt, bytes: () => bytes,
			close: () => { vi.doUnmock('node:fs/promises'); vi.resetModules(); } };
	} catch (error) { vi.doUnmock('node:fs/promises'); vi.resetModules(); throw error; }
}
describe('provider active-time accounting', () => {
	it('denies a positive reservation against either valid zero quota without changing the supplied polling claim or prior recovery history', async () => {
		const f = await suppliedRecoveryStore();
		try {
			await f.store.recordFailure(f.claim.id, 'original supplied quota history');
			const claim = await f.store.claim({ connectionId: 'unit-other-team', globalLimit: 2, connectionLimit: 1 });
			if (!claim) throw new Error('Original supplied second polling slot required');
			const before = f.bytes();
			for (const scope of ['model', 'capability'] as const) {
				const input = { ...f.lease, assignmentId: 'unit-quota-target', requestedSeconds: 1,
					accounting: { capabilityId: f.attempt.provider.executionCapabilityId, modelConfigurationId: f.attempt.provider.modelConfigurationId,
						dailyActiveSecondsLimit: scope === 'model' ? 0 : 1,
						capabilityDailyActiveSecondsLimit: scope === 'capability' ? 0 : 1, maximumAssignmentSeconds: 1 } };
				const saved = structuredClone(input);
				await expect(f.store.attachLease(claim.id, input)).rejects.toThrow('Provider-local daily active-time capacity is exhausted.');
				expect(f.bytes()).toBe(before); expect(input).toEqual(saved);
			}
			const held = await f.store.claimsForRecovery();
			expect(held).toHaveLength(1); expect(held[0]?.failureMessage).toBe('original supplied quota history');
			expect(held[0]?.dispatchEnvelope).toEqual(f.lease.dispatchEnvelope);
			expect((await f.store.snapshot()).claims.find(value => value.id === claim.id)?.status).toBe('polling');
		} finally { f.close(); }
	});
	it('keeps the first supplied closeout output and failure immutable under exact replay and rejects substituted output before persistence', async () => {
		const f = await suppliedRecoveryStore(); try {
			const output = { status: 'blocked', unfinishedWork: ['original work'], sandboxId: 'unit-original',
				teardown: { verified: true, completedAt: new Date().toISOString() }, usage: { elapsedSeconds: 1.125 } };
			await f.store.recordCloseoutOutput(f.claim.id, output); await f.store.recordFailure(f.claim.id, 'original failed execution');
			await f.store.recordCloseoutOutput(f.claim.id, structuredClone(output));
			const before = f.bytes(), originalInput = structuredClone(output), outcomes: boolean[] = [];
			for (const replacement of [{ ...output, status: 'completed' }, { ...output, unfinishedWork: [] },
				{ ...output, sandboxId: 'foreign' }, { ...output, usage: { elapsedSeconds: 0 } },
				{ ...output, teardown: { verified: false, completedAt: null } }, {}]) {
				try { await f.store.recordCloseoutOutput(f.claim.id, replacement); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.bytes() === before).toBe(true);
			}
			expect(outcomes).toEqual(Array(6).fill(true)); expect(output).toEqual(originalInput);
			const held = (await f.store.claimsForRecovery())[0]; expect(held?.closeoutOutput).toEqual(output);
			expect(held?.failureMessage).toBe('original failed execution'); expect(held?.dispatchEnvelope).toEqual(f.lease.dispatchEnvelope);
		} finally { f.close(); }
	});
	it('refuses replacement of a supplied retained lease identity or frozen envelope while keeping the exact original recovery retry valid', async () => {
		const f = await suppliedRecoveryStore(); try {
			await f.store.recordFailure(f.claim.id, 'original interrupted execution');
			const original = { assignmentId: f.lease.assignmentId, leaseToken: f.lease.leaseToken,
				leaseExpiresAt: f.lease.leaseExpiresAt, dispatchEnvelope: f.lease.dispatchEnvelope };
			await f.store.retainLease(f.claim.id, structuredClone(original));
			const before = f.bytes(), inputBefore = structuredClone(original), outcomes: boolean[] = [];
			for (const replacement of [{ ...original, assignmentId: 'foreign' }, { ...original, leaseToken: 'foreign' },
				{ ...original, leaseExpiresAt: new Date(Date.parse(f.attempt.deadline) + 1).toISOString() },
				{ ...original, dispatchEnvelope: {} }, { ...original, dispatchEnvelope: { assignment: { id: f.attempt.id,
					assignmentAttempt: { ...f.attempt, nodeRevision: f.attempt.nodeRevision + 1 } } } }]) {
				try { await f.store.retainLease(f.claim.id, replacement); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.bytes() === before).toBe(true);
			}
			expect(outcomes).toEqual(Array(5).fill(true)); expect(original).toEqual(inputBefore);
		} finally { f.close(); }
	});
	it('denies missing malformed expired and widened supplied renewal clocks without replacing the original attempt deadline', async () => {
		const f = await suppliedRecoveryStore(); try {
			await f.store.renewLease(f.claim.id, { assignmentId: f.attempt.id, leaseExpiresAt: f.attempt.deadline });
			const before = f.bytes(), inputBefore = structuredClone(f.lease), outcomes: boolean[] = [];
			for (const leaseExpiresAt of [undefined, null, '', 'invalid', Date.parse(f.attempt.deadline),
				'2000-01-01T00:00:00.000Z', new Date(Date.parse(f.attempt.deadline) + 1).toISOString()]) {
				const supplied = Object.assign({ assignmentId: f.attempt.id, leaseExpiresAt: f.attempt.deadline }, { leaseExpiresAt });
				try { await f.store.renewLease(f.claim.id, supplied); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.bytes() === before).toBe(true);
			}
			expect(outcomes).toEqual(Array(7).fill(true)); expect(f.lease).toEqual(inputBefore);
		} finally { f.close(); }
	});
	it('admits a positive short assignment without a provider minimum and releases unused time on early finish', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-short-assignment-'));
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'team', globalLimit: 1, connectionLimit: 1 });
			await store.attachLease(claim!.id, { assignmentId: 'short', leaseToken: 'test-only',
				leaseExpiresAt: '2026-09-16T12:05:00Z', requestedSeconds: 30, dispatchEnvelope: {},
				accounting: { capabilityId: 'implementation', modelConfigurationId: 'luna',
					dailyActiveSecondsLimit: 100, capabilityDailyActiveSecondsLimit: 100, maximumAssignmentSeconds: 60 } });
			await store.claimDispatch(claim!.id); await store.beginActiveExecution(claim!.id);
			vi.setSystemTime(new Date('2026-09-16T12:00:02Z'));
			await store.finishActiveExecution(claim!.id); await store.finalize(claim!.id, 'completed');
			expect((await store.activeTimeObservation('luna', ['implementation'])).modelUsage)
				.toEqual({ day: '2026-09-16', activeSeconds: 2, reservedSeconds: 0 });
		} finally { await rm(root, { recursive: true, force: true }); }
	});
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
			await store.claimDispatch(first.id);
			await store.beginActiveExecution(first.id);
			vi.setSystemTime(new Date('2026-09-16T12:00:20Z'));
			await store.finishActiveExecution(first.id);
			await expect(store.beginActiveExecution(first.id)).rejects.toThrow('cannot restart');
			await store.finalize(first.id, 'completed');
			const restarted = new ProviderLocalCapacityStore(root);
			const observation = await restarted.activeTimeObservation('terra', ['implementation']);
			expect(observation.modelUsage).toEqual({ day: '2026-09-16', activeSeconds: 20, reservedSeconds: 0 });
			expect(observation.capabilityUsage.implementation?.activeSeconds).toBe(20);
			expect((await restarted.snapshot()).activeSecondsByConnection['team-a']).toBe(20);
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
			await store.claimDispatch(claim!.id); await store.beginActiveExecution(claim!.id);
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
