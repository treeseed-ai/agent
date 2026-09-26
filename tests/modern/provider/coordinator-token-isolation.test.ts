import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccessTokenIssue, ProviderConnectionConfig } from '@treeseed/sdk/capacity-provider/contracts';
import { CapacityProviderCoordinator } from '../../../src/provider/coordination/coordinator.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { initializeCapacityProviderIdentity } from '../../../src/provider/accounts/identity.ts';
import { writeProviderSecret } from '../../../src/provider/configuration/manifest.ts';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';
import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-token-isolation-')); roots.push(root);
	const key = join(root, 'os-key'); await writeFile(key, 'synthetic-os-custody-key', { mode: 0o600 });
	vi.stubEnv('TREESEED_PROVIDER_CREDENTIAL_KEK_FILE', key);
	await initializeCapacityProviderIdentity({ ref: 'data://identity', baseDirectory: root, dataDirectory: root });
	const connections = ['a', 'b'].map(id => ({ id, controlPlaneUrl: 'https://api.example.test',
		teamId: `team-${id}`, providerId: 'provider', membershipId: `membership-${id}`,
		membershipCredentialId: `credential-${id}`, membershipCredentialRef: `data://credential-${id}` })) as ProviderConnectionConfig[];
	for (const connection of connections) await writeProviderSecret(connection.membershipCredentialRef, `synthetic-${connection.id}`, root, root);
	const store = new ProviderLocalCapacityStore(root);
	const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('fixture transport unavailable'));
	const digest = `sha256:${'a'.repeat(64)}`;
	const manifest = createManagedProviderManifestV5({ release: 'fixture', guestImage: 'fixture/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	manifest.identity.privateKeyRef = 'data://identity';
	manifest.connections = connections;
	const loaded = { path: join(root, 'manifest.yaml'), directory: root, dataDirectory: root, manifest };
	const coordinator = new CapacityProviderCoordinator(loaded, root, { fetch });
	return { connections, store, coordinator, fetch, loaded, root };
}

function token(connection: ProviderConnectionConfig): ProviderAccessTokenIssue {
	return { id: `token-${connection.id}`, teamId: connection.teamId, providerId: connection.providerId,
		membershipId: connection.membershipId, credentialId: connection.membershipCredentialId,
		status: 'active', scopes: [], identityVersion: 1, accessToken: `synthetic-token-${connection.id}`,
		issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}

describe('durable provider token isolation', () => {
	it('registers, waits for approval, and establishes independent team tokens', async () => {
		const { loaded, root } = await fixture(); loaded.manifest.connections = [];
		const coordinator = new CapacityProviderCoordinator(loaded, root);
		let approved = false;
		const request = (id: string) => ({ id, teamId: `team-${id}`, providerId: 'provider', membershipId: approved ? `membership-${id}` : null, status: approved ? 'approved' : 'pending' });
		vi.spyOn(ProviderProtocolClient.prototype, 'register').mockImplementation(async (_code, submission) => request(String(submission.metadata?.connectionId)) as never);
		vi.spyOn(ProviderProtocolClient.prototype, 'registrationStatus').mockImplementation(async id => request(id) as never);
		const exchange = vi.spyOn(ProviderProtocolClient.prototype, 'exchangeCredential').mockImplementation(async id => ({ id: `credential-${id}`, teamId: `team-${id}`, providerId: 'provider', membershipId: `membership-${id}`, credential: `synthetic-${id}` }) as never);
		const issue = vi.spyOn(ProviderProtocolClient.prototype, 'issueAccessToken').mockImplementation(async (_credential, id) => token({ ...loaded.manifest.connections.find(connection => connection.membershipCredentialId === id)! }) as never);
		for (const id of ['a', 'b']) {
			expect((await coordinator.beginJoin({ id, controlPlaneUrl: 'https://api.example.test', registrationKeyRef: 'memory://code', offer: { capabilities: ['treeseed.coordination.conversation'] } }, 'synthetic-code')).status).toBe('pending-approval');
			expect((await coordinator.exchangeRegistrationCredential(id)).status).toBe('pending-approval');
		}
		expect(exchange).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled();
		approved = true;
		for (const id of ['a', 'b']) expect((await coordinator.exchangeRegistrationCredential(id)).runtime?.teamId).toBe(`team-${id}`);
		const restarted = new CapacityProviderCoordinator(loaded, root);
		for (const connection of loaded.manifest.connections) expect((await restarted.accessTokenForConnection(connection)).accessToken).toBe(`synthetic-token-${connection.id}`);
		expect(exchange).toHaveBeenCalledTimes(2); expect(issue).toHaveBeenCalledTimes(2);
	});
	it('keeps independent team tokens through coordinator restart without network access', async () => {
		const { connections, store, coordinator, fetch } = await fixture();
		for (const connection of connections) await store.saveToken(connection.id, token(connection));
		for (const connection of connections) expect((await coordinator.accessTokenForConnection(connection)).accessToken).toBe(`synthetic-token-${connection.id}`);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('never returns a cached token with another team or stale credential binding', async () => {
		const { connections, store, coordinator, fetch } = await fixture();
		const [a, b] = connections;
		for (const invalid of [token(b), { ...token(a), credentialId: 'retired' }, { ...token(a), status: 'revoked' as const }, { ...token(a), revokedAt: new Date().toISOString() }]) {
			await store.saveToken(a.id, invalid);
			await expect(coordinator.accessTokenForConnection(a)).rejects.toThrow();
		}
		expect(fetch).toHaveBeenCalledTimes(4);
	});
});
