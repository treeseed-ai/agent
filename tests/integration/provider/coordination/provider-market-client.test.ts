import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createProviderMarketClient,
	PROVIDER_ASSIGNMENT_POLLING_TTL_MS,
	PROVIDER_MARKET_REQUEST_TIMEOUT_MS,
} from '../../../../src/provider/coordination/client.ts';
import type { ProviderConnectionRuntimeContext } from '../../../../src/provider/configuration/config.ts';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('provider Market client', () => {
	it('keeps the provider-local polling claim alive beyond the Market request deadline', () => {
		expect(PROVIDER_ASSIGNMENT_POLLING_TTL_MS).toBeGreaterThan(PROVIDER_MARKET_REQUEST_TIMEOUT_MS);
	});

	it('keeps assignment acquisition open beyond the control-plane synthesis window', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30_001));
			return new Response(JSON.stringify({ ok: true, payload: null }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}));
		const client = createProviderMarketClient({
			marketUrl: 'https://market.test',
			accessToken: 'provider-token',
		} as ProviderConnectionRuntimeContext);

		const request = client.nextAssignment();
		await vi.advanceTimersByTimeAsync(30_001);

		await expect(request).resolves.toMatchObject({ ok: true, payload: null });
		expect(PROVIDER_MARKET_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_001);
	});
});
