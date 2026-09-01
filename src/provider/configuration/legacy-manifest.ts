import {
	CORE_CAPABILITY_DEFINITIONS,
	CORE_CAPABILITY_ONTOLOGY_CREATED_AT,
	CORE_CAPABILITY_ONTOLOGY_GENERATION,
	capabilityContractDigest,
	capabilityOfferDigest,
	capabilityOfferSchema,
	type CapabilityReference,
	type CapacityProviderManifestV5,
} from '@treeseed/sdk/capacity-provider';

type RecordValue = Record<string, unknown>;
const digest = /^sha256:[a-f0-9]{64}$/u;
const definitions = new Map(CORE_CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
const reference = (id: string): CapabilityReference => {
	const definition = definitions.get(id);
	if (!definition) throw new Error(`Legacy provider migration references unknown capability ${id}.`);
	return { id: definition.id, version: definition.version, digest: definition.digest };
};
const family = (name: string) => CORE_CAPABILITY_DEFINITIONS.filter((definition) => definition.family === name).map(({ id }) => id);
const offerCapabilities = {
	conversation: [...family('coordination'), ...family('research'), 'treeseed.engineering.architecture', 'treeseed.engineering.repository-analysis', 'treeseed.engineering.review'],
	engineering: family('engineering').filter((id) => !['treeseed.engineering.security-analysis', 'treeseed.engineering.deployment', 'treeseed.engineering.release', 'treeseed.engineering.operations'].includes(id)),
	data: family('data'), publishing: family('publishing'),
};
const laneCapabilities: Record<string, string[]> = {
	communication: ['treeseed.coordination.conversation', 'treeseed.engineering.repository-analysis', 'treeseed.research.synthesis'],
	platform: ['treeseed.engineering.architecture', 'treeseed.engineering.code-change', 'treeseed.engineering.review'],
	workday: ['treeseed.coordination.planning', 'treeseed.engineering.code-change', 'treeseed.research.synthesis', 'treeseed.publishing.documentation'],
};

function record(value: unknown, name: string): RecordValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Legacy provider ${name} must be an object.`);
	return value as RecordValue;
}

function offer(id: string, capabilityIds: string[]) {
	const capabilities = capabilityIds.map(reference);
	const configurationSupport = Object.fromEntries(['instructions.system', 'instructions.task', 'instructions.templates', 'context.queries', 'tools.policy', 'intelligence.reasoning-effort'].map((key) => [key, { required: true, preferred: true }]));
	const conformance = capabilities.map((capability) => ({
		schemaVersion: 'treeseed.capability-conformance/v1' as const, providerId: 'runtime-provider', capability,
		tier: 'signed-attestation' as const, status: 'passed' as const,
		evidenceDigest: capabilityContractDigest({ capability, tier: 'signed-attestation', suite: null }), suite: null,
		issuedAt: CORE_CAPABILITY_ONTOLOGY_CREATED_AT, expiresAt: null,
		signature: { keyId: 'runtime-provider', algorithm: 'Ed25519' as const, value: 'materialize-at-runtime' },
	}));
	const material = {
		schemaVersion: 'treeseed.capability-offer/v2' as const, offerId: `codex-${id}`, capabilities, features: [], configurationSupport,
		permissionClasses: ['content-policy', 'repository-policy', 'network-policy', 'shell-policy', 'tool-policy'], contextModes: ['inline', 'manifest'],
		contextCapacity: { mode: 'bounded' as const, measurement: 'tokens' as const, defaultInitial: 32_000, maximum: 128_000,
			reservedOutput: 8_000, transportPayloadBytes: 4_194_304,
			measurementProvenance: { provider: 'openai', implementation: 'provider-reported-tokenizer', version: null } },
		inputContracts: [], outputContracts: [], interactionModes: ['asynchronous', 'interactive'], conformance, limits: {},
		commercial: { currency: null, estimatedCost: null }, region: null, trust: ['provider-signed'],
	};
	return capabilityOfferSchema.parse({ ...material, offerDigest: capabilityOfferDigest(material) });
}

export function migrateManagedProviderManifestV4(value: unknown, env: NodeJS.ProcessEnv): CapacityProviderManifestV5 {
	const legacy = record(value, 'manifest');
	if (legacy.schemaVersion !== 4) throw new Error('Only schemaVersion 4 provider manifests can use the managed compatibility migration.');
	const baseImageDigest = env.TREESEED_SANDBOX_BASE_DIGEST;
	const provenanceDigest = env.TREESEED_SANDBOX_PROVENANCE_DIGEST;
	if (!digest.test(baseImageDigest ?? '') || !digest.test(provenanceDigest ?? '')) throw new Error('Managed v4 provider migration requires exact release-bound sandbox base and provenance digests.');
	const sandbox = record(legacy.sandbox, 'sandbox');
	if (!Array.isArray(sandbox.profiles) || sandbox.profiles.length === 0) throw new Error('Legacy provider sandbox profiles are required.');
	const profileIds = new Set(sandbox.profiles.map((profile) => String(record(profile, 'sandbox profile').id ?? '')));
	if (!profileIds.has('read') || !profileIds.has('unit')) throw new Error('Legacy provider migration requires read and unit sandbox profiles.');
	if (!Array.isArray(legacy.lanes) || !Array.isArray(legacy.adapters)) throw new Error('Legacy provider lanes and adapters are required.');
	const lineage = { baseImageDigest: baseImageDigest!, provenanceDigest: provenanceDigest!, architectures: ['amd64', 'arm64'],
		signature: { keyId: 'runtime-provider', algorithm: 'Ed25519' as const, value: 'materialize-at-runtime' } };
	const adapters = legacy.adapters.map((entry) => {
		const adapter = record(entry, 'adapter');
		const { sandboxProfileIds: _profiles, defaultSandboxProfiles: _defaults, capabilities: _capabilities, offers: _offers, ...portable } = adapter;
		return { ...portable, offers: [
			{ offer: offer('conversation', offerCapabilities.conversation), sandboxProfileId: 'read' },
			{ offer: offer('engineering', offerCapabilities.engineering), sandboxProfileId: 'unit' },
			{ offer: offer('data', offerCapabilities.data), sandboxProfileId: 'unit' },
			{ offer: offer('publishing', offerCapabilities.publishing), sandboxProfileId: 'unit' },
		] };
	});
	const configuration = record(legacy.configuration, 'configuration');
	return {
		...legacy, schemaVersion: 5,
		configuration: { ...configuration, generation: `${String(configuration.generation ?? 'managed')}-compat-v5` },
		ontology: { generation: CORE_CAPABILITY_ONTOLOGY_GENERATION, digest: capabilityContractDigest({ generation: CORE_CAPABILITY_ONTOLOGY_GENERATION, definitions: CORE_CAPABILITY_DEFINITIONS }) },
		sandbox: { ...sandbox, profiles: sandbox.profiles.map((profile) => ({ ...record(profile, 'sandbox profile'), lineage })) },
		lanes: legacy.lanes.map((entry) => { const lane = record(entry, 'lane'); return { ...lane, capabilities: laneCapabilities[String(lane.purpose)] ?? [] }; }),
		adapters, metadata: { ...record(legacy.metadata ?? {}, 'metadata'), compatibilityMigration: 'agent-managed-v4-to-v5' },
	} as unknown as CapacityProviderManifestV5;
}
