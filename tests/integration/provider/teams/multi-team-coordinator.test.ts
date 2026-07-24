import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapacityProviderCoordinator } from '../../../../src/provider/coordination/coordinator.ts';
import { initializeCapacityProviderIdentity } from '../../../../src/provider/accounts/identity.ts';
import { loadProviderManifest, providerConnectionMarketAudience, providerConnectionMarketUrl } from '../../../../src/provider/configuration/manifest.ts';

function json(payload: unknown, status = 200) {
	return new Response(JSON.stringify({ ok: status < 400, payload }), { status, headers: { 'content-type': 'application/json' } });
}

describe('multi-team capacity provider coordinator', () => {
	it('fails clearly when prelaunch connection state has no durable offer', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-stale-state-'));
		try {
			const dataDirectory = resolve(root, 'state');
			await initializeCapacityProviderIdentity({ ref: 'data://identity.jwk', baseDirectory: root, dataDirectory });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2', 'identity:', '  privateKeyRef: data://identity.jwk', '  displayName: Stale Provider',
				'executionProviders:', '  - id: codex', '    adapter: codex', '    nativeLimits: { maxConcurrentRunners: 1 }',
				'connections: []',
			].join('\n'));
			await mkdir(resolve(dataDirectory, 'connections'), { recursive: true });
			await writeFile(resolve(dataDirectory, 'connections', 'stale.json'), JSON.stringify({
				schemaVersion: 1, connectionId: 'stale', marketUrl: 'https://stale.example.test',
				registrationRequestId: 'request-stale', updatedAt: new Date().toISOString(),
			}));
			const coordinator = new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), dataDirectory);
			await expect(coordinator.pollRegistrationStatus('stale')).rejects.toThrow('missing its durable supply offer');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('separates private transport URLs from canonical proof audiences', () => {
		const connection = { id: 'local', marketProfile: 'local', offer: { capabilities: ['engineering'] } };
		const env = {
			TREESEED_MARKET_PROFILE_LOCAL_URL: 'http://host.docker.internal:3000',
			TREESEED_MARKET_PROFILE_LOCAL_AUDIENCE: 'http://127.0.0.1:3000',
		};
		expect(providerConnectionMarketUrl(connection, env)).toBe('http://host.docker.internal:3000');
		expect(providerConnectionMarketAudience(connection, env)).toBe('http://127.0.0.1:3000');
	});

	it('registers, waits for approval, and establishes independent team tokens', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-coordinator-'));
		try {
			const dataDirectory = resolve(root, 'state');
			await initializeCapacityProviderIdentity({ ref: 'data://identity.jwk', baseDirectory: root, dataDirectory });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2',
				'identity:',
				'  privateKeyRef: data://identity.jwk',
				'  displayName: Shared Build Provider',
				'executionProviders:',
				'  - id: codex',
				'    adapter: codex',
				'    nativeLimits: { maxConcurrentRunners: 2 }',
				'connections: []',
			].join('\n'));
			const calls: Array<{ url: string; init?: RequestInit }> = [];
			const credentialGenerations = new Map<string, number>();
			const fetchMock: typeof fetch = async (request, init) => {
				const url = String(request);
				calls.push({ url, init });
				const team = url.includes('team-a') ? 'team-a' : 'team-b';
				if (url.endsWith('/v1/provider-registrations') && init?.method === 'POST') return json({ id: `request-${team}`, teamId: team, providerId: 'provider-shared', providerFingerprint: 'fingerprint', registrationKeyGeneration: 1, status: 'pending', capabilitySummary: [], supplyOffer: { capabilities: [] }, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
				if (url.includes('/v1/provider-registrations/request-') && init?.method === 'GET') return json({ id: `request-${team}`, teamId: team, providerId: 'provider-shared', providerFingerprint: 'fingerprint', registrationKeyGeneration: 1, status: 'approved', membershipId: `membership-${team}`, capabilitySummary: [], supplyOffer: { capabilities: [] }, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
				if (url.endsWith('/v1/provider/credential-rotation')) return json({ id: `authorization-${team}-2`, membershipId: `membership-${team}`, teamId: team, providerId: 'provider-shared', generation: 2, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
				if (url.endsWith('/credential')) {
					const generation = (credentialGenerations.get(team) ?? 0) + 1;
					credentialGenerations.set(team, generation);
					return json({ id: `credential-${team}-${generation}`, membershipId: `membership-${team}`, teamId: team, providerId: 'provider-shared', keyPrefix: 'tspc_test', issuanceGeneration: generation, status: 'active', scopes: ['provider:assignments:read'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), credential: `tspc_${team}_${generation}_secret` }, 201);
				}
				if (url.endsWith('/v1/provider/access-tokens')) {
					const body = JSON.parse(String(init?.body)) as { credentialId: string };
					return json({ id: `token-${team}`, teamId: team, providerId: 'provider-shared', membershipId: `membership-${team}`, credentialId: body.credentialId, status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: `tspa_${team}_token`, identityVersion: 1 }, 201);
				}
				return json({ error: 'unexpected request' }, 500);
			};
			const coordinator = new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), dataDirectory, { env: { TEAM_A_REGISTRATION_KEY: 'tsreg_a_secret', TEAM_B_REGISTRATION_KEY: 'tsreg_b_secret' }, fetch: fetchMock });
			const pending = await Promise.all([
				coordinator.beginJoin({ id: 'team-a', marketUrl: 'https://team-a.example.test', registrationKeyRef: 'env://TEAM_A_REGISTRATION_KEY', offer: { sharePercent: 50, maxConcurrentRunners: 1, capabilities: ['engineering'] } }),
				coordinator.beginJoin({ id: 'team-b', marketUrl: 'https://team-b.example.test', registrationKeyRef: 'env://TEAM_B_REGISTRATION_KEY', offer: { sharePercent: 50, maxConcurrentRunners: 1, capabilities: ['research'] } }),
			]);
			expect(pending.map((entry) => entry.status)).toEqual(['pending-approval', 'pending-approval']);
			const connected = await Promise.all([coordinator.exchangeRegistrationCredential('team-a'), coordinator.exchangeRegistrationCredential('team-b')]);
			expect(connected.map((entry) => entry.status)).toEqual(['connected', 'connected']);
			expect(connected.map((entry) => entry.runtime?.teamId)).toEqual(['team-a', 'team-b']);
			expect(new Set(connected.map((entry) => entry.runtime?.accessToken.accessToken)).size).toBe(2);
			expect(calls.filter((entry) => entry.url.endsWith('/v1/provider-registrations'))).toHaveLength(2);
			const durable = await loadProviderManifest(manifestPath);
			expect(durable.manifest.connections).toHaveLength(2);
			expect(JSON.stringify(durable.manifest)).not.toContain('registrationKeyRef');
			expect(durable.manifest.connections.map((entry) => entry.membershipCredentialRef)).toEqual(['data://secrets/team-a.credential', 'data://secrets/team-b.credential']);
			const rotated = await coordinator.rotateConnectionCredential('team-a');
			expect(rotated.runtime?.credentialId).toBe('credential-team-a-2');
			expect((await loadProviderManifest(manifestPath)).manifest.connections.find((entry) => entry.id === 'team-b')?.membershipCredentialId).toBe('credential-team-b-1');
			const reloaded = await new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), dataDirectory, { fetch: fetchMock }).reconcileAll();
			expect(reloaded.map((entry) => entry.status)).toEqual(['connected', 'connected']);
			expect(calls.filter((entry) => entry.url.endsWith('/v1/provider/access-tokens'))).toHaveLength(3);
			const offlineReload = await new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), dataDirectory, { fetch: async () => { throw new Error('control plane offline'); } }).reconcileAll();
			expect(offlineReload.map((entry) => entry.status)).toEqual(['connected', 'connected']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('isolates a failing team connection from healthy connections', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-isolation-'));
		try {
			const identityPath = resolve(root, 'identity.jwk');
			await initializeCapacityProviderIdentity({ ref: `file://${identityPath}`, baseDirectory: root });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2',
				'identity:',
				`  privateKeyRef: file://${identityPath}`,
				'  displayName: Isolated Provider',
				'executionProviders:',
				'  - id: codex',
				'    adapter: codex',
				'    nativeLimits: { maxConcurrentRunners: 1 }',
				'connections:',
				'  - id: healthy',
				'    marketUrl: https://healthy.example.test',
				'    teamId: healthy',
				'    providerId: provider-shared',
				'    membershipId: membership-healthy',
				'    membershipCredentialRef: env://HEALTHY_CREDENTIAL',
				'    membershipCredentialId: credential-healthy',
				'    offer: { capabilities: [engineering] }',
				'  - id: broken',
				'    marketUrl: https://broken.example.test',
				'    teamId: broken',
				'    providerId: provider-shared',
				'    membershipId: membership-broken',
				'    membershipCredentialRef: env://MISSING_CREDENTIAL',
				'    membershipCredentialId: credential-broken',
				'    offer: { capabilities: [research] }',
			].join('\n'));
			const fetchMock: typeof fetch = async (request) => {
				const team = String(request).includes('healthy') ? 'healthy' : 'broken';
				return json({ id: `token-${team}`, teamId: team, providerId: 'provider-shared', membershipId: `membership-${team}`, credentialId: `credential-${team}`, status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: `tspa_${team}_token`, identityVersion: 1 }, 201);
			};
			const coordinator = new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), resolve(root, 'state'), { env: { HEALTHY_CREDENTIAL: 'tspc_healthy_secret' }, fetch: fetchMock });
			const results = await coordinator.reconcileAll();
			expect(results.map((entry) => entry.status)).toEqual(['connected', 'error']);
			expect(results[1].error).toContain('MISSING_CREDENTIAL');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('removes revoked or unreachable connections and local credentials while reporting unconfirmed remote revocation', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-leave-revoked-'));
		try {
			const dataDirectory = resolve(root, 'state');
			await initializeCapacityProviderIdentity({ ref: 'data://identity.jwk', baseDirectory: root, dataDirectory });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2', 'identity:', '  privateKeyRef: data://identity.jwk', '  displayName: Revoked Provider',
				'executionProviders:', '  - id: codex', '    adapter: codex', '    nativeLimits: { maxConcurrentRunners: 1 }',
				'connections:', '  - id: revoked', '    marketUrl: https://revoked.example.test', '    teamId: team-revoked',
				'    providerId: provider-revoked', '    membershipId: membership-revoked',
				'    membershipCredentialRef: data://secrets/revoked.credential', '    membershipCredentialId: credential-revoked',
				'    offer: { capabilities: [research] }',
			].join('\n'));
			await mkdir(resolve(dataDirectory, 'connections'), { recursive: true });
			await mkdir(resolve(dataDirectory, 'secrets'), { recursive: true });
			await writeFile(resolve(dataDirectory, 'connections', 'revoked.json'), JSON.stringify({
				schemaVersion: 1,
				connectionId: 'revoked',
				marketUrl: 'https://revoked.example.test',
				teamId: 'team-revoked',
				providerId: 'provider-revoked',
				membershipId: 'membership-revoked',
				credentialId: 'credential-revoked',
				generatedCredentialRef: 'data://secrets/revoked.credential',
				registrationStatus: 'approved',
				updatedAt: new Date().toISOString(),
			}));
			await writeFile(resolve(dataDirectory, 'secrets', 'revoked.credential'), 'revoked-secret\n');
			const coordinator = new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), dataDirectory, {
				fetch: async () => json({ error: 'revoked' }, 401),
			});
			const result = await coordinator.leaveConnection('revoked');
			expect(result).toMatchObject({
				connectionId: 'revoked',
				remoteRevocationConfirmed: false,
				remoteError: expect.stringMatching(/invalid|401|credential/iu),
			});
			expect((await loadProviderManifest(manifestPath)).manifest.connections).toEqual([]);
			await expect(access(resolve(dataDirectory, 'connections', 'revoked.json'))).rejects.toThrow();
			await expect(access(resolve(dataDirectory, 'secrets', 'revoked.credential'))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects an access token cross-wired to another membership', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-token-binding-'));
		try {
			const identityPath = resolve(root, 'identity.jwk');
			await initializeCapacityProviderIdentity({ ref: `file://${identityPath}`, baseDirectory: root });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2', 'identity:', `  privateKeyRef: file://${identityPath}`, '  displayName: Bound Provider',
				'executionProviders:', '  - id: codex', '    adapter: codex', '    nativeLimits: { maxConcurrentRunners: 1 }',
				'connections:', '  - id: team-a', '    marketUrl: https://team-a.example.test', '    teamId: team-a',
				'    providerId: provider-shared', '    membershipId: membership-team-a', '    membershipCredentialRef: env://TEAM_A_CREDENTIAL',
				'    membershipCredentialId: credential-team-a', '    offer: { capabilities: [research] }',
			].join('\n'));
			const coordinator = new CapacityProviderCoordinator(await loadProviderManifest(manifestPath), resolve(root, 'state'), {
				env: { TEAM_A_CREDENTIAL: 'tspc_team_a_secret' },
				fetch: async () => json({ id: 'token-wrong', teamId: 'team-b', providerId: 'provider-other', membershipId: 'membership-team-b', credentialId: 'credential-team-a', status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: 'tspa_wrong', identityVersion: 1 }, 201),
			});
			await expect(coordinator.reconcileAll()).resolves.toEqual([expect.objectContaining({ status: 'error', error: expect.stringContaining('team, provider, membership, and credential binding') })]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
