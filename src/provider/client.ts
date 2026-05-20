import { MarketProviderClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderRuntimeConfig } from './config.ts';

export function createProviderMarketClient(config: ProviderRuntimeConfig) {
	return new MarketProviderClient({
		marketUrl: config.marketUrl,
		marketId: config.marketId,
		apiKey: config.apiKey,
		userAgent: `@treeseed/agent capacity-provider/${process.env.TREESEED_PROVIDER_RUNTIME_VERSION ?? '0.9.0'}`,
	});
}
