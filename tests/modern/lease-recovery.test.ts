import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverProviderLocalLeases } from '../../src/provider/coordination/lease-recovery.ts';
import { createProviderControlPlaneClient } from '../../src/provider/coordination/client.ts';
import { ProviderLocalCapacityStore } from '../../src/provider/capacity/capacity-core/local-capacity-store.ts';

vi.mock('../../src/provider/coordination/client.ts', () => ({ createProviderControlPlaneClient: vi.fn() }));

describe('provider local lease recovery', () => {
	it('includes a prepared lease that was not dispatched before provider restart', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-ready-lease-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'connection', globalLimit: 1, connectionLimit: 1 });
			expect(claim).not.toBeNull();
			await store.attachLease(claim!.id, {
				assignmentId: 'assignment', leaseToken: 'lease', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
				dispatchEnvelope: {},
			});
			await expect(store.claimsForRecovery(false)).resolves.toEqual([
				expect.objectContaining({ id: claim!.id, status: 'ready', assignmentId: 'assignment' }),
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([undefined, 'Original execution failure'])('preserves the runtime cause rather than claiming every failure is a restart: %s', async failureMessage => {
		const api = { assignment: vi.fn().mockResolvedValue({ status: 'leased' }), returnAssignment: vi.fn().mockResolvedValue({}) };
		vi.mocked(createProviderControlPlaneClient).mockReturnValue(api as never);
		const store = { claimsForRecovery: vi.fn().mockResolvedValue([{ id: 'claim', connectionId: 'connection',
			assignmentId: 'assignment', leaseToken: 'lease', runnerId: 'runner', failureMessage }]), finalize: vi.fn(), recordFailure: vi.fn() };
		await recoverProviderLocalLeases({ config: {} as never, store: store as never,
			connections: [{ connection: { id: 'connection' }, accessToken: { accessToken: 'test-only' }, controlPlaneUrl: 'https://api.example.test' }] as never });
		expect(api.returnAssignment).toHaveBeenCalledWith('assignment', expect.objectContaining({
			code: failureMessage ? 'provider_runtime_recovery' : 'provider_restart_recovery',
			reason: failureMessage ? `Provider runtime failed before durable completion: ${failureMessage}` : 'Provider restarted before durable completion.',
		}));
		expect(store.finalize).toHaveBeenCalledOnce();
	});
	it('releases a recovery claim that never acquired lease authority', async () => {
		const store = {
			claimsForRecovery: vi.fn(async () => [{ id: 'claim-unleased', connectionId: 'retired-team', status: 'recovery' }]),
			finalize: vi.fn(async () => true),
			recordFailure: vi.fn(),
		};
		const result = await recoverProviderLocalLeases({ config: {} as never, connections: [], store: store as never });
		expect(store.finalize).toHaveBeenCalledWith('claim-unleased', 'unleased-claim-released');
		expect(store.recordFailure).not.toHaveBeenCalled();
		expect(result).toEqual([{ claimId: 'claim-unleased', status: 'released', reason: 'no_lease_acquired' }]);
	});

	it('retains a partially recorded lease when authority cannot be proven', async () => {
		const store = {
			claimsForRecovery: vi.fn(async () => [{ id: 'claim-partial', connectionId: 'retired-team', status: 'recovery', assignmentId: 'assignment-1' }]),
			finalize: vi.fn(),
			recordFailure: vi.fn(async () => true),
		};
		const result = await recoverProviderLocalLeases({ config: {} as never, connections: [], store: store as never });
		expect(store.finalize).not.toHaveBeenCalled();
		expect(store.recordFailure).toHaveBeenCalledOnce();
		expect(result).toEqual([{ claimId: 'claim-partial', status: 'retained', reason: 'lease_authority_unavailable' }]);
	});
});
