import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { providerOperationPath } from '../../src/provider/coordination/client.ts';
import { providerRegistrationIdempotencyKey } from '../../src/provider/coordination/coordinator.ts';
import { resolveProviderConfig } from '../../src/provider/configuration/config.ts';
import { ensureCapacityProviderIdentity } from '../../src/provider/accounts/identity.ts';
import { listProviderConnectionStates, writeProviderConnectionState } from '../../src/provider/coordination/connection-state.ts';
import { loadProviderManifest, writeProviderConnections } from '../../src/provider/configuration/manifest.ts';
import { buildProviderPlan, providerAvailabilityCapabilities } from '../../src/provider/lifecycle/lifecycle.ts';
import { stringify as stringifyYaml } from 'yaml';

const digest = (value: string) => `sha256:${value.repeat(64)}`;
function providerManifestFixture() {
	const lane = (id: 'communication' | 'platform' | 'workday', priority: number, reservedConcurrentWorkers: number) => ({
		id, purpose: id, priority, reservedConcurrentWorkers, maxConcurrentWorkers: 4, borrowWhenIdle: true, lendWhenIdle: true,
		reclaimPolicy: 'admission', queueLimit: 10, timeoutSeconds: 120, capabilities: ['treeseed.coordination.conversation'],
	});
	const capability = { id: 'treeseed.coordination.conversation', version: '1.0.0', digest: digest('1') };
	const offer = { schemaVersion: 'treeseed.capability-offer/v1', offerId: 'conversation', capabilities: [capability], features: [], configurationSupport: {},
		permissionClasses: [], contextModes: ['manifest'], inputContracts: [], outputContracts: [], interactionModes: ['interactive'],
		conformance: [{ schemaVersion: 'treeseed.capability-conformance/v1', providerId: 'runtime-provider', capability, tier: 'signed-attestation', status: 'passed',
			evidenceDigest: digest('2'), suite: null, issuedAt: '2026-08-30T00:00:00.000Z', expiresAt: null, signature: { keyId: 'provider', algorithm: 'Ed25519', value: 'fixture' } }],
		limits: {}, commercial: { currency: null, estimatedCost: null }, region: null, trust: ['provider-signed'], offerDigest: digest('3') };
	return {
		schemaVersion: 5, ownership: { type: 'team', teamId: 'team:fixture' }, configuration: { generation: 'fixture-v5' },
		identity: { privateKeyRef: 'data://identity-v3.json', displayName: 'Fixture provider' }, ontology: { generation: 1, digest: digest('4') },
		capacity: { maxConcurrentWorkers: 4 }, credentialProfiles: [],
		sandbox: { required: true, brokerSocket: '/run/treeseed/sandbox/broker.sock', runtime: 'kata-runtime-rs-qemu', profiles: [{
			id: 'read', guestImage: 'treeseed/sandbox-codex', guestImageDigest: digest('5'), defaultDenyNetwork: true,
			resources: { cpuCores: 2, memoryBytes: 4096, diskBytes: 4096, processLimit: 64, outputBytes: 4096 },
			lineage: { baseImageDigest: digest('6'), provenanceDigest: digest('7'), architectures: ['amd64'], signature: { keyId: 'provider', algorithm: 'Ed25519', value: 'fixture' } },
		}] },
		lanes: [lane('communication', 100, 1), lane('platform', 70, 0), lane('workday', 50, 0)],
		adapters: [{ id: 'codex-local', adapter: 'codex', isolation: 'microvm', module: 'module:codex-chat', profile: 'api', protocol: 'responses',
			model: { model: 'gpt-5.4' }, credentialProfiles: [], laneIds: ['communication', 'platform', 'workday'], maxConcurrentWorkers: 4, nativeLimits: {}, offers: [{ offer, sandboxProfileId: 'read' }] }],
		connections: [], metadata: { custody: 'test-only' },
	};
}

function sourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(root, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('Agent package ownership boundary', () => {
	it('derives provider proof paths from the SDK operation catalog', () => {
		expect(providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration, { requestId: 'a/b' }))
			.toContain('a%2Fb');
		expect(() => providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration))
			.toThrow(/requires path parameter requestId/u);
	});

	it('creates one fresh private identity in local enrollment custody and reuses it on retry', async () => {
		const dataDirectory = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-identity-'));
		try {
			const input = { ref: 'data://identity-v3.json', baseDirectory: dataDirectory, dataDirectory };
			const first = await ensureCapacityProviderIdentity(input);
			const second = await ensureCapacityProviderIdentity(input);
			expect(second.publicJwk).toEqual(first.publicJwk);
			expect(statSync(resolve(dataDirectory, 'identity-v3.json')).mode & 0o777).toBe(0o600);
			const stored = readFileSync(resolve(dataDirectory, 'identity-v3.json'), 'utf8');
			expect(stored).toContain('treeseed.encrypted-envelope/v1');
			expect(stored).not.toContain(first.publicJwk.x);
		} finally {
			rmSync(dataDirectory, { recursive: true, force: true });
		}
	});

	it('binds registration idempotency to the reusable code generation', () => {
		expect(providerRegistrationIdempotencyKey('primary', 'code-one'))
			.toBe(providerRegistrationIdempotencyKey('primary', 'code-one'));
		expect(providerRegistrationIdempotencyKey('primary', 'code-one'))
			.not.toBe(providerRegistrationIdempotencyKey('primary', 'code-two'));
	});

	it('stores mutable connections in local custody without rewriting the canonical manifest', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-connections-'));
		const dataDirectory = resolve(root, 'data');
		const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
		const manifest = providerManifestFixture();
		writeFileSync(manifestPath, stringifyYaml(manifest));
		const canonical = readFileSync(manifestPath, 'utf8');
		try {
			const loaded = await loadProviderManifest(manifestPath, dataDirectory);
			const plan = await buildProviderPlan(resolveProviderConfig({ env: {
				TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
				TREESEED_PROVIDER_DATA_DIR: dataDirectory,
			} })) as { lanes: Array<{ purpose: string }>; adapters: Array<{ id: string }>; capacity: { maxConcurrentWorkers: number }; capabilities: string[] };
			expect(plan.lanes.map((lane) => lane.purpose)).toEqual(['communication', 'platform', 'workday']);
			expect(plan.adapters.map((adapter) => adapter.id)).toContain('codex-local');
			expect(plan.capacity.maxConcurrentWorkers).toBeGreaterThan(0);
			expect(plan.capabilities).toContain('treeseed.coordination.conversation');
			await writeProviderConnections(loaded, [{ id: 'local', controlPlaneUrl: 'http://127.0.0.1:3002', controlPlaneAudience: 'http://127.0.0.1:3002',
				teamId: 'team-1', providerId: 'provider-1', membershipId: 'membership-1', membershipCredentialRef: 'data://credential',
				membershipCredentialId: 'credential-1', offer: { maxConcurrentRunners: 1, capabilities: ['treeseed.coordination.conversation'] } }]);
			expect(readFileSync(manifestPath, 'utf8')).toBe(canonical);
			expect(statSync(resolve(dataDirectory, 'connections.yaml')).mode & 0o777).toBe(0o600);
			expect((await loadProviderManifest(manifestPath, dataDirectory)).manifest.connections).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('discovers durable pending registrations for automatic approval polling', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-pending-'));
		try {
			await writeProviderConnectionState(root, { schemaVersion: 1, connectionId: 'primary', controlPlaneUrl: 'https://api.example.test', controlPlaneAudience: 'https://api.example.test', offer: { maxConcurrentRunners: 1, capabilities: ['communication'] }, registrationRequestId: 'request-1', registrationStatus: 'pending', updatedAt: new Date().toISOString() });
			expect((await listProviderConnectionStates(root)).map((state) => state.connectionId)).toEqual(['primary']);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it('persists only the connection-state allowlist and drops registration-code values', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-state-redaction-'));
		try {
			await writeProviderConnectionState(root, { schemaVersion: 1, connectionId: 'primary', controlPlaneUrl: 'https://api.example.test',
				offer: { maxConcurrentRunners: 1, capabilities: ['communication'] }, registrationRequestId: 'request-1', registrationStatus: 'pending',
				updatedAt: new Date().toISOString(), registrationCode: 'must-not-persist' } as any);
			const stored = readFileSync(resolve(root, 'connections/primary.json'), 'utf8');
			expect(stored).not.toContain('registrationCode');
			expect(stored).not.toContain('must-not-persist');
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it('contains no raw control-plane paths or removed Market/API runtime terms', () => {
		const source = sourceFiles(resolve(process.cwd(), 'src')).map((path) => readFileSync(path, 'utf8')).join('\n');
		expect(source).not.toMatch(/\/v1\//u);
		expect(source).not.toMatch(/enrollmentToken|one-time token/u);
		expect(source).not.toMatch(/MarketClient|marketId|marketUrl|marketAudience|TREESEED_MARKET/u);
		expect(source).not.toMatch(/@treeseed\/sdk\/(?:sdk|platform|operations|copilot|git-runtime|frontmatter|content-operations|agent-tools)(?:['"]|\/)/u);
	});

	it('publishes capability identifiers rather than local capability objects', () => {
		expect(providerAvailabilityCapabilities({
			adapters: [{ capabilities: ['treeseed.coordination.conversation', 'treeseed.engineering.code-change'] }],
			lanes: [{ capabilities: ['treeseed.coordination.conversation', 'treeseed.coordination.planning'] }],
			capacity: {},
		})).toEqual(['treeseed.coordination.conversation', 'treeseed.coordination.planning', 'treeseed.engineering.code-change']);
	});
});
