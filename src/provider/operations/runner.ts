import { createHash } from 'node:crypto';
import type { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutionRequest, AgentExecutor, AgentExecutionResult, AssignmentTreeDxFacade } from '../execution/contracts.ts';
import { executeKernelAssignment } from '../../kernel/provider-kernel-executor.ts';

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

function settlementSeconds(value: unknown) {
	const seconds = Number(value ?? 0);
	if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Execution provider reported invalid assignment timing.');
	return Math.ceil(seconds);
}

export interface ProviderAssignmentRunInput {
  client: Pick<ProviderProtocolClient, 'assignment' | 'createAssignmentEvent' | 'renewAssignment' | 'startAssignmentExecution' | 'startAssignmentCloseout' | 'completeAssignment' | 'returnAssignment' | 'failAssignment' | 'reportAssignmentUsage' | 'respondToAssignmentDiscussion' | 'settleAssignment' | 'createCommunicationTraceEvent' | 'authorizeAssignmentSource'>;
  executor: AgentExecutor;
  assignment: Record<string, unknown>;
  leaseToken: string;
  runnerId: string;
  treeDx: AssignmentTreeDxFacade;
  runtimeBuild?: string;
  leaseSeconds?: number;
  renewalIntervalMs?: number;
  onLeaseRenewed?: (leaseExpiresAt: string) => Promise<void>;
	onActiveExecutionStarted?: () => Promise<void>;
	onActiveExecutionFinished?: () => Promise<void>;
  signal?: AbortSignal;
}

async function reportUsage(input: ProviderAssignmentRunInput, assignmentId: string, result: AgentExecutionResult) {
  for (const [index, usage] of (result.usage ?? []).entries()) {
    await input.client.reportAssignmentUsage(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId,
      // Failure diagnostics preserve provider-native timing in usageActual, but
      // only terminal aggregate settlement owns agent-time accounting.
      usageDimension: `diagnostic-${index}`, accountingMode: 'informational', activeSeconds: 0, elapsedSeconds: 0,
      usageActual: usage }, `usage:${assignmentId}:${input.runnerId}:${index}`);
  }
}

export async function runProviderAssignment(input: ProviderAssignmentRunInput) {
  const assignmentId = text(input.assignment.id);
  if (!assignmentId) throw new Error('Catalogued assignment lease omitted its stable id.');
	const activeAssignment = { ...input.assignment };
	let executionStart: Promise<Record<string, unknown>> | null = null;
	const beginExecution = () => {
		executionStart ??= (async () => {
			const current = await input.client.assignment(assignmentId);
			const window = record(await input.client.startAssignmentExecution(assignmentId, {
				leaseToken: input.leaseToken,
				runnerId: input.runnerId,
				executorId: input.executor.id,
				idempotencyKey: `execution-start:${assignmentId}`,
				expectedStateVersion: Number(current.stateVersion),
			}));
			await input.onActiveExecutionStarted?.();
			return window;
		})();
		return executionStart;
	};
  const conversation = text(activeAssignment.executionKind, activeAssignment.execution_kind) === 'conversation';
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
    }, Math.min(input.renewalIntervalMs ?? Math.max(30_000, (input.leaseSeconds ?? 300) * 500), 10_000));
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
	let traceSequence = 0;
  const traceRunner = createHash('sha256').update(input.runnerId).digest('hex').slice(0, 24);
  const emit: NonNullable<Parameters<AgentExecutor['execute']>[0]['emit']> = async event => {
    const sequence = traceSequence++;
    if (conversation) {
      await input.client.createCommunicationTraceEvent(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, sequence, ...event });
    } else {
      // Protected transcript payloads must not enter recipient-visible workday events.
      await input.client.createAssignmentEvent(assignmentId, { id: `trace:${traceRunner}:${sequence}`,
        eventType: `provider.${event.type}`, component: 'execution-provider',
        status: event.type === 'execution.failed' ? 'failed' : event.type === 'execution.completed' ? 'completed' : 'recorded',
        message: event.summary, createdAt: event.occurredAt, context: event.payload });
    }
  };
  try {
    const executionRequest: AgentExecutionRequest = { assignment: executorAssignment(activeAssignment), assignmentId, leaseToken: input.leaseToken, runnerId: input.runnerId, treeDx,
      authorizeSource: recipientPublicKey => input.client.authorizeAssignmentSource(assignmentId, { runnerId: input.runnerId, leaseToken: input.leaseToken, recipientPublicKey }),
		beginExecution,
		emit,
		signal: executionAbort.signal };
	result = await executeKernelAssignment({ executor: input.executor, request: executionRequest,
		runtimeBuild: input.runtimeBuild ?? String(record(record(activeAssignment.assignmentAttempt).provider).runtimeBuild ?? '') });
  } catch (error) {
		const summary = error instanceof Error ? error.message : String(error);
		const failureCode=typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'agent_executor_failed';
		const retryable=!['provider_context_measurement_mismatch','provider_context_capacity_overflow','assignment_execution_window_exhausted'].includes(failureCode);
			await emit({
				type: 'execution.failed', occurredAt: new Date().toISOString(), summary, payload: { code: failureCode, retryable } }).catch(() => undefined);
    result = { status: 'failed', code: failureCode, summary, retryable };
  } finally {
		try {
			if (executionStart) await input.onActiveExecutionFinished?.();
		} finally {
			stopped = true;
			if (timer) clearTimeout(timer);
			await renewalInFlight;
			input.signal?.removeEventListener('abort', abortFromCaller);
		}
  }
	if (renewalFailure) {
    result = {
      status: 'returned',
      code: 'assignment_lease_renewal_failed',
      summary: renewalFailure instanceof Error ? renewalFailure.message : String(renewalFailure),
      retryable: true,
    };
  }
	// Sandbox harnesses return their final Markdown in responseMarkdown for every
	// activity. Only conversation assignments may publish that value to a
	// Discussion; workday activities persist it as their completion summary.
	if (!conversation && (result.status === 'responded' || result.status === 'abstained')) {
		const response = result.responseMarkdown?.trim();
		result = { ...result, status: 'completed', summary: response || result.summary, responseMarkdown: undefined };
	}
	if (result.status === 'responded' || result.status === 'abstained') {
		if (result.status === 'responded' && !result.responseMarkdown) throw new Error('Communication executor omitted its durable Markdown response.');
		const response = await input.client.respondToAssignmentDiscussion(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId,
			outcome: result.status, ...(result.responseMarkdown ? { markdown: result.responseMarkdown } : {}), summary: result.summary }, `discussion-response:${assignmentId}:${input.runnerId}`);
		const usage = record(result.usage?.[0]);
		await input.client.settleAssignment(assignmentId, { activeSeconds: settlementSeconds(usage.activeSeconds), elapsedSeconds: settlementSeconds(usage.elapsedSeconds),
			usageDimension: 'aggregate', usageActual: {} }, `discussion-settlement:${assignmentId}:${input.runnerId}`);
		// Publishing the response intentionally suspends and revokes the assignment
		// workspace. The API closes that checkpoint after observing this settlement;
		// attempting the ordinary leased completion path here would use stale authority.
		return response;
	}
	if (result.status !== 'completed') await reportUsage(input, assignmentId, result);
  if (result.status === 'returned') {
    return input.client.returnAssignment(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, code: result.code ?? 'agent_executor_returned', reason: result.summary, retryable: result.retryable ?? true });
  }
  if (result.status === 'failed') {
    return input.client.failAssignment(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId, code: result.code ?? 'agent_executor_failed', message: result.summary, retryable: result.retryable ?? false });
  }
  const current = await input.client.assignment(assignmentId);
  await input.client.startAssignmentCloseout(assignmentId, { leaseToken: input.leaseToken, runnerId: input.runnerId,
    idempotencyKey: `closeout-start:${assignmentId}:${input.runnerId}`, expectedStateVersion: Number(current.stateVersion) });
  const completion = {
    leaseToken: input.leaseToken,
    runnerId: input.runnerId,
    summary: { text: result.summary },
    output: { ...record(result.outputs), artifacts: result.artifacts ?? [] },
    metadata: {} as Record<string, unknown>,
  };
  const usage = record(result.usage?.[0]);
  await input.client.settleAssignment(assignmentId, { activeSeconds: settlementSeconds(usage.activeSeconds), elapsedSeconds: settlementSeconds(usage.elapsedSeconds),
    usageDimension: 'aggregate', usageActual: usage }, `assignment-settlement:${assignmentId}:${input.runnerId}`);
  return input.client.completeAssignment(assignmentId, completion);
}
