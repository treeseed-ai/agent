import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderConfig, type ProviderConnectionRuntimeContext } from '../../../../src/provider/configuration/config.ts';
import { runManagerSkeleton } from '../../../../src/provider/lifecycle/lifecycle.ts';
import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';

afterEach(() => vi.unstubAllGlobals());

describe('provider manager availability recovery', () => {
	it('refreshes the durable membership session sequence after process recreation', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-session-recovery-'));
		try {
			const host = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: root, HOME: root } });
			const config: ProviderConnectionRuntimeContext = { ...host, connectionId: 'team-a', marketUrl: 'https://team-a.test', marketAudience: 'https://team-a.test', teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', accessToken: 'token-a' };
			const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
			vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
				calls.push({ url: String(request), method: init?.method ?? 'GET', body });
				const sequence = init?.method === 'PUT' ? 2 : 1;
				return new Response(JSON.stringify({ ok: true, payload: { id: 'session-a', membershipId: 'membership-a', teamId: 'team-a', providerId: 'provider-a', status: 'open', sequence, snapshot: { sequence, availableFrom: new Date().toISOString(), pressure: 'idle', maxConcurrentAssignments: 1, activeAssignmentIds: [], executionProviders: [], capabilities: ['research'] }, openedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }), { status: init?.method === 'PUT' ? 200 : 201, headers: { 'content-type': 'application/json' } });
			});
			const availability = { offer: { capabilities: ['research'], maxConcurrentRunners: 1 }, executionProviders: [] };
			await runManagerSkeleton(config, { availability, localState: new ProviderLocalCapacityStore(root) });
			await runManagerSkeleton(config, { availability, localState: new ProviderLocalCapacityStore(root) });
			expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT']);
			expect(calls[1]?.url).toContain('/v1/provider/availability-sessions/session-a');
			expect(calls[1]?.body.expectedSequence).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
