import { describe, expect, it, vi } from 'vitest';
import { recoverProviderLocalLeases } from '../../src/provider/coordination/lease-recovery.ts';

describe('provider local lease recovery', () => {
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
