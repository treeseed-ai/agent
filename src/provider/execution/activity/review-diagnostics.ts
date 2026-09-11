import { providerFailureSummary } from '../../../sandbox/provider-failure.ts';
import type { AgentExecutionResult } from '../contracts.ts';

export interface ReviewToolOutcome {
  tool: string;
  status: 'completed' | 'failed';
  reason?: string;
}

/** Diagnostics contain no tool arguments, returned content, or guest transcript. */
export function reviewToolOutcome(tool: string, error?: unknown, secrets: string[] = []): ReviewToolOutcome {
  return { tool, status: error === undefined ? 'completed' : 'failed', ...(error === undefined ? {} : {
    reason: providerFailureSummary([{ type: 'error', message: error instanceof Error ? error.message : String(error) }], secrets),
  }) };
}

export function missingReviewResult(usage: Record<string, unknown>, outcomes: ReviewToolOutcome[], outputs: Record<string, unknown>): AgentExecutionResult {
  const failed = outcomes.filter(outcome => outcome.tool === 'treeseed_publish_review' && outcome.status === 'failed').at(-1);
  return {
    status: 'failed', code: 'workday_artifact_missing', retryable: false,
    summary: failed?.reason ? `Review publication failed: ${failed.reason}` : 'Workday execution produced no authorized, verified artifact manifest.',
    outputs: { ...outputs, toolOutcomes: outcomes.slice(-32) }, usage: [usage],
  };
}
