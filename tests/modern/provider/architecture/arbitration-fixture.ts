import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createManagedProviderManifestV5 } from '../../../../src/provider/configuration/managed-manifest.ts';
import { providerOperationPath } from '../../../../src/provider/coordination/client.ts';
import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';
import { request } from '../../kernel/provider-kernel-fixture.ts';

export async function arbitrationFixture(workers = 1) {
	const directory = await mkdtemp(join(tmpdir(), 'agent-global-arbitration-'));
	const runtimeBuild = `sha256:${'d'.repeat(64)}`;
	const manifest = createManagedProviderManifestV5({ release: 'authoring-native', guestImage: 'isolated/guest',
		guestImageDigest: runtimeBuild, baseImageDigest: runtimeBuild, provenanceDigest: runtimeBuild });
	manifest.capacity.maxConcurrentWorkers = workers;
	const routes: Array<{ connectionId: string; method: string; path: string; body: unknown }> = [];
	const faults = new Map<string, { code?: number; fault?: 'reset' | 'json'; tokenPatch?: Record<string, unknown> }>();
	let leased: unknown = null, returnStatus = 200, held = false;
	const releases = new Set<() => void>();
	const tokenPath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.issueAccessToken);
	const pollPath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.nextAssignment);
	const server = createServer((incoming, outgoing) => {
		let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; });
		incoming.on('end', async () => {
			try {
				const body: unknown = raw ? JSON.parse(raw) : null;
				const path = new URL(incoming.url ?? '', 'http://127.0.0.1').pathname;
				const supplied = body && typeof body === 'object' && 'credentialId' in body ? body.credentialId : null;
				const connection = path === tokenPath ? manifest.connections.find(item => item.membershipCredentialId === supplied)
					: manifest.connections.find(item => incoming.headers.authorization === `Bearer isolated-token-${item.id}`);
				if (!connection) { outgoing.statusCode = 403; outgoing.end('{}'); return; }
				// No credential headers, private keys, token values or proofs are retained in logs.
				const recordedBody = path === tokenPath ? { credentialId: supplied } : body;
				routes.push({ connectionId: connection.id, method: incoming.method ?? '', path, body: recordedBody });
				if (path !== tokenPath && path !== pollPath && !path.endsWith('/return')) { outgoing.statusCode = 403; outgoing.end('{}'); return; }
				const failure = faults.get(connection.id);
				if (failure?.fault === 'reset') { incoming.socket.destroy(); return; }
				outgoing.setHeader('content-type', 'application/json');
				if (failure?.fault === 'json') { outgoing.end('{'); return; }
				const code = path.endsWith('/return') ? returnStatus : failure?.code ?? 200;
				outgoing.statusCode = code;
				if (code !== 200) { outgoing.end(JSON.stringify({ status: code, code: 'controlled_denial', title: 'Controlled denial' })); return; }
				if (path === tokenPath) {
					outgoing.end(JSON.stringify({ data: { id: `token-${connection.id}`, teamId: connection.teamId,
						providerId: connection.providerId, membershipId: connection.membershipId, credentialId: connection.membershipCredentialId,
						status: 'active', scopes: [], identityVersion: 1, accessToken: `isolated-token-${connection.id}`,
						issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...failure?.tokenPatch } }));
				} else if (path === pollPath) {
					if (held) await new Promise<void>(resolve => releases.add(resolve));
					outgoing.end(JSON.stringify({ data: leased ?? { assignment: null } }));
				} else outgoing.end(JSON.stringify({ data: { assignment: { status: 'returned' } } }));
			} catch { outgoing.statusCode = 500; outgoing.end('{}'); }
		});
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native loopback API required');
		const url = `http://127.0.0.1:${address.port}`;
		const capability = manifest.adapters[0]?.offers[0]?.offer.capabilities[0]?.id;
		if (!capability) throw new Error('Original managed offer capability required');
		manifest.connections = ['busy-a', 'busy-b', 'quiet'].map(id => ({ id, controlPlaneUrl: url, controlPlaneAudience: url,
			// The original manifest contract permits ONE connection per team.
			// Two independently busy teams are compared with a third quiet team;
			// duplicate-team manifests must fail before native polling.
			teamId: `${id}-team`, providerId: 'isolated-provider', membershipId: `membership-${id}`,
			membershipCredentialId: `credential-${id}`, membershipCredentialRef: `data://credential-${id}`,
			offer: { capabilities: [capability], maxConcurrentRunners: 1 } }));
		const config: ProviderHostRuntimeConfig = { dataDir: directory, manifestPath: join(directory, 'manifest.yaml'), environment: 'local',
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
			env: { TREESEED_PROVIDER_RUNTIME_BUILD: runtimeBuild }, redactedEnv: {} };
		const keyPath = join(directory, 'fixture-os-key'); await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
		const env: NodeJS.ProcessEnv = { ...process.env, TREESEED_PROVIDER_CREDENTIAL_KEK_FILE: keyPath };
		// No inherited runtime redirection, development override or externally selected server.
		delete env.TREESEED_DEVELOPMENT_MODE; delete env.TREESEED_CONTROL_PLANE_URL;
		delete env.TREESEED_DEVELOPMENT_SANDBOX_GUEST_DIGEST;
		const write = async () => { await writeFile(config.manifestPath!, stringify(manifest, { aliasDuplicateObjects: false })); await writeFile(join(directory, 'config.json'), JSON.stringify(config)); };
		const children = new Set<Promise<{ stdout: string; stderr: string }>>();
		const child = async (action: 'initialize' | 'run' | 'offers') => {
			// Pinned Node 24 executes this erasable TypeScript entrypoint natively;
			// the owning provider implementation remains the exact compiled build.
			const running = promisify(execFile)(process.execPath, [fileURLToPath(new URL('./arbitration-process.ts', import.meta.url)), action, directory],
				{ env, timeout: 15_000, maxBuffer: 1024 * 1024 }); children.add(running);
			try { return JSON.parse((await running).stdout) as unknown; } finally { children.delete(running); }
		};
		await write(); await child('initialize');
		const store = new ProviderLocalCapacityStore(directory);
		const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
		return { directory, manifest, config, store, routes, tokenPath, pollPath, faults, write,
			run: () => child('run'), offers: () => child('offers'), setLease(value: unknown, status = 200) { leased = value; returnStatus = status; },
			hold() { held = true; }, release() { held = false; for (const resolve of releases) resolve(); releases.clear(); },
			async awaitPoll() {
				const end = Date.now() + 10_000;
				while (!routes.some(item => item.path === pollPath)) {
					if (Date.now() >= end) throw new Error('Actual native polling barrier was not reached');
					await new Promise(resolve => setTimeout(resolve, 10));
				}
			},
			async measure(connectionId: string) {
				const claim = await store.claim({ connectionId, globalLimit: workers, connectionLimit: 1 });
				if (!claim) throw new Error('Native local measurement claim required');
				await store.attachLease(claim.id, { assignmentId: attempt.id, leaseToken: 'isolated-local-history',
					leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), executionProviderId: attempt.provider.executionProviderId,
					laneId: 'workday', requestedSeconds: attempt.limits.maximumSeconds,
					dispatchEnvelope: { assignment: { id: attempt.id, assignmentAttempt: attempt } },
					accounting: { modelConfigurationId: attempt.provider.modelConfigurationId, capabilityId: attempt.provider.executionCapabilityId,
						dailyActiveSecondsLimit: 120, capabilityDailyActiveSecondsLimit: 120, maximumAssignmentSeconds: attempt.limits.maximumSeconds } });
				await store.claimDispatch(claim.id); await store.beginActiveExecution(claim.id);
				await new Promise(resolve => setTimeout(resolve, 20)); await store.finishActiveExecution(claim.id);
				await store.finalize(claim.id, 'isolated-local-history');
			},
			bytes: () => readFile(join(directory, 'runtime', 'capacity-state.json'), 'utf8'),
			async close() {
				held = false; for (const resolve of releases) resolve(); releases.clear();
				await Promise.allSettled([...children]); server.closeAllConnections();
				await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
			} };
	} catch (error) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true }); throw error; }
}
