import { expect, it } from 'vitest';
import { applyManagedDevelopmentPolicy, createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';

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
	expect(manifest.adapters[0]!.offers.flatMap(({ offer }) => offer.conformance).find(({ capability }) => capability.id === 'treeseed.engineering.release')).toMatchObject({
		tier: 'automated-suite', suite: { id: 'agent-managed-capability', version: '1.0.0' }, status: 'passed',
	});
	expect(workday.capabilities).not.toContain('treeseed.coordination.conversation');
	expect(communication.priority).toBeGreaterThan(workday.priority);
	expect(communication.reservedConcurrentWorkers).toBe(1);
	expect(manifest.adapters[0]!.model).toEqual({ model: 'gpt-5.6-terra', reasoningEffort: 'medium' });
	expect(manifest.adapters.map(({ id }) => id)).toEqual(['codex-implementation', 'codex-research']);
	expect(manifest.adapters[1]!.model).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
	expect(manifest.adapters[1]!.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))).not.toContain('treeseed.engineering.code-change');
	expect(manifest.adapters[0]!.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))).not.toContain('treeseed.research.web');
});

it('refreshes only managed provider policy for development source', () => {
	const digest = `sha256:${'a'.repeat(64)}`;
	const current = createManagedProviderManifestV5({ release: 'old', guestImage: 'sandbox', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const release = current.adapters[0]!.offers.find(({ offer }) => offer.capabilities.some(({ id }) => id === 'treeseed.engineering.release'))!;
	current.adapters[0]!.offers = current.adapters[0]!.offers.map((entry) => entry === release
		? { ...entry, offer: { ...entry.offer, capabilities: entry.offer.capabilities.filter(({ id }) => id !== 'treeseed.engineering.release') } }
		: entry);
	current.connections = [{ id: 'preserved' } as typeof current.connections[number]];
	const refreshed = applyManagedDevelopmentPolicy(current, 'source');
	expect(refreshed.adapters[0]!.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))).toContain('treeseed.engineering.release');
	expect(refreshed.connections).toEqual(current.connections);
	expect(refreshed.sandbox).toEqual(current.sandbox);
	expect(refreshed.configuration.generation).toContain('development-source');
});
