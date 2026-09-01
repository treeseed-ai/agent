import {
	validateCapacityProviderManifestV5,
	type CapacityProviderManifestV5,
} from '@treeseed/sdk/capacity-provider';
import { migrateManagedProviderManifestV4 } from './legacy-manifest.ts';

const digest = /^sha256:[a-f0-9]{64}$/u;
const profileIds = ['read', 'unit', 'integration', 'platform', 'connected'] as const;

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
	const sandboxProfile = (id: typeof profileIds[number]) => ({
		id, guestImage: input.guestImage, guestImageDigest: input.guestImageDigest, defaultDenyNetwork: true,
		resources: { cpuCores: 1, memoryBytes: 1_073_741_824, diskBytes: 4_294_967_296, processLimit: 128, outputBytes: 67_108_864 },
	});
	const lane = (id: 'communication' | 'platform' | 'workday', priority: number, reservedConcurrentWorkers: number) => ({
		id, purpose: id, priority, reservedConcurrentWorkers, maxConcurrentWorkers: 1,
		borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 10, timeoutSeconds: 120,
	});
	const legacy = {
		schemaVersion: 4,
		ownership: { type: 'external' },
		configuration: { generation: `agent-release-${input.release}` },
		identity: { privateKeyRef: 'data://identity-v3.json', displayName: 'TreeSeed capacity provider' },
		capacity: { maxConcurrentWorkers: 1 },
		credentialProfiles: [],
		sandbox: { required: true, brokerSocket: '/run/treeseed/sandbox/broker.sock', runtime: 'kata-runtime-rs-qemu', profiles: profileIds.map(sandboxProfile) },
		lanes: [lane('communication', 100, 1), lane('platform', 70, 0), lane('workday', 50, 0)],
		adapters: [{
			id: 'codex-managed', adapter: 'codex', isolation: 'microvm', module: 'module:codex-chat', profile: 'api', protocol: 'responses',
			model: { model: 'gpt-5.4' }, credentialProfiles: [], laneIds: ['communication', 'platform', 'workday'],
			maxConcurrentWorkers: 1, nativeLimits: {}, sandboxProfileIds: [...profileIds], capabilities: [],
		}],
		connections: [],
		metadata: { custody: 'agent-release-default' },
	};
	const manifest = migrateManagedProviderManifestV4(legacy, {
		TREESEED_SANDBOX_BASE_DIGEST: input.baseImageDigest,
		TREESEED_SANDBOX_PROVENANCE_DIGEST: input.provenanceDigest,
	});
	manifest.configuration = { generation: `agent-release-${input.release}` };
	manifest.metadata = { custody: 'agent-release-default' };
	const validation = validateCapacityProviderManifestV5(manifest);
	if (!validation.ok) throw new Error(`Generated managed provider manifest is invalid: ${validation.diagnostics.map(({ code, path }) => `${code}:${path}`).join(', ')}`);
	return manifest;
}
