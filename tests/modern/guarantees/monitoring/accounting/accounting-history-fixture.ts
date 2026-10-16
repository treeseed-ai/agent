import { assignmentAttemptSchema, usageSettlementSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../../kernel/provider-kernel-fixture.ts';
export type Row = Record<string, any>;
/** Controlled public rows, not generated usage, admission or managed evidence. */
export function accountingHistoryFixture() {
 const original = request().assignment.assignmentAttempt;
 if (!original) throw new Error('Original controlled canonical attempt required');
 const attempt = assignmentAttemptSchema.parse({ ...original, status: 'created' }), at = (seconds: number) => new Date(Date.parse(attempt.createdAt) + seconds * 1000).toISOString();
 const run = { id: attempt.workdayId, teamId: attempt.teamId, startedAt: attempt.createdAt, status: 'running', executionMode: 'simulation' };
 const item = { id: attempt.id, teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId, membershipId: 'membership',
  reservationId: attempt.reservationId, status: 'pending', assignmentAttempt: attempt };
 const reservation = { id: attempt.reservationId, idempotencyKey: attempt.idempotencyKey, membershipId: item.membershipId, grantId: null,
  capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId, laneId: 'workday', policySnapshot: {},
  projectAgentClassId: 'configured-class', assignmentId: attempt.id, mode: 'acting', teamId: attempt.teamId, projectId: attempt.projectId,
  workDayId: attempt.workdayId, taskId: null, state: 'reserved', requestedSeconds: attempt.limits.maximumSeconds, reservedSeconds: attempt.limits.maximumSeconds,
  activeSeconds: 0, elapsedSeconds: 0, releasedSeconds: 0, overrunSeconds: 0, nativeUnit: null, reservedNativeAmount: null, consumedNativeAmount: null,
  reservedProviderUnits: null, consumedProviderUnits: null, reservedUsd: null, consumedUsd: null, expiresAt: attempt.deadline, metadata: {}, createdAt: attempt.createdAt, updatedAt: attempt.createdAt };
 const supply = (terminal: boolean) => ['model-day', 'capability-day'].map((scope, index) => ({ id: 'controlled-supply-' + index, teamId: attempt.teamId, scope,
  scopeId: JSON.stringify([attempt.provider.providerId, attempt.provider.modelConfigurationId, ...(scope === 'capability-day' ? [attempt.provider.executionCapabilityId] : [])]),
  periodKey: attempt.createdAt.slice(0, 10), hardLimit: 100, committedAmount: terminal ? 2 : attempt.limits.maximumSeconds, stateVersion: terminal ? 3 : 2,
  reservedAmount: attempt.limits.maximumSeconds, releasedAmount: terminal ? attempt.limits.maximumSeconds - 2 : 0, releasePolicy: 'actual-settlement',
  remainingAmount: 100 - (terminal ? 2 : attempt.limits.maximumSeconds) }));
 const measurement = (aggregate: boolean) => ({ id: aggregate ? 'aggregate-usage' : 'checkpoint-usage', idempotencyKey: aggregate ? 'aggregate-key' : 'checkpoint-key',
  taskId: null, workDayId: attempt.workdayId, projectId: attempt.projectId, taskSignature: 'configured:acting', executionProfileId: 'configured-profile',
  assignmentId: attempt.id, assignmentAttempt: attempt.attempt, usageDimension: aggregate ? 'aggregate' : 'checkpoint', accountingMode: aggregate ? 'aggregate' : 'incremental',
  mode: 'acting', capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId, laneId: 'workday', businessModel: 'controlled-input',
  modelName: attempt.provider.modelConfigurationId, inputTokens: aggregate ? 7 : 3, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null,
  quotaMinutes: null, wallMinutes: null, filesOpened: null, filesChanged: null, diffLinesAdded: null, diffLinesRemoved: null, testRuns: null, retryCount: null,
  activeSeconds: aggregate ? 2 : 1, elapsedSeconds: aggregate ? 3 : 1, actualUsd: null, nativeUsage: { activeSeconds: aggregate ? 2 : 1, tokens: aggregate ? 7 : 3 },
  metadata: {}, createdAt: at(aggregate ? 3 : 1) });
 const usage = [measurement(false), measurement(true)], ledger = [{ id: 'terminal-ledger', settlementKey: 'terminal-key', membershipId: item.membershipId,
  capacityProviderId: attempt.provider.providerId, reservationId: attempt.reservationId, assignmentId: attempt.id, mode: 'acting', teamId: attempt.teamId,
  projectId: attempt.projectId, workDayId: attempt.workdayId, taskId: null, phase: 'task_completed_actual_settlement', activeSeconds: 2, elapsedSeconds: 3,
  providerUnits: null, usd: null, source: 'controlled-input', metadata: {}, createdAt: at(3), usageSettlement: usageSettlementSchema.parse({
   schemaVersion: 'treeseed.usage-settlement/v1', id: 'terminal-ledger', idempotencyKey: 'terminal-key', assignmentId: attempt.id, reservationId: attempt.reservationId,
   workdayId: attempt.workdayId, teamId: attempt.teamId, projectId: attempt.projectId, agentClass: attempt.agentClass, providerId: attempt.provider.providerId,
   actualSeconds: 2, nativeUsage: usage[1]!.nativeUsage, settledAt: at(3) }) }];
 const terminal = { ...reservation, state: 'consumed', activeSeconds: 2, elapsedSeconds: 3, releasedSeconds: attempt.limits.maximumSeconds - 2, updatedAt: at(3) };
 const events = [0, 1, 2].map(index => ({ id: 'controlled-accounting-' + index, runId: run.id, workdayId: run.id, teamId: run.teamId, projectId: item.projectId,
  assignmentId: item.id, eventIndex: index, eventType: 'capacity.accounting.updated', status: 'recorded', title: 'Capacity accounting updated', message: null,
  parameters: {}, metadata: {}, refs: {}, createdAt: at(index === 2 ? 3 : index), context: { reservation: index === 2 ? terminal : { ...reservation, updatedAt: at(index) },
   usageActual: index ? usage[index - 1] : null, ledgerEntry: index === 2 ? ledger[0] : null, remainingSupply: supply(index === 2) } }));
 return { run: structuredClone(run), items: [structuredClone(item)], usage: structuredClone(usage), ledger: structuredClone(ledger), events: structuredClone(events) };
}
