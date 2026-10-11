import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { verifyCampaignWorkdayPolicy } from '../../../acceptance/freeze-integrity.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';

it('native public workday policy reads reject foreign moved malformed and denied authority without rewriting frozen inputs before exact retry', async () => {
	const manifest = campaignInputs(['sdk']), teamId = 'native-policy-team';
	const profile = { ...manifest.workdayPolicy, teamId }, held = structuredClone({ manifest, profile });
	const requests: Array<{ method?: string; path?: string; body: string }> = [], failures: Array<{ mode: string; error: string }> = [];
	let mode = 'exact';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			requests.push({ method: request.method, path: request.url, body }); response.setHeader('content-type', 'application/json');
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'denied' || mode === 'unavailable') {
				const status = mode === 'denied' ? 403 : 503;
				response.writeHead(status).end(JSON.stringify({ status, code: 'controlled_policy_denied', title: 'Retained native denial' })); return;
			}
			if (mode === 'json') { response.end('{'); return; }
			const observed = structuredClone(profile);
			if (mode === 'team') observed.teamId = 'foreign-team';
			if (mode === 'revision') observed.revision++;
			if (mode === 'id') Reflect.set(observed, 'id', 'foreign');
			if (mode === 'missing-team') Reflect.deleteProperty(observed, 'teamId');
			if (mode === 'missing-policy') Reflect.deleteProperty(observed, 'policy');
			if (mode === 'defaults') Reflect.deleteProperty(observed.policy, 'durationSeconds');
			if (mode === 'unknown') Reflect.set(observed, 'compatibilityPolicy', true);
			if (mode === 'policy') observed.policy.maximumConcurrency++;
			response.end(JSON.stringify({ data: observed }));
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native policy listener required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }),
			accessToken: 'controlled-native-policy-input' });
		const observe = async () => {
			const observed = await client.invoke(controlPlaneOperation('workdays.profiles.show'), {
				path: { teamId, profileId: 'default' }, query: {}, body: undefined,
			});
			return verifyCampaignWorkdayPolicy(manifest, observed.data, teamId);
		};
		expect(await Promise.all([observe(), observe()])).toEqual([profile, profile]);
		for (const fault of ['team', 'revision', 'id', 'missing-team', 'missing-policy', 'defaults', 'unknown', 'policy',
			'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault;
			try { await observe(); failures.push({ mode, error: 'unexpected pass' }); }
			catch (failure) { failures.push({ mode, error: failure instanceof Error ? failure.message : 'Native policy failure' }); }
		}
		expect(failures).toHaveLength(12); expect(failures.every(value => value.error !== 'unexpected pass')).toBe(true);
		const retained = structuredClone(failures); mode = 'exact'; expect(await observe()).toEqual(profile);
		expect(failures).toEqual(retained); expect({ manifest, profile }).toEqual(held);
		expect(requests).toHaveLength(15);
		for (const request of requests) expect(request).toEqual({ method: 'GET', path: `/v1/teams/${teamId}/workday-profiles/default`, body: '' });
		// Actual SDK and native HTTP reach the same assertion used by preflight;
		// the upstream profile is controlled input, not current API producer authority.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
