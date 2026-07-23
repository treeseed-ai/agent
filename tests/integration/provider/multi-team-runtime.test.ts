import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderConfig } from '../../../src/provider/config.ts';
import { initializeCapacityProviderIdentity } from '../../../src/provider/identity.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/local-capacity-store.ts';
import { runMultiTeamProviderManager, runMultiTeamProviderRunners } from '../../../src/provider/multi-team-runtime.ts';

afterEach(() => vi.unstubAllGlobals());

describe('multi-team provider runner isolation', () => {
	it('continues a healthy team when another membership token is revoked', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-revocation-'));
		try {
			const dataDirectory = resolve(root, 'data');
			await initializeCapacityProviderIdentity({ ref: 'data://identity.jwk', baseDirectory: root, dataDirectory });
			await mkdir(resolve(dataDirectory, 'secrets'), { recursive: true });
			await writeFile(resolve(dataDirectory, 'secrets/healthy.credential'), 'healthy-secret\n', { mode: 0o600 });
			await writeFile(resolve(dataDirectory, 'secrets/revoked.credential'), 'revoked-secret\n', { mode: 0o600 });
			const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
			await writeFile(manifestPath, [
				'schemaVersion: 2', 'identity:', '  privateKeyRef: data://identity.jwk', '  displayName: Shared Provider',
				'executionProviders:', '  - id: codex', '    adapter: codex', '    nativeLimits: { maxConcurrentRunners: 2 }',
				'connections:',
				'  - id: healthy', '    marketUrl: https://healthy.test', '    teamId: healthy', '    providerId: provider-shared', '    membershipId: membership-healthy', '    membershipCredentialRef: data://secrets/healthy.credential', '    membershipCredentialId: credential-healthy', '    offer: { capabilities: [research], maxConcurrentRunners: 1 }',
				'  - id: revoked', '    marketUrl: https://revoked.test', '    teamId: revoked', '    providerId: provider-shared', '    membershipId: membership-revoked', '    membershipCredentialRef: data://secrets/revoked.credential', '    membershipCredentialId: credential-revoked', '    offer: { capabilities: [research], maxConcurrentRunners: 1 }',
			].join('\n'));
			const state = new ProviderLocalCapacityStore(dataDirectory);
			const token = (connection: string) => ({ id: `token-${connection}`, teamId: connection, providerId: 'provider-shared', membershipId: `membership-${connection}`, credentialId: `credential-${connection}`, status: 'active' as const, scopes: ['provider:assignments:read' as const], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: `token-${connection}`, identityVersion: 1 });
			await state.saveToken('healthy', token('healthy'));
			await state.saveToken('revoked', token('revoked'));
			vi.stubGlobal('fetch', async (request: RequestInfo | URL) => String(request).includes('revoked.test')
				? new Response(JSON.stringify({ error: 'membership revoked' }), { status: 401, headers: { 'content-type': 'application/json' } })
				: new Response(JSON.stringify(String(request).includes('/availability-sessions') ? { ok: true, payload: { id: 'session-healthy', membershipId: 'membership-healthy', teamId: 'healthy', providerId: 'provider-shared', status: 'open', sequence: 1 } } : { ok: true, payload: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
			const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: dataDirectory, TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath, TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS: '2', HOME: root } });
			const manager = await runMultiTeamProviderManager(config);
			expect(manager.connections).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: false, status: 'error' })]));
			expect(manager.dispatches).toEqual(expect.arrayContaining([expect.objectContaining({ connectionId: 'healthy', assigned: 0 })]));
			expect(manager.dispatches.every((dispatch) => dispatch.connectionId === 'healthy')).toBe(true);
			expect(await state.schedulableConnections()).toEqual(['healthy']);
			const revokedClaim = await state.claim({ connectionId: 'revoked', globalLimit: 2, connectionLimit: 1 });
			if (!revokedClaim) throw new Error('Expected a revoked-team test claim.');
			await state.attachLease(revokedClaim.id, { assignmentId: 'revoked-assignment', leaseToken: 'revoked-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: { ok: true, payload: { id: 'revoked-assignment' }, leaseToken: 'revoked-lease' } });
			const runner = await runMultiTeamProviderRunners(config);
			expect(runner).toMatchObject({ ok: true, dispatched: 0, results: [] });
			expect((await state.snapshot()).claims).toEqual([expect.objectContaining({ connectionId: 'revoked', status: 'ready' })]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
