import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccessTokenIssue } from '@treeseed/sdk/capacity-provider/contracts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';

const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('read-only provider capacity observations', () => {
	it('returns the established empty state for a missing file without creating persisted state', async () => {
		const root = await mkdtemp(join(tmpdir(), 'provider-empty-observation-')); roots.push(root);
		const store = new ProviderLocalCapacityStore(root);
		expect(await store.snapshot()).toMatchObject({ revision: 0, claims: [], events: [], activeSecondsByConnection: {} });
		expect((await store.activeTimeObservation('model', ['capability'])).modelUsage.reservedSeconds).toBe(0);
		expect(await store.claimsForRecovery()).toEqual([]);
		expect(await store.session('missing')).toBeNull(); expect(await store.token('missing')).toBeNull();
		expect(await store.schedulableConnections()).toEqual([]); expect(await readdir(root)).toEqual([]);
	});

	it('projects expiry and accounting while writer custody is held, then persists them once on a real mutation', async () => {
		const root = await mkdtemp(join(tmpdir(), 'provider-read-observation-')); roots.push(root);
		vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
		const store = new ProviderLocalCapacityStore(root), statePath = join(root, 'runtime', 'capacity-state.json');
		const active = await store.claim({ connectionId: 'active-team', globalLimit: 2, connectionLimit: 2 });
		const polling = await store.claim({ connectionId: 'polling-team', globalLimit: 2, connectionLimit: 2, pollingTtlMs: 1_000 });
		if (!active || !polling) throw new Error('Original polling claims required');
		await store.attachLease(active.id, { assignmentId: 'assignment', leaseToken: 'private-lease', leaseExpiresAt: '2026-10-22T12:00:03.000Z',
			requestedSeconds: 60, dispatchEnvelope: { frozen: true }, accounting: { modelConfigurationId: 'model', capabilityId: 'capability',
				dailyActiveSecondsLimit: 120, capabilityDailyActiveSecondsLimit: 120 } });
		await store.claimDispatch(active.id); await store.beginActiveExecution(active.id);
		await store.saveSession('active-team', { id: 'session', sequence: 7 });
		const token: ProviderAccessTokenIssue = { id: 'token', teamId: 'team', providerId: 'provider', membershipId: 'membership', credentialId: 'credential',
			status: 'active', scopes: [], identityVersion: 1, accessToken: 'private-token', issuedAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-10-22T13:00:00.000Z' };
		await store.saveToken('active-team', token); await store.setConnectionStatus('active-team', true);
		const before = await readFile(statePath, 'utf8'), committedRevision = (JSON.parse(before) as { revision: number }).revision;
		vi.setSystemTime(new Date('2026-10-22T12:00:10.000Z'));
		const lockPath = `${statePath}.lock`; await mkdir(lockPath);
		try {
			const [snapshot, usage, recovery, session, savedToken, connections] = await Promise.all([
				store.snapshot(), store.activeTimeObservation('model', ['capability']), store.claimsForRecovery(),
				store.session('active-team'), store.token('active-team'), store.schedulableConnections(),
			]);
			expect(snapshot.revision).toBe(committedRevision);
			expect(snapshot.claims.find(claim => claim.id === active.id)?.leaseToken).toBe('<redacted>');
			expect(snapshot.claims.some(claim => claim.id === polling.id)).toBe(false);
			expect(snapshot.events.filter(event => event.outcome === 'poll-expired')).toHaveLength(1);
			expect(recovery.find(claim => claim.id === active.id)?.status).toBe('recovery');
			expect(usage.modelUsage).toEqual({ day: '2026-10-22', activeSeconds: 10, reservedSeconds: 50 });
			expect(session).toEqual({ connectionId: 'active-team', id: 'session', sequence: 7, updatedAt: '2026-10-22T12:00:00.000Z' });
			expect(savedToken).toEqual(token); expect(connections).toEqual(['active-team']);
			expect(await readFile(statePath, 'utf8')).toBe(before);
		} finally { await rm(lockPath, { recursive: true, force: true }); }

		await store.saveSession('active-team', { id: 'session', sequence: 8 });
		const committed = JSON.parse(await readFile(statePath, 'utf8')) as { revision: number; claims: Array<{ id: string; status: string; accountedThrough?: string }>;
			usage: Record<string, Record<string, number>>; events: Array<{ outcome: string }> };
		expect(committed.revision).toBe(committedRevision + 1);
		expect(committed.claims.find(claim => claim.id === active.id)?.status).toBe('recovery');
		expect(committed.claims.some(claim => claim.id === polling.id)).toBe(false);
		expect(committed.usage['2026-10-22']?.[JSON.stringify(['model'])]).toBe(10);
		expect(committed.events.filter(event => event.outcome === 'poll-expired')).toHaveLength(1);
		await store.snapshot(); await store.activeTimeObservation('model', ['capability']);
		const repeated = JSON.parse(await readFile(statePath, 'utf8')) as typeof committed;
		expect(repeated.usage).toEqual(committed.usage); expect(repeated.events).toEqual(committed.events);
	});

	it('reads complete committed states while concurrent mutations atomically rename the file', async () => {
		const root = await mkdtemp(join(tmpdir(), 'provider-concurrent-observation-')); roots.push(root);
		const store = new ProviderLocalCapacityStore(root);
		await store.saveSession('owner', { id: 'initial', sequence: 0 });
		const observations = Array.from({ length: 8 }, (_, index) => index % 2 ? store.session('owner') : store.snapshot());
		const mutations = Array.from({ length: 4 }, (_, sequence) => store.saveSession('owner', { id: `session-${sequence}`, sequence }));
		const results = await Promise.all([...observations, ...mutations]);
		expect(results).toHaveLength(12);
		for (const result of results.slice(0, 8)) {
			if (result && typeof result === 'object' && 'revision' in result) {
				expect(Number.isInteger(result.revision)).toBe(true);
				expect(Array.isArray(result.claims)).toBe(true);
			} else expect(result).toMatchObject({ connectionId: 'owner', id: expect.stringMatching(/^(initial|session-[0-3])$/u) });
		}
		const final = await store.snapshot();
		expect(final.revision).toBeGreaterThan(1);
		expect(await store.session('owner')).toMatchObject({ id: expect.stringMatching(/^session-[0-3]$/u), sequence: expect.any(Number) });
	});
});
