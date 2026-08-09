import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProviderConfig } from '../../../../src/provider/configuration/config.ts';
import { initializeCapacityProviderIdentity } from '../../../../src/provider/accounts/identity.ts';
import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { recoverMultiTeamProviderRunners, runMultiTeamProviderManager, runMultiTeamProviderRunners } from '../../../../src/provider/teams/multi-team-runtime.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((entry) => entry())));

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

async function teamService(teamId: string) {
	const state = { polls: 0, returns: 0, revoked: false, tokenOutage: false, assignment: null as Record<string, unknown> | null };
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const path = request.url ?? '';
		if (path === '/v1/provider/access-tokens') {
			if (state.tokenOutage) return json(response, 503, { error: 'token service unavailable' });
			return json(response, 201, { ok: true, payload: { id: `refreshed-${teamId}`, teamId, providerId: 'provider-shared', membershipId: `membership-${teamId}`, credentialId: `credential-${teamId}`, status: 'active', scopes: ['provider:assignments:read'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: `refreshed-access-${teamId}`, identityVersion: 1 } });
		}
		if (state.revoked && path.includes('/availability-sessions')) return json(response, 401, { error: 'membership revoked' });
		if (path.includes('/availability-sessions')) return json(response, 200, { ok: true, payload: { id: `session-${teamId}`, membershipId: `membership-${teamId}`, teamId, providerId: 'provider-shared', status: 'open', sequence: 1 } });
		if (path === '/v1/provider/assignments/next') {
			state.polls += 1;
			if (!state.assignment) return json(response, 200, { ok: true, payload: null });
			const assignment = state.assignment;
			state.assignment = null;
			return json(response, 200, { ok: true, payload: assignment, leaseToken: `lease-${teamId}`, leaseSeconds: 300 });
		}
		if (path.endsWith('/renew')) return json(response, 200, { ok: true, payload: { status: 'leased' } });
		if (path.endsWith('/mode-runs')) return json(response, 200, { ok: true, payload: {} });
		if (request.method === 'GET' && path.includes('/v1/provider/assignments/')) return json(response, 200, { ok: true, payload: { id: path.split('/').pop(), status: 'leased' } });
		if (path.endsWith('/return')) {
			state.returns += 1;
			return json(response, 200, { ok: true, payload: { status: 'queued' } });
		}
		return json(response, 404, { error: `Unhandled ${request.method} ${path}` });
	});
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port.');
	cleanup.push(() => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())));
	return { url: `http://127.0.0.1:${address.port}`, state };
}

describe('multi-team provider local service workflow', () => {
	it('weights team polls, survives dispatch restart, and blocks revoked-team work', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-provider-service-'));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const teamA = await teamService('team-a');
		const teamB = await teamService('team-b');
		const dataDirectory = resolve(root, 'data');
		await initializeCapacityProviderIdentity({ ref: 'data://identity.jwk', baseDirectory: root, dataDirectory });
		await mkdir(resolve(dataDirectory, 'secrets'), { recursive: true });
		await writeFile(resolve(dataDirectory, 'secrets/team-a.credential'), 'team-a-secret\n', { mode: 0o600 });
		await writeFile(resolve(dataDirectory, 'secrets/team-b.credential'), 'team-b-secret\n', { mode: 0o600 });
		const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
		await writeFile(manifestPath, [
			'schemaVersion: 2', 'providerClass: agent', 'ownership:', '  type: external',
			'configuration:', '  generation: multi-team-service-test-v1', 'supplyCeilings:', '  maxConcurrentAssignments: 1',
			'identity:', '  privateKeyRef: data://identity.jwk', '  displayName: Service Provider',
			'executionProviders:', '  - id: codex', '    adapter: codex', '    nativeLimits: { maxConcurrentRunners: 1 }',
			'connections:',
			'  - id: team-a', `    marketUrl: ${teamA.url}`, '    teamId: team-a', '    providerId: provider-shared', '    membershipId: membership-team-a', '    membershipCredentialRef: data://secrets/team-a.credential', '    membershipCredentialId: credential-team-a', '    offer: { weight: 3, maxConcurrentRunners: 1, capabilities: [research] }',
			'  - id: team-b', `    marketUrl: ${teamB.url}`, '    teamId: team-b', '    providerId: provider-shared', '    membershipId: membership-team-b', '    membershipCredentialRef: data://secrets/team-b.credential', '    membershipCredentialId: credential-team-b', '    offer: { weight: 1, maxConcurrentRunners: 1, capabilities: [research] }',
		].join('\n'));
		const localState = new ProviderLocalCapacityStore(dataDirectory);
		const token = (teamId: string) => ({ id: `token-${teamId}`, teamId, providerId: 'provider-shared', membershipId: `membership-${teamId}`, credentialId: `credential-${teamId}`, status: 'active' as const, scopes: ['provider:assignments:read' as const], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), accessToken: `access-${teamId}`, identityVersion: 1 });
		await localState.saveToken('team-a', token('team-a'));
		await localState.saveToken('team-b', token('team-b'));
		const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: dataDirectory, TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath, TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS: '1', HOME: root } });

		for (let cycle = 0; cycle < 8; cycle += 1) await runMultiTeamProviderManager(config);
		expect([teamA.state.polls, teamB.state.polls]).toEqual([6, 2]);

		teamA.state.assignment = { id: 'assignment-a', membershipId: 'membership-team-a', stateVersion: 1, projectId: 'project-a', agentId: 'researcher', mode: 'planning', executionProviderId: 'codex', decisionInput: { input: {} }, capacityEnvelope: { projectId: 'project-a', mode: 'planning', reservedCredits: 1 } };
		await runMultiTeamProviderManager(config);
		expect((await new ProviderLocalCapacityStore(dataDirectory).snapshot()).claims).toEqual([expect.objectContaining({ connectionId: 'team-a', status: 'ready', assignmentId: 'assignment-a' })]);
		const pollsBeforeRunner = teamA.state.polls + teamB.state.polls;
		const runner = await runMultiTeamProviderRunners(config);
		expect(runner).toMatchObject({ ok: true, dispatched: 1 });
		expect(teamA.state.polls + teamB.state.polls).toBe(pollsBeforeRunner);
		expect(teamA.state.returns).toBe(1);
		expect((await localState.snapshot()).events).toEqual(expect.arrayContaining([expect.objectContaining({ assignmentId: 'assignment-a', outcome: 'assignment-lifecycle-confirmed' })]));

		const recoveryClaim = await localState.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
		if (!recoveryClaim) throw new Error('Expected a restart-recovery claim fixture.');
		await localState.attachLease(recoveryClaim.id, { assignmentId: 'recovery-assignment', leaseToken: 'recovery-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: {} });
		await localState.claimDispatch(['team-a']);
		expect(await recoverMultiTeamProviderRunners(config)).toEqual([expect.objectContaining({ assignmentId: 'recovery-assignment', status: 'returned' })]);
		expect(teamA.state.returns).toBe(2);

		await localState.saveToken('team-a', { ...token('team-a'), expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() });
		teamA.state.tokenOutage = true;
		await runMultiTeamProviderManager(config);
		expect(await localState.schedulableConnections()).toEqual(['team-b']);
		teamA.state.tokenOutage = false;
		await runMultiTeamProviderManager(config);
		expect(await localState.schedulableConnections()).toEqual(['team-a', 'team-b']);

		teamB.state.revoked = true;
		await runMultiTeamProviderManager(config);
		expect(await localState.schedulableConnections()).toEqual(['team-a']);
		const revokedClaim = await localState.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 });
		if (!revokedClaim) throw new Error('Expected a revoked-team claim fixture.');
		await localState.attachLease(revokedClaim.id, { assignmentId: 'assignment-b', leaseToken: 'lease-b', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEnvelope: { ok: true, payload: { id: 'assignment-b' }, leaseToken: 'lease-b' } });
		expect(await runMultiTeamProviderRunners(config)).toMatchObject({ dispatched: 0 });
		expect((await localState.snapshot()).claims).toEqual([expect.objectContaining({ connectionId: 'team-b', status: 'ready' })]);
	}, 30_000);
});
