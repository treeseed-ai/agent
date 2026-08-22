import type { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutor, AgentExecutionResult } from '../execution/contracts.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
}

export interface ProviderAssignmentRunInput {
  client: Pick<ProviderProtocolClient, 'startAssignmentExecution' | 'startAssignmentCloseout' | 'preflightAssignmentCompletion' | 'completeAssignment' | 'returnAssignment' | 'failAssignment' | 'reportAssignmentUsage'>;
  executor: AgentExecutor;
  assignment: Record<string, unknown>;
  leaseToken: string;
  runnerId: string;
  signal?: AbortSignal;
}

async function reportUsage(input: ProviderAssignmentRunInput, assignmentId: string, result: AgentExecutionResult) {
  for (const [index, usage] of (result.usage ?? []).entries()) {
    await input.client.reportAssignmentUsage(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, ...usage }, `usage:${assignmentId}:${input.runnerId}:${index}`);
  }
}

export async function runProviderAssignment(input: ProviderAssignmentRunInput) {
  const assignmentId = text(input.assignment.id);
  if (!assignmentId) throw new Error('Catalogued assignment lease omitted its stable id.');
  await input.client.startAssignmentExecution(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, executorId: input.executor.id });
  let result: AgentExecutionResult;
  try {
    result = await input.executor.execute({ assignment: input.assignment, assignmentId, leaseToken: input.leaseToken, runnerId: input.runnerId, signal: input.signal });
  } catch (error) {
    result = { status: 'failed', code: 'agent_executor_failed', summary: error instanceof Error ? error.message : String(error), retryable: true };
  }
  await reportUsage(input, assignmentId, result);
  if (result.status === 'returned') {
    return input.client.returnAssignment(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, code: result.code ?? 'agent_executor_returned', reason: result.summary, retryable: result.retryable ?? true });
  }
  if (result.status === 'failed') {
    return input.client.failAssignment(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, code: result.code ?? 'agent_executor_failed', message: result.summary, retryable: result.retryable ?? false });
  }
  await input.client.startAssignmentCloseout(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId });
  const completion = {
    leaseToken: input.leaseToken,
    runnerId: input.runnerId,
    summary: { text: result.summary },
    output: { ...record(result.outputs), artifacts: result.artifacts ?? [] },
  };
  await input.client.preflightAssignmentCompletion(assignmentId, completion);
  return input.client.completeAssignment(assignmentId, completion);
}
