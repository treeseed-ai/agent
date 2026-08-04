import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderConnectionRuntimeContext } from '../configuration/config.ts';

// Assignment acquisition performs API-owned synthesis before a lease can be
// returned. Keep the provider transport deadline comfortably beyond the
// control plane's 30-second synthesis/TreeDX request windows so a successful
// lease response cannot be abandoned at the boundary.
export const PROVIDER_MARKET_REQUEST_TIMEOUT_MS = 120_000;
export const PROVIDER_ASSIGNMENT_POLLING_TTL_MS = PROVIDER_MARKET_REQUEST_TIMEOUT_MS + 30_000;

export function createProviderMarketClient(config: ProviderConnectionRuntimeContext) {
	return new ProviderProtocolClient({
		marketUrl: config.marketUrl,
		accessToken: config.accessToken,
		accessTokenProvider: config.accessTokenProvider,
		userAgent: `@treeseed/agent capacity-provider/${process.env.TREESEED_PROVIDER_RUNTIME_VERSION ?? '0.9.0'}`,
		requestTimeoutMs: PROVIDER_MARKET_REQUEST_TIMEOUT_MS,
	});
}
