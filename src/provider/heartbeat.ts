import { createProviderMarketClient } from './client.ts';
import type { ProviderRuntimeConfig } from './config.ts';
import { buildProviderRegistrationRequest } from './registration.ts';

export async function runProviderHeartbeatOnce(config: ProviderRuntimeConfig) {
	const request = buildProviderRegistrationRequest(config);
	return createProviderMarketClient(config).heartbeat({
		runtime: request.runtime,
		capabilities: request.capabilities,
		budgets: request.budgets,
		health: request.health,
		status: 'online',
		connectionState: 'connected',
	});
}

export function startProviderHeartbeatLoop(config: ProviderRuntimeConfig, intervalSeconds = 30) {
	const timer = setInterval(() => {
		void runProviderHeartbeatOnce(config).catch((error) => {
			process.stderr.write(`${JSON.stringify({
				ok: false,
				event: 'capacity-provider.heartbeat_failed',
				error: error instanceof Error ? error.message : String(error),
			})}\n`);
		});
	}, Math.max(5, intervalSeconds) * 1000);
	return () => clearInterval(timer);
}
