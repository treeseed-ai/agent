import { expect, it } from 'vitest';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';

it('routes every advertised non-conversation capability through a managed workday lane', () => {
	const digest = `sha256:${'a'.repeat(64)}`;
	const manifest = createManagedProviderManifestV5({ release: 'test', guestImage: 'sandbox', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const workday = manifest.lanes.find(lane => lane.purpose === 'workday')!;
	const communication = manifest.lanes.find(lane => lane.purpose === 'communication')!;
	for (const adapter of manifest.adapters) for (const offer of adapter.offers) for (const capability of offer.offer.capabilities) {
		if (capability.id !== 'treeseed.coordination.conversation') expect(workday.capabilities).toContain(capability.id);
	}
	expect(workday.capabilities).toContain('treeseed.engineering.review');
	expect(workday.capabilities).toContain('treeseed.engineering.release');
	expect(manifest.lanes.find(lane => lane.purpose === 'platform')!.capabilities).toContain('treeseed.engineering.release');
	expect(manifest.adapters[0]!.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))).toContain('treeseed.engineering.release');
	expect(workday.capabilities).not.toContain('treeseed.coordination.conversation');
	expect(communication.priority).toBeGreaterThan(workday.priority);
	expect(communication.reservedConcurrentWorkers).toBe(1);
	expect(manifest.adapters[0]!.model).toEqual({ model: 'gpt-5.6-terra' });
});
