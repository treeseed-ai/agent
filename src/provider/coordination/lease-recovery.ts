import type { ProviderConnectionRuntime } from './coordinator.ts';
import { createProviderControlPlaneClient } from './client.ts';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { providerFailureSummary } from '../../sandbox/provider-failure.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';

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
      const frozen = assignmentAttemptSchema.parse(record(record(claim.dispatchEnvelope).assignment).assignmentAttempt);
      const current = assignmentAttemptSchema.parse(assignment.assignmentAttempt);
      if (assignment.id !== claim.assignmentId || assignment.teamId !== frozen.teamId
        || assignment.providerId !== frozen.provider.providerId || connection.teamId !== frozen.teamId
        || connection.providerId !== frozen.provider.providerId
        || !isDeepStrictEqual({ ...current, status: frozen.status }, frozen)
        || !['leased', 'running', 'completed', 'failed', 'returned', 'cancelled', 'expired', 'responded', 'abstained'].includes(status)) {
        throw new Error('Provider recovery assignment authority does not match its retained lease.');
      }
      if (status === 'leased' || status === 'running') {
        const response = record(await client.returnAssignment(claim.assignmentId, { leaseToken: claim.leaseToken, runnerId: claim.runnerId,
        ...(claim.closeoutOutput ? { output: claim.closeoutOutput } : {}),
        code: claim.failureMessage ? 'provider_runtime_recovery' : 'provider_restart_recovery',
        reason: claim.failureMessage ? `Provider runtime failed before durable completion: ${providerFailureSummary([{ type: 'error', message: claim.failureMessage }], [claim.leaseToken, connection.accessToken.accessToken])}` : 'Provider restarted before durable completion.' }));
        const returned = record(response.assignment);
        if (returned.id !== claim.assignmentId || returned.status !== 'returned') throw new Error('Provider recovery return receipt does not confirm the retained assignment.');
      }
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
