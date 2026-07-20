import type { ProviderConnectionRuntime } from './coordinator.ts';
import { createProviderMarketClient } from './client.ts';
import type { ProviderHostRuntimeConfig } from './config.ts';
import { ProviderLocalCapacityStore } from './local-capacity-store.ts';

interface ProviderLeaseRecoveryClient {
	assignment(assignmentId: string): Promise<unknown>;
	returnAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function recoverProviderLocalLeases(input: {
	config: ProviderHostRuntimeConfig;
	connections: ProviderConnectionRuntime[];
	store?: ProviderLocalCapacityStore;
	clientFactory?: (config: Parameters<typeof createProviderMarketClient>[0]) => ProviderLeaseRecoveryClient;
}) {
	const store = input.store ?? new ProviderLocalCapacityStore(input.config.dataDir);
	const clientFactory = input.clientFactory ?? createProviderMarketClient;
	const claims = await store.claimsForRecovery();
	const results: Array<Record<string, unknown>> = [];
	for (const claim of claims) {
		const connection = input.connections.find((entry) => entry.connection.id === claim.connectionId);
		if (!connection || !claim.assignmentId || !claim.leaseToken) {
			await store.recordFailure(claim.id, 'Connection or lease identity is unavailable during recovery.');
			results.push({ claimId: claim.id, status: 'retained', reason: 'connection_or_lease_identity_unavailable' });
			continue;
		}
		const runtimeConfig = {
			...input.config, connectionId: connection.connection.id, marketUrl: connection.marketUrl, marketAudience: connection.marketAudience,
			teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId, accessToken: connection.accessToken.accessToken,
		};
		try {
			const client = clientFactory(runtimeConfig);
			const observed = record(await client.assignment(claim.assignmentId));
			const assignment = record(observed.payload ?? observed.assignment ?? observed);
			const status = String(assignment.status ?? '');
			if (status === 'leased') {
				await client.returnAssignment(claim.assignmentId, {
					leaseToken: claim.leaseToken, runnerId: claim.runnerId,
					reason: 'Provider runner restarted before the prior lease completed.', code: 'provider_restart_recovery',
				});
			}
			await store.finalize(claim.id, status === 'leased' ? 'restart-return-confirmed' : `authoritative-${status || 'unknown'}`);
			results.push({ claimId: claim.id, assignmentId: claim.assignmentId, status: status === 'leased' ? 'returned' : 'released', observedStatus: status });
		} catch (error) {
			await store.recordFailure(claim.id, error instanceof Error ? error.message : String(error));
			results.push({ claimId: claim.id, assignmentId: claim.assignmentId, status: 'retained', reason: 'control_plane_unavailable', error: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}
