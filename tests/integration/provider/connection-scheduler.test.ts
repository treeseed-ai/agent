import { describe, expect, it } from 'vitest';
import { ProviderGlobalSlotScheduler, providerManifestConcurrency } from '../../../src/provider/connection-scheduler.ts';

function connection(id: string, weight: number, maxConcurrentRunners = 4) {
	return { connection: { id, marketUrl: `https://${id}.example.test`, teamId: id, providerId: 'provider-shared', membershipId: `membership-${id}`, membershipCredentialRef: `env://${id}`, membershipCredentialId: `credential-${id}`, offer: { weight, maxConcurrentRunners, capabilities: ['engineering'] } } };
}

describe('provider-global connection scheduler', () => {
	it('never allocates more than the provider-global or connection concurrency limits', () => {
		const scheduler = new ProviderGlobalSlotScheduler(2);
		scheduler.updateConnections([connection('team-a', 1, 1), connection('team-b', 1, 2)]);
		const first = scheduler.acquire();
		const second = scheduler.acquire();
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(scheduler.acquire()).toBeNull();
		expect(scheduler.snapshot().activeTotal).toBe(2);
		expect(new Set([first?.connection.connection.id, second?.connection.connection.id])).toEqual(new Set(['team-a', 'team-b']));
		first?.release();
		expect(scheduler.acquire()).not.toBeNull();
	});

	it('uses weighted deficit scheduling across repeated slots', () => {
		const scheduler = new ProviderGlobalSlotScheduler(1);
		scheduler.updateConnections([connection('team-a', 3), connection('team-b', 1)]);
		const selected: string[] = [];
		for (let index = 0; index < 8; index += 1) {
			const lease = scheduler.acquire();
			if (!lease) throw new Error('Expected an available provider slot.');
			selected.push(lease.connection.connection.id);
			lease.release();
		}
		expect(selected.filter((id) => id === 'team-a')).toHaveLength(6);
		expect(selected.filter((id) => id === 'team-b')).toHaveLength(2);
	});

	it('sums independent execution-provider native runner limits', () => {
		expect(providerManifestConcurrency({ executionProviders: [{ nativeLimits: { maxConcurrentRunners: 2 } }, { nativeLimits: { maxConcurrentRunners: 3 } }], hostLimit: 8 })).toBe(5);
		expect(providerManifestConcurrency({ executionProviders: [{ nativeLimits: { maxConcurrentRunners: 2 } }, { nativeLimits: { maxConcurrentRunners: 3 } }], hostLimit: 3 })).toBe(3);
	});
});
