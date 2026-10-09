import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { providerOperationPath } from '../../src/provider/coordination/client.ts';
import { providerRegistrationIdempotencyKey } from '../../src/provider/coordination/coordinator.ts';
import { resolveProviderConfig } from '../../src/provider/configuration/config.ts';
import { runMultiTeamProviderRunners } from '../../src/provider/teams/multi-team-runtime.ts';
import { ensureCapacityProviderIdentity } from '../../src/provider/accounts/identity.ts';
import { listProviderConnectionStates, writeProviderConnectionState } from '../../src/provider/coordination/connection-state.ts';
import { loadProviderManifest, writeProviderConnections } from '../../src/provider/configuration/manifest.ts';
import { buildProviderPlan, providerAvailabilityCapabilities } from '../../src/provider/lifecycle/lifecycle.ts';
import { providerEnrollmentInput } from '../../src/provider/lifecycle/enrollment-input.ts';
import { stringify as stringifyYaml } from 'yaml';
import { createManagedProviderManifestV5 } from '../../src/provider/configuration/managed-manifest.ts';
import { assertGitWorkPublication, assignmentAllowedServices, timingAwarenessEvidence } from '../../src/provider/execution/microvm-executor.ts';
import { capabilityOfferDigest, validateCapacityProviderManifestV5, type CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import * as providerContracts from '@treeseed/sdk/capacity-provider/contracts';
vi.mock('@treeseed/sdk/capacity-provider/contracts', async importOriginal => {
	const original = await importOriginal<typeof import('@treeseed/sdk/capacity-provider/contracts')>();
	return { ...original, validateCapacityProviderManifestV5: vi.fn(original.validateCapacityProviderManifestV5) };
});

const digest = (value: string) => `sha256:${value.repeat(64)}`;
function providerManifestFixture() {
	const lane = (id: 'communication' | 'platform' | 'workday', priority: number, reservedConcurrentWorkers: number) => ({
		id, purpose: id, priority, reservedConcurrentWorkers, maxConcurrentWorkers: 4, borrowWhenIdle: true, lendWhenIdle: true,
		reclaimPolicy: 'admission', queueLimit: 10, timeoutSeconds: 120, capabilities: ['treeseed.coordination.conversation'],
	});
	const managed = createManagedProviderManifestV5({ release: 'unit-custody-input', guestImage: 'isolated/guest',
		guestImageDigest: digest('5'), baseImageDigest: digest('6'), provenanceDigest: digest('7') });
	const qualification = managed.adapters.flatMap(adapter => adapter.offers.flatMap(binding => binding.offer.conformance))
		.find(receipt => receipt.capability.id === 'treeseed.coordination.conversation');
	if (!qualification) throw new Error('Original managed conversation qualification input required');
	const capability = qualification.capability;
	const offer: CapabilityOffer = { schemaVersion: 'treeseed.capability-offer/v2', offerId: 'conversation', capabilities: [capability], features: [], configurationSupport: {},
		permissionClasses: [], contextModes: ['manifest'], inputContracts: [], outputContracts: [], interactionModes: ['interactive'],
		conformance: [structuredClone(qualification)],
		contextCapacity: { mode:'bounded',measurement:'tokens',defaultInitial:32_000,maximum:128_000,reservedOutput:8_000,transportPayloadBytes:4_194_304,measurementProvenance:{provider:'openai',implementation:'provider-reported-tokenizer',version:null} },
		limits: {}, commercial: { currency: null, estimatedCost: null }, region: null, trust: ['provider-signed'], offerDigest: digest('3') };
	const { offerDigest: _suppliedDigest, ...material } = offer; offer.offerDigest = capabilityOfferDigest(material);
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
			model: { model: 'gpt-5.4' }, credentialProfiles: [], laneIds: ['communication', 'platform', 'workday'], maxConcurrentWorkers: 4,
			nativeLimits: { modelConfigurationId: 'fixture-model', dailyActiveSecondsLimit: 0,
				capabilityLimits: { 'treeseed.coordination.conversation': { dailyActiveSecondsLimit: 0 } } }, offers: [{ offer, sandboxProfileId: 'read' }] }],
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
	it('shipped acceptance assets resolve shared owning contracts only through public package entrypoints', () => {
		const privateImports = sourceFiles(resolve('tests/acceptance')).flatMap(path => {
			const source = readFileSync(path, 'utf8');
			return [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/gu)]
				.filter(value => /(?:^|\/)src\//u.test(value[2]!)).map(value => ({ path, specifier: value[2] }));
		});
		expect(privateImports).toEqual([]);
	});
	it('validates each unchanged native manifest once per load and revalidates an applied connection overlay without caching authority across calls', async () => {
		const directory = mkdtempSync(resolve(tmpdir(), 'agent-manifest-validation-'));
		const path = resolve(directory, 'manifest.yaml'), manifest = createManagedProviderManifestV5({ release: 'validation-custody', guestImage: 'isolated/guest',
			guestImageDigest: digest('5'), baseImageDigest: digest('6'), provenanceDigest: digest('7') });
		const bytes = stringifyYaml(manifest), held = structuredClone(manifest);
		const observed = vi.mocked(providerContracts.validateCapacityProviderManifestV5); observed.mockClear();
		try {
			writeFileSync(path, bytes);
			for (let count = 1; count <= 2; count += 1) {
				expect((await loadProviderManifest(path, directory, {})).manifest).toEqual(held);
				expect(observed).toHaveBeenCalledTimes(count);
			}
			writeFileSync(resolve(directory, 'connections.yaml'), '[]\n');
			expect((await loadProviderManifest(path, directory, {})).manifest).toEqual({ ...held, connections: [] });
			expect(observed).toHaveBeenCalledTimes(4);
			expect(readFileSync(path, 'utf8')).toBe(bytes); expect(manifest).toEqual(held);
		} finally { observed.mockClear(); rmSync(directory, { recursive: true, force: true }); }
	});
	it('rejects retired provider manifest versions without rewriting supplied authority while retaining the current exact v5 contract', () => {
		const current = createManagedProviderManifestV5({ release: 'authoring-clean-cutover', guestImage: 'isolated/guest',
			guestImageDigest: digest('5'), baseImageDigest: digest('6'), provenanceDigest: digest('7') });
		const before = structuredClone(current); expect(validateCapacityProviderManifestV5(current)).toEqual({ ok: true, diagnostics: [] });
		for (const schemaVersion of [undefined, null, 1, 2, 3, 4, '5', 6]) {
			const supplied = Object.assign(structuredClone(current), { schemaVersion }), original = structuredClone(supplied);
			expect(validateCapacityProviderManifestV5(supplied).ok).toBe(false); expect(supplied).toEqual(original);
		}
		expect(current).toEqual(before);
	});
	it('refuses an unconfigured runner plan instead of asserting executor readiness without reading its provider authority', async () => {
		for (const manifestPath of [null, '']) {
			const config = { ...resolveProviderConfig({ env: {} }), manifestPath }, before = structuredClone(config);
			await expect(runMultiTeamProviderRunners(config, { mode: 'plan' })).rejects.toThrow(/manifest|configuration|authority/iu);
			expect(config).toEqual(before);
		}
	});
	it('native packaged provider plans deny legacy translated and malformed manifest bytes before any identity accounting or status write', async () => {
		// Original documented public provider entrypoint, held compiled bytes.
		// Missing entrypoint fails; no build/install/source or installed fallback.
		const entrypoint = resolve('dist/provider/lifecycle/entrypoint.js');
			const entrypointBytes = readFileSync(entrypoint), current = createManagedProviderManifestV5({ release: 'authoring-clean-cutover',
				guestImage: 'isolated/guest', guestImageDigest: digest('5'), baseImageDigest: digest('6'), provenanceDigest: digest('7') });
			const legacy = { ...structuredClone(current), schemaVersion: 4, ontology: undefined,
				sandbox: { ...current.sandbox, profiles: current.sandbox.profiles.map(({ lineage: _lineage, ...profile }) => profile) },
				lanes: current.lanes.map(lane => ({ ...lane, capabilities: ['communication', 'agent-execution'] })),
				adapters: current.adapters.map(({ offers: _offers, ...adapter }) => ({ ...adapter, capabilities: ['communication'], sandboxProfileIds: ['read'] })) };
			// Retain native block YAML on both legacy and valid authority; the three
			// unrelated field-denial rows can use the same exact flow-YAML objects.
			const variants = [stringifyYaml(legacy), '{invalid', JSON.stringify({ ...current, schemaVersion: '5' }),
				JSON.stringify({ ...current, configuration: { generation: 'release-compat-v5' } }),
				JSON.stringify({ ...current, metadata: { compatibilityMigration: 'agent-managed-v4-to-v5' } })];
			const env: NodeJS.ProcessEnv = { ...process.env,
				TREESEED_SANDBOX_BASE_DIGEST: digest('8'), TREESEED_SANDBOX_PROVENANCE_DIGEST: digest('9') };
			delete env.TREESEED_DEVELOPMENT_MODE; delete env.TREESEED_CONTROL_PLANE_URL; delete env.TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST;
			delete env.TREESEED_PROVIDER_ROLE; delete env.TREESEED_PROVIDER_STARTUP_MODE;
			const commands = [['plan', '--json'], ['manager', '--plan', '--json'], ['runner', '--plan', '--json']];
			// Each row still executes all three independent public commands together.
			// Finish its owned children before starting the next unrelated input row;
			// eighteen simultaneous cold starts are not a provider concurrency proof.
			const outcomes: PromiseSettledResult<void>[] = [];
			for (const [index, bytes] of [...variants, stringifyYaml(current)].entries()) {
			outcomes.push(...await Promise.allSettled(commands.map(async args => {
				const root = mkdtempSync(resolve(tmpdir(), 'agent-provider-cutover-')), manifestPath = resolve(root, 'manifest.yaml');
				try {
					writeFileSync(manifestPath, bytes);
					const result = await new Promise<{ status: number; stdout: string; stderr: string }>((done, reject) => {
						execFile(process.execPath, [entrypoint, ...args], { env: { ...env, TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
							TREESEED_PROVIDER_DATA_DIR: root }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576 }, (error, stdout, stderr) => {
							if (error && (error.killed || error.signal || typeof error.code !== 'number')) return reject(error);
							done({ status: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
						});
					});
					if (index < variants.length) {
						expect(result.status).toBe(1); expect(result.stdout).toBe('');
						expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: expect.any(String) });
					} else {
						expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: 'plan' });
					}
					expect(readFileSync(manifestPath, 'utf8')).toBe(bytes); expect(readdirSync(root)).toEqual(['manifest.yaml']);
				} finally { rmSync(root, { recursive: true, force: true }); }
			})));
			}
			expect(outcomes).toHaveLength((variants.length + 1) * commands.length);
			expect(readFileSync(entrypoint)).toEqual(entrypointBytes);
			for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
		// Local native public command composition, not coordinated publication,
		// selected source/build equivalence or native productive provider execution.
	});
	it('rejects a live provider without a pinned runtime build before polling', async () => {
		await expect(runMultiTeamProviderRunners(resolveProviderConfig({ env: {} })))
			.rejects.toThrow('provider_runtime_build_unpinned');
	});
	it('publishes only valid completed timing-awareness evidence', () => {
		const evidence = { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2, firstTool: 'treedx:treeseed_time_status',
			firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status', lastToolSucceeded: true,
			firstToolCompliant: true, finalToolCompliant: true };
		expect(timingAwarenessEvidence(evidence)).toEqual(evidence);
		expect(() => timingAwarenessEvidence({ requiredChecks: 2, completedChecks: 1 }))
			.toThrow(/timing-awareness evidence/u);
		expect(() => timingAwarenessEvidence({ requiredChecks: 2, completedChecks: 2 }))
			.toThrow(/timing-awareness evidence/u);
		expect(() => timingAwarenessEvidence({ ...evidence, firstTool: 'treedx:treedx_search_files', firstToolCompliant: false }))
			.toThrow(/timing-awareness evidence/u);
	});
	it('grants package restoration only to workday sandboxes', () => {
		expect(assignmentAllowedServices('workday', true)).toEqual(['model-gateway', 'codex-subscription', 'package-registry', 'treedx-relay']);
		expect(assignmentAllowedServices('conversation', true)).toEqual(['model-gateway', 'codex-subscription', 'treedx-relay']);
		expect(assignmentAllowedServices('workday', false)).toEqual(['model-gateway', 'codex-subscription', 'package-registry']);
	});
	it('accepts local simulation publication without authorizing upstream Git publication', () => {
		expect(() => assertGitWorkPublication({ mode: 'work', publication: 'simulation-branch' })).not.toThrow();
		expect(() => assertGitWorkPublication({ mode: 'work', publication: 'assignment-branch' })).not.toThrow();
		expect(() => assertGitWorkPublication({ mode: 'work', publication: 'denied' })).toThrow(/publication authority/u);
	});
	it('publishes a portable release-bound managed provider default', () => {
		const manifest = createManagedProviderManifestV5({ release: '0.13.0-rc.42', guestImage: 'treeseed/sandbox-codex',
			guestImageDigest: digest('5'), baseImageDigest: digest('6'), provenanceDigest: digest('7') });
		expect(validateCapacityProviderManifestV5(manifest)).toEqual({ ok: true, diagnostics: [] });
		expect(manifest).toMatchObject({ schemaVersion: 5, ownership: { type: 'external' }, capacity: { maxConcurrentWorkers: 1 }, connections: [],
			configuration: { generation: 'agent-release-0.13.0-rc.42' }, metadata: { custody: 'agent-release-default' } });
		expect(manifest.sandbox.profiles.map(({ id }) => id)).toEqual(['read', 'unit', 'integration', 'platform', 'connected']);
		expect(manifest.sandbox.profiles.every((profile) => profile.guestImageDigest === digest('5')
			&& profile.lineage.baseImageDigest === digest('6') && profile.lineage.provenanceDigest === digest('7'))).toBe(true);
		expect(manifest.capacity).toEqual({ maxConcurrentWorkers: 1 });
		expect(JSON.stringify(manifest)).not.toMatch(/teamId|registration|\/home\/|hostname/u);
	});
	it('derives provider proof paths from the SDK operation catalog', () => {
		expect(providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration, { requestId: 'a/b' }))
			.toContain('a%2Fb');
		expect(() => providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration))
			.toThrow(/requires path parameter requestId/u);
	});

	it('creates one fresh private identity in local enrollment custody and reuses it on retry', async () => {
		const dataDirectory = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-identity-'));
		try {
			const key=resolve(dataDirectory,'os-key');writeFileSync(key,'synthetic-provider-test-key-material',{mode:0o600});
			vi.stubEnv('TREESEED_PROVIDER_CREDENTIAL_KEK_FILE',key);
			const input = { ref: 'data://identity-v3.json', baseDirectory: dataDirectory, dataDirectory };
			const first = await ensureCapacityProviderIdentity(input);
			const second = await ensureCapacityProviderIdentity(input);
			expect(second.publicJwk).toEqual(first.publicJwk);
			const files=readdirSync(resolve(dataDirectory,'custody')).filter(name=>name.endsWith('.enc'));
			expect(files.length).toBeGreaterThan(0);
			const stored=files.map(name=>{const file=resolve(dataDirectory,'custody',name);expect(statSync(file).mode&0o777).toBe(0o600);return readFileSync(file,'utf8');}).join('');
			expect(stored).not.toContain(first.publicJwk.x);
		} finally {
			vi.unstubAllEnvs();
			rmSync(dataDirectory, { recursive: true, force: true });
		}
	});

	it('binds registration idempotency to the reusable code generation', () => {
		expect(providerRegistrationIdempotencyKey('primary', 'code-one'))
			.toBe(providerRegistrationIdempotencyKey('primary', 'code-one'));
		expect(providerRegistrationIdempotencyKey('primary', 'code-one'))
			.not.toBe(providerRegistrationIdempotencyKey('primary', 'code-two'));
	});

	it('lets the registration code resolve team authority without a separate team input', () => {
		const enrollment = providerEnrollmentInput({ connectionId: 'primary', controlPlaneUrl: 'https://api.example.test',
			registrationCode: 'team-prefixed-registration-code' }, { maxConcurrentRunners: 2,
			capabilities: ['communication', 'communication'], manifestGeneration: 'release-1' });
		expect(enrollment.join).toMatchObject({ id: 'primary', controlPlaneUrl: 'https://api.example.test',
			controlPlaneAudience: 'https://api.example.test', registrationKeyRef: 'memory://registration-code',
			offer: { maxConcurrentRunners: 2, capabilities: ['communication'], metadata: { manifestGeneration: 'release-1' } } });
		expect(enrollment.join).not.toHaveProperty('teamId');
		expect(() => providerEnrollmentInput({ controlPlaneUrl: 'https://api.example.test' }, { maxConcurrentRunners: 1,
			capabilities: [], manifestGeneration: 'release-1' })).toThrow(/registration code/u);
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

	it('binds a manager-selected guest digest only in explicit development mode', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-development-'));
		const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
		writeFileSync(manifestPath, stringifyYaml(providerManifestFixture()));
		try {
			const selected = digest('a');
			const loaded = await loadProviderManifest(manifestPath, undefined, { TREESEED_DEVELOPMENT_MODE: 'candidate', TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST: selected });
			expect(loaded.manifest.sandbox.profiles.every((profile) => profile.guestImageDigest === selected)).toBe(true);
			await expect(loadProviderManifest(manifestPath, undefined, { TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST: selected })).rejects.toThrow(/restricted to valid managed development/u);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it('rejects retired manager-custodied v4 manifests even with release lineage and preserves their bytes', async () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-v4-'));
		const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
		const current = providerManifestFixture();
		current.sandbox.profiles.push({ ...current.sandbox.profiles[0]!, id: 'unit' });
		const legacy = { ...current, schemaVersion: 4, ontology: undefined,
			sandbox: { ...current.sandbox, profiles: current.sandbox.profiles.map(({ lineage: _lineage, ...profile }) => profile) },
			lanes: current.lanes.map((lane) => ({ ...lane, capabilities: ['communication', 'agent-execution'] })),
			adapters: current.adapters.map(({ offers: _offers, ...adapter }) => ({ ...adapter, capabilities: ['communication'], sandboxProfileIds: ['read'] })) };
		writeFileSync(manifestPath, stringifyYaml(legacy));
		const canonical = readFileSync(manifestPath, 'utf8');
		try {
			await expect(loadProviderManifest(manifestPath, root, {})).rejects.toThrow(/Invalid capacity provider manifest/u);
			await expect(loadProviderManifest(manifestPath, root, { TREESEED_SANDBOX_BASE_DIGEST: digest('8'), TREESEED_SANDBOX_PROVENANCE_DIGEST: digest('9') }))
				.rejects.toThrow(/Invalid capacity provider manifest/u);
			expect(readFileSync(manifestPath, 'utf8')).toBe(canonical);
			expect(readdirSync(root)).toEqual(['treeseed.capacity-provider.yaml']);
		} finally { rmSync(root, { recursive: true, force: true }); }
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
