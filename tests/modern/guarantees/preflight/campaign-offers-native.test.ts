import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { verifyCampaignProviderOffer } from '../../../acceptance/workday/support/preflight/campaign-provider-offers.ts';
import { campaignOffers } from './campaign-offers-fixture.ts';

it('native owning provider offers and public SDK reads retain exact frozen revision configuration denial and interruption observations before unchanged concurrent retry', async () => {
	const f = campaignOffers(), held = structuredClone(f), requests: string[] = [], failed: Array<{ mode: string; error: unknown; observed: unknown }> = [];
	let mode = 'exact';
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
		if (mode === 'interrupted') { request.socket.destroy(); return; }
		if (mode === 'denied' || mode === 'unavailable') {
			const status = mode === 'denied' ? 403 : 503;
			response.writeHead(status).end(JSON.stringify({ status, code: 'controlled_offer_denied', title: 'Retained native denial' })); return;
		}
		if (mode === 'json') { response.end('{'); return; }
		const value = structuredClone(f.inventory);
		if (mode === 'revision') value.revision++;
		if (mode === 'provider') value.providerId = 'foreign';
		if (mode === 'omitted') value.offers.pop();
		if (mode === 'duplicate') value.offers.push(structuredClone(value.offers[0]!));
		if (mode === 'configuration') value.offers[0]!.offer.features.push('changed-native-configuration');
		if (mode === 'clock') value.offers[0]!.observedAt = 'invalid';
		response.end(JSON.stringify({ data: value }));
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native offer listener required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-offer-input' });
		const input = { path: { teamId: 'renamed-team', providerId: f.providerId }, query: {}, body: undefined }, originalInput = structuredClone(input);
		const observe = async () => {
			let observed: unknown;
			try {
				observed = (await client.invoke(controlPlaneOperation('providers.offers.show'), input)).data;
				return verifyCampaignProviderOffer(f.manifest, f.providerId, observed);
			} catch (error) { failed.push({ mode, error, observed: structuredClone(observed) }); throw error; }
		};
		expect(await Promise.all([observe(), observe()])).toEqual([f.inventory, f.inventory]);
		for (const fault of ['revision', 'provider', 'omitted', 'duplicate', 'configuration', 'clock', 'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault; await expect(observe(), fault).rejects.toThrow(); expect(f).toEqual(held); expect(input).toEqual(originalInput);
		}
		const originalFailures = [...failed]; mode = 'exact'; expect(await Promise.all([observe(), observe()])).toEqual([f.inventory, f.inventory]);
		expect(failed).toEqual(originalFailures); expect(failed).toHaveLength(10); expect(f).toEqual(held);
		expect(requests).toHaveLength(14); expect(requests.every(value => value === `GET /v1/teams/renamed-team/capacity-providers/${f.providerId}/offers`)).toBe(true);
		// The original owning manifest producer and SDK/native HTTP are real.
		// API inventory, credentials and revision are controlled; current runtime
		// supply, conformance signatures and a managed campaign are not proven here.
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
