import type { ProviderConnectionRuntime } from './coordinator.ts';
import { createProviderControlPlaneClient } from './client.ts';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { ProviderLocalCapacityStore, type ProviderLocalSlotClaim } from '../capacity/capacity-core/local-capacity-store.ts';
import { providerFailureSummary } from '../../sandbox/provider-failure.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';
import type { AssignmentAttempt } from '@treeseed/sdk/agent-capacity';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Lifecycle timestamps may advance; every issued authority field stays frozen. */
function sameAttemptAuthority(current: AssignmentAttempt, frozen: AssignmentAttempt, assignment: Record<string, unknown>): boolean {
  if (current.startedAt !== frozen.startedAt) {
    const window = record(record(assignment.metadata).executionWindow);
    if (frozen.startedAt !== undefined || current.startedAt === undefined || current.startedAt !== window.startedAt
      || Date.parse(current.startedAt) < Date.parse(frozen.createdAt) || Date.parse(current.startedAt) > Date.parse(frozen.deadline)
      || !isDeepStrictEqual(window.executionRef, { nodeId: frozen.nodeId, nodeRevision: frozen.nodeRevision,
        graphRevision: frozen.graphRevision, attempt: frozen.attempt })) return false;
  }
  return isDeepStrictEqual({ ...current, status: frozen.status, startedAt: frozen.startedAt, finishedAt: frozen.finishedAt },
    { ...frozen, startedAt: frozen.startedAt, finishedAt: frozen.finishedAt });
}

/** The original authenticated assignment read exposes the sole operator audit.
 * This never authorizes a measured charge or modifies the frozen attempt. */
export function isUnresolvedUsageRecovery(observed: unknown, frozen: AssignmentAttempt): boolean {
  const assignment = record(observed), audit = record(assignment.unresolvedUsageRecovery);
  const current = assignmentAttemptSchema.safeParse(assignment.assignmentAttempt);
  const keys = ['assignmentId', 'reservationId', 'usageStatus', 'settled', 'expectedStateVersion', 'actorId', 'reason', 'recoveredAt'];
  return current.success && ['expired', 'failed', 'cancelled'].includes(textStatus(assignment.status))
    && current.data.status === assignment.status
    && sameAttemptAuthority(current.data, frozen, assignment)
    && assignment.id === frozen.id && assignment.teamId === frozen.teamId && assignment.capacityProviderId === frozen.provider.providerId
    && Object.keys(audit).length === keys.length && keys.every(key => Object.hasOwn(audit, key))
    && audit.assignmentId === frozen.id && audit.reservationId === frozen.reservationId
    && audit.usageStatus === 'unresolved' && audit.settled === false
    && Number.isSafeInteger(audit.expectedStateVersion) && Number(audit.expectedStateVersion) > 0
    && audit.expectedStateVersion === assignment.stateVersion
    && ['actorId', 'reason'].every(key => typeof audit[key] === 'string' && String(audit[key]).trim().length > 0)
    && typeof audit.recoveredAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(audit.recoveredAt) && Number.isFinite(Date.parse(audit.recoveredAt));
}

/** API disposition generation is not itself a usage acknowledgment. Transfer
 * only the exact retained, physically closed measured output to API custody;
 * the canonical cancelled/failed result remains unsuccessful. */
function closedMeasuredResult(claim: ProviderLocalSlotClaim, frozen: AssignmentAttempt) {
  if (!claim.closeoutOutput) return null;
  const output = claim.closeoutOutput, teardown = record(output.teardown);
  const start = Date.parse(claim.activeStartedAt ?? ''), finish = Date.parse(claim.activeFinishedAt ?? ''), closed = Date.parse(String(teardown.completedAt ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(finish) || !Number.isFinite(closed) || start > finish || finish > closed || closed > Date.now()
    || claim.accountedThrough !== claim.activeFinishedAt || teardown.verified !== true || typeof output.sandboxId !== 'string' || !output.sandboxId) return null;
  const parsed = assignmentResultSchema.safeParse(output.assignmentResult);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, output.assignmentResult) || parsed.data.assignmentId !== frozen.id) return null;
  const usage = parsed.data.usage, native = record(usage.native);
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!positive(native.activeSeconds) || !positive(native.elapsedSeconds) || native.activeSeconds > native.elapsedSeconds
    || Math.ceil(native.elapsedSeconds) !== usage.elapsedSeconds) return null;
  return { result: parsed.data, activeSeconds: native.activeSeconds };
}

function acknowledgesMeasuredCloseout(assignment: Record<string, unknown>, claim: ProviderLocalSlotClaim, frozen: AssignmentAttempt): boolean {
  if (!['failed', 'cancelled', 'expired'].includes(textStatus(assignment.status)) || assignment.leaseState !== 'released'
    || assignment.reservationId !== frozen.reservationId || assignment.assignmentResult != null || !claim.closeoutOutput) return false;
  const lifecycle = record(assignment.lifecycleOutput), { performance: _performance, ...acknowledged } = lifecycle;
  // This never makes the original completed model response a canonical result.
  if (!Object.hasOwn(claim.closeoutOutput, 'completion') && acknowledged.completion === null) delete acknowledged.completion;
  if (!isDeepStrictEqual(acknowledged, claim.closeoutOutput)) return false;
  const parsed = closedMeasuredResult(claim, frozen);
  if (!parsed) return false;
  const usage = parsed.result.usage, native = record(usage.native);
  const performance = record(lifecycle.performance), actual = record(performance.actual);
  if (performance.assignmentId !== frozen.id || performance.teamId !== frozen.teamId || performance.projectId !== frozen.projectId
    || performance.workdayId !== frozen.workdayId || performance.capacityProviderId !== frozen.provider.providerId
    || performance.disposition !== 'failed' || actual.attempts !== frozen.attempt) return false;
  const expected = { activeSeconds: Math.ceil(parsed.activeSeconds), elapsedSeconds: usage.elapsedSeconds,
    inputTokens: usage.modelInputTokens ?? 0, outputTokens: usage.modelOutputTokens ?? 0,
    cachedInputTokens: native.cachedInputTokens ?? 0, reasoningTokens: native.reasoningTokens ?? 0 };
  return Object.entries(expected).every(([key, value]) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && actual[key] === value);
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
      // The API retains the lease record while its canonical attempt executes.
      // Accept that lifecycle only with the original, exact issued start window.
      const window = record(record(assignment.metadata).executionWindow);
      const startedLease = status === 'leased' && assignment.leaseState === 'leased' && current.status === 'running'
        && current.startedAt !== undefined && current.startedAt === window.startedAt
        && isDeepStrictEqual(window.executionRef, { nodeId: current.nodeId, nodeRevision: current.nodeRevision,
          graphRevision: current.graphRevision, attempt: current.attempt });
      if (connection.teamId === frozen.teamId && connection.providerId === frozen.provider.providerId
        && isUnresolvedUsageRecovery(assignment, frozen)) {
        await store.retainUnresolvedUsage(claim.id);
        results.push({ claimId: claim.id, assignmentId: claim.assignmentId, status: 'released', observedStatus: status,
          usageStatus: 'unresolved', settled: false });
        continue;
      }
      if (assignment.id !== claim.assignmentId || assignment.teamId !== frozen.teamId
        || assignment.capacityProviderId !== frozen.provider.providerId || connection.teamId !== frozen.teamId
        || connection.providerId !== frozen.provider.providerId
        || !(current.status === status || startedLease)
        || !(sameAttemptAuthority(current, frozen, assignment)
        && (!['leased', 'running'].includes(status) || current.finishedAt === frozen.finishedAt))
        || !['leased', 'running', 'completed', 'failed', 'returned', 'cancelled', 'expired', 'responded', 'abstained'].includes(status)) {
        throw new Error('Provider recovery assignment authority does not match its retained lease.');
      }
      const recovery = record(record(assignment.metadata).leaseRecovery);
      if (recovery.disposition === 'operator-action') {
        if (assignment.unresolvedUsageRecovery !== undefined) throw new Error('Original operator unresolved recovery audit is invalid.');
        let acknowledged = assignment;
        if (!acknowledgesMeasuredCloseout(assignment, claim, frozen)) {
          if (status !== 'expired' || assignment.leaseState !== 'expired'
            || recovery.reasonCode !== 'expired_lease_settlement_without_success_evidence'
            || !claim.runnerId || recovery.priorRunnerId !== claim.runnerId || !closedMeasuredResult(claim, frozen))
            throw new Error('Original measured expired closeout authority is unavailable.');
          const response = record(await client.failAssignment(claim.assignmentId, { leaseToken: claim.leaseToken,
            runnerId: claim.runnerId, code: 'assignment_timeout', retryable: false, output: claim.closeoutOutput }));
          acknowledged = record(response.assignment);
          const acknowledgedAttempt = assignmentAttemptSchema.safeParse(acknowledged.assignmentAttempt);
          if (!acknowledgedAttempt.success || !isDeepStrictEqual(acknowledgedAttempt.data, current)
            || acknowledged.id !== assignment.id || acknowledged.teamId !== assignment.teamId
            || acknowledged.capacityProviderId !== assignment.capacityProviderId || acknowledged.status !== status
            || !isDeepStrictEqual(acknowledged.metadata, assignment.metadata))
            throw new Error('Expired closeout acknowledgement changed original authority.');
        }
        if (!acknowledgesMeasuredCloseout(acknowledged, claim, frozen)) throw new Error('API has not acknowledged original measured failed output.');
      } else if (assignment.unresolvedUsageRecovery !== undefined) throw new Error('Original operator unresolved recovery audit is invalid.');
      // A generated disposition alone cannot discard provider evidence. Exact
      // measured output already durably acknowledged by API is distinct from
      // synthesized unknown usage, which still requires the operator audit.
      if (!['leased', 'running'].includes(status)
        && record(record(record(assignment.lifecycleOutput).performance).systemAssessment).generatedBy === 'api-recovery'
        && !acknowledgesMeasuredCloseout(assignment, claim, frozen)) {
        throw new Error('Synthesized recovery performance does not acknowledge measured usage custody.');
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
