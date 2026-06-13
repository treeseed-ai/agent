import type { CapacityProviderRegistrationRequest } from '@treeseed/sdk/capacity-provider';
import { discoverProviderBudgets } from './budgets.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { createProviderMarketClient } from './client.ts';
import { providerRuntimeVersion, type ProviderRuntimeConfig } from './config.ts';

export function buildProviderRegistrationRequest(config: ProviderRuntimeConfig): CapacityProviderRegistrationRequest {
	const request: CapacityProviderRegistrationRequest = {
		runtime: {
			package: '@treeseed/agent',
			version: providerRuntimeVersion(),
			entrypoint: 'packages/agent/dist/provider/entrypoint.js',
			roles: ['api', 'manager', 'runner'],
		},
		capabilities: discoverProviderCapabilities(config),
		budgets: discoverProviderBudgets(config),
		health: {
			dataDirWritable: true,
			codexReady: Boolean(config.codexAuthFile || config.codexAuthJsonB64),
		},
	};
	if (config.marketId) {
		request.marketId = config.marketId;
	}
	return request;
}

export async function registerProvider(config: ProviderRuntimeConfig) {
	return createProviderMarketClient(config).register(buildProviderRegistrationRequest(config));
}
