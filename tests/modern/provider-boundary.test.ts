import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { providerOperationPath } from '../../src/provider/coordination/client.ts';
import { executorModuleSpecifier, resolveAgentExecutor } from '../../src/provider/execution/executor-loader.ts';
import { resolveProviderConfig } from '../../src/provider/configuration/config.ts';
import { ensureCapacityProviderIdentity } from '../../src/provider/accounts/identity.ts';
import { listProviderConnectionStates, writeProviderConnectionState } from '../../src/provider/coordination/connection-state.ts';
import { loadProviderManifest, writeProviderConnections } from '../../src/provider/configuration/manifest.ts';
import { buildProviderPlan, providerAvailabilityCapabilities } from '../../src/provider/lifecycle/lifecycle.ts';
import { stringify as stringifyYaml } from 'yaml';

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

	it('fails closed when no trusted executor module is configured', async () => {
		const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: '/tmp/provider' } });
		expect(config.executorModule).toBeNull();
		await expect(resolveAgentExecutor(config, { id: 'codex', adapter: 'codex', isolation: 'worker', laneIds: ['workday'], maxConcurrentWorkers: 1, nativeLimits: {} })).resolves.toBeNull();
	});

	it('resolves only reviewed portable executor module identifiers', () => {
		expect(executorModuleSpecifier('module:codex-chat')).toBe('@treeseed/agent/executors/codex-chat');
		expect(() => executorModuleSpecifier('module:unknown')).toThrow(/Unknown capacity provider executor module/u);
	});

	it('creates one fresh private identity in local enrollment custody and reuses it on retry', async () => {
		const dataDirectory = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-identity-'));
		try {
			const input = { ref: 'data://identity-v3.json', baseDirectory: dataDirectory, dataDirectory };
			const first = await ensureCapacityProviderIdentity(input);
			const second = await ensureCapacityProviderIdentity(input);
			expect(second.publicJwk).toEqual(first.publicJwk);
			expect(statSync(resolve(dataDirectory, 'identity-v3.json')).mode & 0o777).toBe(0o600);
			const stored = JSON.parse(readFileSync(resolve(dataDirectory, 'identity-v3.json'), 'utf8')) as { d?: string; x?: string };
			expect(stored.x).toBe(first.publicJwk.x);
			expect(typeof stored.d).toBe('string');
		} finally {
			rmSync(dataDirectory, { recursive: true, force: true });
		}
	});

	it('stores mutable connections in local custody without rewriting the canonical manifest', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-connections-'));
		const dataDirectory = resolve(root, 'data');
		const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
		const manifest = {
			schemaVersion: 3, ownership: { type: 'team', teamId: 'team-1' }, configuration: { generation: 'test' },
			identity: { privateKeyRef: 'data://identity-v3.json', displayName: 'Test' },
			capacity: { maxConcurrentWorkers: 1 }, credentialProfiles: [],
			lanes: [
				{ id: 'communication', purpose: 'communication', priority: 100, reservedConcurrentWorkers: 1, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 30 },
				{ id: 'platform', purpose: 'platform', priority: 70, reservedConcurrentWorkers: 0, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 30 },
				{ id: 'workday', purpose: 'workday', priority: 50, reservedConcurrentWorkers: 0, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 30 },
			],
			adapters: [{ id: 'test', adapter: 'codex', isolation: 'process', laneIds: ['communication', 'workday'], maxConcurrentWorkers: 1, nativeLimits: {}, capabilities: ['communication'] }],
			connections: [],
		};
		writeFileSync(manifestPath, stringifyYaml(manifest));
		const canonical = readFileSync(manifestPath, 'utf8');
		try {
			const loaded = await loadProviderManifest(manifestPath, dataDirectory);
			const plan = await buildProviderPlan(resolveProviderConfig({ env: {
				TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
				TREESEED_PROVIDER_DATA_DIR: dataDirectory,
			} })) as { lanes: Array<{ purpose: string }>; adapters: Array<{ id: string }>; capacity: { maxConcurrentWorkers: number }; capabilities: string[] };
			expect(plan.lanes.map((lane) => lane.purpose)).toEqual(['communication', 'platform', 'workday']);
			expect(plan.adapters.map((adapter) => adapter.id)).toEqual(['test']);
			expect(plan.capacity.maxConcurrentWorkers).toBe(1);
			expect(plan.capabilities).toEqual(['communication']);
			await writeProviderConnections(loaded, [{ id: 'local', controlPlaneUrl: 'http://127.0.0.1:3002', controlPlaneAudience: 'http://127.0.0.1:3002',
				teamId: 'team-1', providerId: 'provider-1', membershipId: 'membership-1', membershipCredentialRef: 'data://credential',
				membershipCredentialId: 'credential-1', offer: { maxConcurrentRunners: 1, capabilities: ['communication'] } }]);
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

	it('contains no raw control-plane paths or removed Market/API runtime terms', () => {
		const source = sourceFiles(resolve(process.cwd(), 'src')).map((path) => readFileSync(path, 'utf8')).join('\n');
		expect(source).not.toMatch(/\/v1\//u);
		expect(source).not.toMatch(/MarketClient|marketId|marketUrl|marketAudience|TREESEED_MARKET/u);
		expect(source).not.toMatch(/@treeseed\/sdk\/(?:sdk|platform|operations|copilot|git-runtime|frontmatter|content-operations|agent-tools)(?:['"]|\/)/u);
	});

	it('publishes capability identifiers rather than local capability objects', () => {
		expect(providerAvailabilityCapabilities({
			adapters: [{ capabilities: ['communication', 'acting'] }],
			lanes: [{ capabilities: ['communication', 'planning'] }],
			capacity: {},
		})).toEqual(['acting', 'communication', 'planning']);
	});
});
