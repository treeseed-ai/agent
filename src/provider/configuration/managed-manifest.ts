import {
	validateCapacityProviderManifestV5,
	capabilityOfferDigest,
	capabilityOfferSchema,
	capabilityContractDigest,
	CORE_CAPABILITY_DEFINITIONS,
	CORE_CAPABILITY_ONTOLOGY_CREATED_AT,
	CORE_CAPABILITY_ONTOLOGY_GENERATION,
	type CapacityProviderManifestV5,
} from '@treeseed/sdk/capacity-provider';

const digest = /^sha256:[a-f0-9]{64}$/u;
const profileIds = ['read', 'unit', 'integration', 'platform', 'connected'] as const;
const codexGuestMemoryBytes = 8_589_934_592;
const family = (name: string) => CORE_CAPABILITY_DEFINITIONS.filter(definition => definition.family === name).map(({ id }) => id);
const offerCapabilities = {
	conversation: [...family('coordination'), ...family('research'), 'treeseed.engineering.architecture', 'treeseed.engineering.repository-analysis', 'treeseed.engineering.review'],
	engineering: family('engineering').filter(id => !['treeseed.engineering.security-analysis', 'treeseed.engineering.deployment', 'treeseed.engineering.operations'].includes(id)),
	data: family('data'), publishing: family('publishing'),
};
const laneCapabilities = {
	communication: ['treeseed.coordination.conversation', 'treeseed.engineering.repository-analysis', 'treeseed.research.synthesis'],
	platform: ['treeseed.engineering.architecture', 'treeseed.engineering.code-change', 'treeseed.engineering.review', 'treeseed.engineering.release'],
	workday: [...new Set(Object.values(offerCapabilities).flat())].filter(id => id !== 'treeseed.coordination.conversation').sort(),
};
// Byte capacity is the measured transport envelope, not a model tokenizer claim.
export const MANAGED_CONTEXT_CAPACITY = {
	mode: 'bounded' as const, measurement: 'bytes' as const, defaultInitial: 32_000, maximum: 128_000,
	reservedOutput: 8_000, transportPayloadBytes: 4_194_304,
	measurementProvenance: { provider: 'treeseed', implementation: 'utf8-byte-length', version: '1' },
};
function managedOffer(id: string, ids: string[]) {
	const capabilities = ids.map(id => {
		const definition = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === id);
		if (!definition) throw new Error(`Managed offer references unknown capability ${id}.`);
		return { id, version: definition.version, digest: definition.digest };
	});
	const conformance = capabilities.map(capability => {
		const tier = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === capability.id)!.qualificationTier;
		const suite = tier === 'signed-attestation' ? null : { id: 'agent-managed-capability', version: '1.0.0' };
		return { schemaVersion: 'treeseed.capability-conformance/v1' as const, providerId: 'runtime-provider', capability,
			tier, suite, evidenceDigest: capabilityContractDigest({ capability, tier, suite }), status: 'passed' as const,
			issuedAt: CORE_CAPABILITY_ONTOLOGY_CREATED_AT, expiresAt: null,
			signature: { keyId: 'runtime-provider', algorithm: 'Ed25519' as const, value: 'materialize-at-runtime' } };
	});
	const material = { schemaVersion: 'treeseed.capability-offer/v2' as const, offerId: `codex-${id}`, capabilities,
		features: [], configurationSupport: Object.fromEntries(['instructions.system', 'instructions.task', 'instructions.templates',
			'context.queries', 'tools.policy', 'intelligence.reasoning-effort'].map(key => [key, { required: true, preferred: true }])),
		permissionClasses: ['content-policy', 'repository-policy', 'network-policy', 'shell-policy', 'tool-policy'],
		contextModes: ['inline', 'manifest'], contextCapacity: MANAGED_CONTEXT_CAPACITY, inputContracts: [], outputContracts: [],
		interactionModes: ['asynchronous', 'interactive'], conformance, limits: {}, commercial: { currency: null, estimatedCost: null },
		region: null, trust: ['provider-signed'] };
	return capabilityOfferSchema.parse({ ...material, offerDigest: capabilityOfferDigest(material) });
}

export interface ManagedProviderManifestRelease {
	release: string;
	guestImage: string;
	guestImageDigest: string;
	baseImageDigest: string;
	provenanceDigest: string;
}

/**
 * Builds the credential-free provider policy shipped by an exact Agent release.
 * The one-worker value is a safe scheduling ceiling, not observed host capacity;
 * enrollment and runtime inventory may replace it through governed configuration.
 */
export function createManagedProviderManifestV5(input: ManagedProviderManifestRelease): CapacityProviderManifestV5 {
	if (!input.release.trim() || !input.guestImage.trim()) throw new Error('Managed provider defaults require an exact release and guest image repository.');
	for (const value of [input.guestImageDigest, input.baseImageDigest, input.provenanceDigest]) if (!digest.test(value)) throw new Error('Managed provider defaults require exact image and provenance digests.');
	const sandboxProfile = (id: typeof profileIds[number]): CapacityProviderManifestV5['sandbox']['profiles'][number] => ({
		id, guestImage: input.guestImage, guestImageDigest: input.guestImageDigest, defaultDenyNetwork: true,
		resources: { cpuCores: 1, memoryBytes: codexGuestMemoryBytes, diskBytes: 4_294_967_296, processLimit: 512, outputBytes: 67_108_864 },
		lineage: { baseImageDigest: input.baseImageDigest, provenanceDigest: input.provenanceDigest,
			architectures: ['amd64', 'arm64'], signature: { keyId: 'runtime-provider', algorithm: 'Ed25519' as const, value: 'materialize-at-runtime' } },
	});
	const lane = (id: 'communication' | 'platform' | 'workday', priority: number, reservedConcurrentWorkers: number): CapacityProviderManifestV5['lanes'][number] => ({
		id, purpose: id, priority, reservedConcurrentWorkers, maxConcurrentWorkers: 1,
		borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 10, timeoutSeconds: 120, capabilities: laneCapabilities[id],
	});
	const manifest: CapacityProviderManifestV5 = {
		schemaVersion: 5,
		ownership: { type: 'external' },
		configuration: { generation: `agent-release-${input.release}` },
		identity: { privateKeyRef: 'data://identity-v3.json', displayName: 'TreeSeed capacity provider' },
		ontology: { generation: CORE_CAPABILITY_ONTOLOGY_GENERATION,
			digest: capabilityContractDigest({ generation: CORE_CAPABILITY_ONTOLOGY_GENERATION, definitions: CORE_CAPABILITY_DEFINITIONS }) },
		capacity: { maxConcurrentWorkers: 1 },
		credentialProfiles: [],
		sandbox: { required: true, brokerSocket: '/run/treeseed/sandbox/broker.sock', runtime: 'kata-runtime-rs-qemu', profiles: profileIds.map(sandboxProfile) },
		lanes: [lane('communication', 100, 1), lane('platform', 70, 0), lane('workday', 50, 0)],
		adapters: [{
			id: 'codex-managed', adapter: 'codex', isolation: 'microvm', module: 'module:codex-chat', profile: 'api', protocol: 'responses',
			model: { model: 'gpt-5.6-terra' }, credentialProfiles: [], laneIds: ['communication', 'platform', 'workday'],
			maxConcurrentWorkers: 1, nativeLimits: {}, offers: Object.entries(offerCapabilities).map(([id, ids]) => ({
				offer: managedOffer(id, ids), sandboxProfileId: id === 'conversation' ? 'read' : 'unit' })),
		}],
		connections: [],
		metadata: { custody: 'agent-release-default' },
	};
	const baseAdapter = manifest.adapters[0]!;
	manifest.adapters = [
		{ id: 'codex-implementation', model: 'gpt-5.6-terra', accepts: (id: string) => !id.startsWith('treeseed.research.') },
		{ id: 'codex-research', model: 'gpt-5.6-sol', accepts: (id: string) => id.startsWith('treeseed.research.')
			|| id.startsWith('treeseed.coordination.') || id === 'treeseed.engineering.repository-analysis' },
	].map(policy => {
		const offers = baseAdapter.offers.flatMap(binding => {
			const capabilities = binding.offer.capabilities.filter(({ id }) => policy.accepts(id));
			if (!capabilities.length) return [];
			const material = { ...binding.offer, offerId: `${policy.id}-${binding.offer.offerId}`,
				capabilities, conformance: binding.offer.conformance.filter(({ capability }) => policy.accepts(capability.id)) };
			return [{ ...binding, offer: { ...material, offerDigest: capabilityOfferDigest(material) } }];
		});
		return { ...baseAdapter, id: policy.id, model: { model: policy.model, reasoningEffort: 'medium' as const }, offers,
			nativeLimits: { modelConfigurationId: `codex:${policy.model}:medium`, dailyActiveSecondsLimit: 0,
				capabilityLimits: Object.fromEntries(offers.flatMap(binding => binding.offer.capabilities.map(({ id }) => [id, { dailyActiveSecondsLimit: 0 }]))) } };
	});
	manifest.metadata = { custody: 'agent-release-default' };
	const validation = validateCapacityProviderManifestV5(manifest);
	if (!validation.ok) throw new Error(`Generated managed provider manifest is invalid: ${validation.diagnostics.map(({ code, path }) => `${code}:${path}`).join(', ')}`);
	return manifest;
}
