import type { ProviderConnectionRuntime } from './coordinator.ts';
import { createProviderControlPlaneClient } from './client.ts';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function recoverProviderLocalLeases(input: { config: ProviderHostRuntimeConfig; connections: ProviderConnectionRuntime[]; store?: ProviderLocalCapacityStore; includeRunning?: boolean }) {
  const store = input.store ?? new ProviderLocalCapacityStore(input.config.dataDir);
  const results: Record<string, unknown>[] = [];
  for (const claim of await store.claimsForRecovery(input.includeRunning !== false)) {
    if (!claim.assignmentId && !claim.leaseToken) {
      await store.finalize(claim.id, 'unleased-claim-released');
      results.push({ claimId: claim.id, status: 'released', reason: 'no_lease_acquired' });
      continue;
    }
    const connection = input.connections.find((entry) => entry.connection.id === claim.connectionId);
    if (!connection || !claim.assignmentId || !claim.leaseToken) {
      await store.recordFailure(claim.id, 'Connection or lease identity is unavailable during recovery.');
      results.push({ claimId: claim.id, status: 'retained', reason: 'lease_authority_unavailable' });
      continue;
    }
    try {
      const client = createProviderControlPlaneClient({
        controlPlaneUrl: connection.controlPlaneUrl,
        accessToken: connection.accessToken.accessToken,
      });
      const observed = record(await client.assignment(claim.assignmentId));
      const assignment = record(observed.data ?? observed.assignment ?? observed);
      const status = textStatus(assignment.status);
      if (status === 'leased' || status === 'running') await client.returnAssignment(claim.assignmentId, { leaseToken: claim.leaseToken, runnerId: claim.runnerId, code: 'provider_restart_recovery', reason: 'Provider restarted before durable completion.' });
      await store.finalize(claim.id, status === 'leased' || status === 'running' ? 'restart-return-confirmed' : `authoritative-${status || 'unknown'}`);
      results.push({ claimId: claim.id, assignmentId: claim.assignmentId, status: 'released', observedStatus: status });
    } catch (error) {
      await store.recordFailure(claim.id, error instanceof Error ? error.message : String(error));
      results.push({ claimId: claim.id, assignmentId: claim.assignmentId, status: 'retained', reason: 'control_plane_unavailable' });
    }
  }
  return results;
}

function textStatus(value: unknown) {
  return typeof value === 'string' ? value : '';
}
