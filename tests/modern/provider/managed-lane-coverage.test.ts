import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { calculateAssignmentAllocation, capabilityAccountingLimitsSchema } from '@treeseed/sdk/agent-capacity';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';
import { loadProviderManifest } from '../../../src/provider/configuration/manifest.ts';

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

it('loads identical provider policy in development and released execution', async () => {
	const digest = `sha256:${'a'.repeat(64)}`;
	const current = createManagedProviderManifestV5({ release: 'old', guestImage: 'sandbox', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const release = current.adapters[0]!.offers.find(({ offer }) => offer.capabilities.some(({ id }) => id === 'treeseed.engineering.release'))!;
	current.adapters[0]!.offers = current.adapters[0]!.offers.map((entry) => entry === release
		? { ...entry, offer: { ...entry.offer, capabilities: entry.offer.capabilities.filter(({ id }) => id !== 'treeseed.engineering.release') } }
		: entry);
	current.connections = [{ id: 'preserved' } as typeof current.connections[number]];
	current.adapters[0]!.model = { model: 'gpt-6-luna', reasoningEffort: 'low' };
	current.adapters[1]!.model = { model: 'gpt-5.6-sol', reasoningEffort: 'medium' };
	current.connections = [];
	current.sandbox.profiles[0]!.resources.memoryBytes = 1_073_741_824;
	current.sandbox.profiles[0]!.resources.processLimit = 128;
	current.capacity.maxConcurrentWorkers = 5;
	current.adapters[0]!.nativeLimits.dailyActiveSecondsLimit = 43200;
	current.adapters[1]!.nativeLimits.dailyActiveSecondsLimit = 7200;
	const directory = await mkdtemp(join(tmpdir(), 'provider-policy-parity-'));
	try {
		const path = join(directory, 'manifest.yaml');
		await writeFile(path, stringify(current));
		const released = await loadProviderManifest(path, undefined, {});
		const development = await loadProviderManifest(path, undefined, { TREESEED_DEVELOPMENT_MODE: '1' });
		expect(development.manifest).toEqual(released.manifest);
		expect(development.manifest).toEqual(current);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

it('uses only explicit host duration bounds in both development and released admission', async () => {
	const digest = `sha256:${'a'.repeat(64)}`;
	const current = createManagedProviderManifestV5({ release: 'old', guestImage: 'sandbox', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const capability = 'treeseed.engineering.review';
	const directory = await mkdtemp(join(tmpdir(), 'provider-duration-parity-'));
	try {
		const path = join(directory, 'manifest.yaml');
		for (const explicitMinimum of [undefined, 360]) {
			const limits = capabilityAccountingLimitsSchema.parse(current.adapters[0]!.nativeLimits);
			limits.capabilityLimits[capability] = {
				dailyActiveSecondsLimit: 43200,
				...(explicitMinimum === undefined ? {} : { minimumAssignmentSeconds: explicitMinimum, maximumAssignmentSeconds: 600 }),
			};
			current.adapters[0]!.nativeLimits = limits;
			await writeFile(path, stringify(current));
			for (const env of [{}, { TREESEED_DEVELOPMENT_MODE: '1' }]) {
				const loaded = await loadProviderManifest(path, undefined, env);
				const bounds = capabilityAccountingLimitsSchema.parse(loaded.manifest.adapters[0]!.nativeLimits).capabilityLimits[capability]!;
				expect(bounds).toEqual(limits.capabilityLimits[capability]);
				const allocation = calculateAssignmentAllocation({
					estimate: { minimumSeconds: 35, expectedSeconds: 55, maximumSeconds: 90 }, measurements: [],
					providerMinimumSeconds: bounds.minimumAssignmentSeconds,
					providerMaximumSeconds: bounds.maximumAssignmentSeconds,
					constraints: [{ id: 'execution-window', remainingSeconds: 346 - 60 }],
				});
				expect(allocation).toMatchObject(explicitMinimum === undefined
					? { admitted: true, allocatedSeconds: 90 }
					: { admitted: false, allocatedSeconds: 0 });
			}
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});
