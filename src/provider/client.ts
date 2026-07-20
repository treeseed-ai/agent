import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderConnectionRuntimeContext } from './config.ts';

export function createProviderMarketClient(config: ProviderConnectionRuntimeContext) {
	return new ProviderProtocolClient({
		marketUrl: config.marketUrl,
		accessToken: config.accessToken,
		userAgent: `@treeseed/agent capacity-provider/${process.env.TREESEED_PROVIDER_RUNTIME_VERSION ?? '0.9.0'}`,
		requestTimeoutMs: 30_000,
	});
}
