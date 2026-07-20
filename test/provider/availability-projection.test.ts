import { describe, expect, it } from 'vitest';
import { compileConnectionAvailability } from '../../src/provider/availability-projection.ts';

describe('team-scoped provider availability', () => {
	it('narrows global capabilities, lanes, and concurrency to one connection offer', () => {
		const projection = compileConnectionAvailability({
			connection: { id: 'team-a', marketUrl: 'https://team-a.test', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', membershipCredentialRef: 'data://team-a', membershipCredentialId: 'credential-a', offer: { capabilities: ['research'], maxConcurrentRunners: 2 } },
			hostMaxConcurrentRunners: 1,
			executionProviders: [{ id: 'codex', adapter: 'codex', nativeLimits: { maxConcurrentRunners: 4 }, capabilities: ['engineering', 'research'], lanes: [{ id: 'shared', maxConcurrentRunners: 4, capabilities: ['engineering', 'research'] }] }],
		});
		expect(projection).toMatchObject({ capabilities: ['research'], maxConcurrentRunners: 1, executionProviders: [{ nativeLimits: { maxConcurrentRunners: 1 }, capabilities: ['research'], lanes: [{ maxConcurrentRunners: 1, capabilities: ['research'] }] }] });
	});
});
