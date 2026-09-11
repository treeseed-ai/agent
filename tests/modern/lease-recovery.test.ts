import { describe, expect, it, vi } from 'vitest';
import { recoverProviderLocalLeases } from '../../src/provider/coordination/lease-recovery.ts';
import { createProviderControlPlaneClient } from '../../src/provider/coordination/client.ts';

vi.mock('../../src/provider/coordination/client.ts', () => ({ createProviderControlPlaneClient: vi.fn() }));

describe('provider local lease recovery', () => {
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
