import type { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutor, AgentExecutionResult, AssignmentTreeDxFacade } from '../execution/contracts.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executorAssignment(assignment: Record<string, unknown>) {
	const visible = { ...assignment };
	delete visible.treedxProxyHandle;
	if (visible.workspaceContext && typeof visible.workspaceContext === 'object' && !Array.isArray(visible.workspaceContext)) {
		const workspaceContext = { ...visible.workspaceContext as Record<string, unknown> };
		delete workspaceContext.treedxProxyHandle;
		visible.workspaceContext = workspaceContext;
	}
	return visible;
}

function text(...values: unknown[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
}

export interface ProviderAssignmentRunInput {
  client: Pick<ProviderProtocolClient, 'renewAssignment' | 'startAssignmentExecution' | 'startAssignmentCloseout' | 'preflightAssignmentCompletion' | 'completeAssignment' | 'returnAssignment' | 'failAssignment' | 'reportAssignmentUsage' | 'respondToAssignmentDiscussion' | 'settleAssignment'>;
  executor: AgentExecutor;
  assignment: Record<string, unknown>;
  leaseToken: string;
  runnerId: string;
  treeDx: AssignmentTreeDxFacade;
  leaseSeconds?: number;
  renewalIntervalMs?: number;
  onLeaseRenewed?: (leaseExpiresAt: string) => Promise<void>;
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
  let stopped = false;
  let renewalFailure: unknown = null;
	const executionAbort = new AbortController();
	const abortFromCaller = () => executionAbort.abort(input.signal?.reason);
	if (input.signal?.aborted) abortFromCaller();
	else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
	const treeDx: AssignmentTreeDxFacade = {
		...input.treeDx,
		invoke: (operationId, invocation, options = {}) => input.treeDx.invoke(operationId, invocation, {
			...options,
			signal: options.signal ? AbortSignal.any([executionAbort.signal, options.signal]) : executionAbort.signal,
		}),
	};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let renewalInFlight: Promise<void> | null = null;
  const scheduleRenewal = () => {
    timer = setTimeout(() => {
      renewalInFlight = renew();
    }, input.renewalIntervalMs ?? Math.max(30_000, (input.leaseSeconds ?? 300) * 500));
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const renewed = await input.client.renewAssignment(assignmentId, {
        leaseToken: input.leaseToken,
        runnerId: input.runnerId,
        leaseSeconds: input.leaseSeconds ?? 300,
      });
      const assignment = record(renewed.assignment ?? renewed.payload);
      const leaseExpiresAt = text(assignment.leaseExpiresAt);
      if (leaseExpiresAt) await input.onLeaseRenewed?.(leaseExpiresAt);
    } catch (error) {
      renewalFailure = error;
		executionAbort.abort(error);
      return;
    }
    scheduleRenewal();
  };
  scheduleRenewal();
  try {
    result = await input.executor.execute({ assignment: executorAssignment(input.assignment), assignmentId, leaseToken: input.leaseToken, runnerId: input.runnerId, treeDx, signal: executionAbort.signal });
  } catch (error) {
    result = { status: 'failed', code: 'agent_executor_failed', summary: error instanceof Error ? error.message : String(error), retryable: true };
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await renewalInFlight;
		input.signal?.removeEventListener('abort', abortFromCaller);
  }
  if (renewalFailure) {
    result = {
      status: 'returned',
      code: 'assignment_lease_renewal_failed',
      summary: renewalFailure instanceof Error ? renewalFailure.message : String(renewalFailure),
      retryable: true,
    };
  }
  await reportUsage(input, assignmentId, result);
	if (result.status === 'responded' || result.status === 'abstained') {
		if (result.status === 'responded' && !result.responseMarkdown) throw new Error('Communication executor omitted its durable Markdown response.');
		await input.client.respondToAssignmentDiscussion(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId,
			outcome: result.status, ...(result.responseMarkdown ? { markdown: result.responseMarkdown } : {}), summary: result.summary }, `discussion-response:${assignmentId}:${input.runnerId}`);
		const usage = record(result.usage?.[0]);
		await input.client.settleAssignment(assignmentId, { activeSeconds: Number(usage.activeSeconds ?? 0), elapsedSeconds: Number(usage.elapsedSeconds ?? 0),
			usageDimension: 'aggregate', usageActual: {} }, `discussion-settlement:${assignmentId}:${input.runnerId}`);
		return input.client.returnAssignment(assignmentId, { runnerId: input.runnerId, summary: { text: result.summary } });
	}
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
