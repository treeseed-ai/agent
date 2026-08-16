import { mkdir,mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recoverProviderLocalLeases } from '../../../../src/provider/coordination/lease-recovery.ts';
import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { resolveProviderConfig } from '../../../../src/provider/configuration/config.ts';
import type { ProviderConnectionRuntime } from '../../../../src/provider/coordination/coordinator.ts';

describe('provider-local lease restart recovery', () => {
	function connection(): ProviderConnectionRuntime {
		return {
			connection: { id: 'team-a', marketUrl: 'https://team-a.test', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', membershipCredentialRef: 'data://team-a', membershipCredentialId: 'credential-a', offer: { capabilities: ['research'] } },
			marketUrl: 'https://team-a.test', marketAudience: 'https://team-a.test', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', credentialId: 'credential-a',
			accessToken: { id: 'token-a', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', credentialId: 'credential-a', status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), accessToken: 'token-a', identityVersion: 1 },
		};
	}

	it('returns an observed active lease before releasing its durable local claim', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-lease-recovery-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Expected a local claim.');
		await store.attachLease(claim.id, { assignmentId: 'assignment-a', leaseToken: 'lease-a', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {} });
		await store.claimDispatch();
			const returnAssignment = vi.fn(async () => ({ ok: true }));
			const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: root, HOME: root } });
			const results = await recoverProviderLocalLeases({
				config,
				connections: [connection()],
				store,
				clientFactory: () => ({ assignment: async () => ({ ok: true, payload: { id: 'assignment-a', status: 'leased' } }), returnAssignment }),
			});
			expect(returnAssignment).toHaveBeenCalledWith('assignment-a', expect.objectContaining({ leaseToken: 'lease-a', runnerId: claim.runnerId, code: 'provider_restart_recovery' }));
			expect(results).toEqual([expect.objectContaining({ status: 'returned', assignmentId: 'assignment-a' })]);
			expect((await store.snapshot()).claims).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('removes an orphan context only after authoritative terminal read-back', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-orphan-recovery-'));
		try {
			const assignmentId = 'assignment-orphan';
			const contextRoot = resolve(root, 'assignment-contexts', assignmentId);
			await mkdir(resolve(contextRoot, '.treeseed', 'generated'), { recursive: true });
			const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: root, HOME: root } });
			const results = await recoverProviderLocalLeases({
				config,
				connections: [connection()],
				clientFactory: () => ({
					assignment: async () => ({ ok: true, payload: { id: assignmentId, status: 'cancelled' } }),
					returnAssignment: async () => ({ ok: true }),
				}),
			});
			expect(results).toEqual([expect.objectContaining({
				assignmentId, status: 'released', observedStatus: 'cancelled',
				materialization: { status: 'released', kind: 'context' },
			})]);
			expect(await mkdir(contextRoot, { recursive: false }).then(() => true, () => false)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
