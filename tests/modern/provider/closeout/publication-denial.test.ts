import { expect, it } from 'vitest';
import { CapacityProviderApiError } from '@treeseed/sdk/capacity-provider';
import { runProviderAssignment } from '../../../../src/provider/operations/runner.ts';
import { assignment, client, runtimeBuild, timingAwareness, treeDx } from './runner-fixture.ts';

it('retains a definitive discussion publication denial as a failed result with original measured usage and no invented product', async () => {
 const api = client(), input = assignment('conversation'), held = structuredClone(input);
 api.respondToAssignmentDiscussion.mockRejectedValue(new CapacityProviderApiError('No chat-enabled team agent matches the supplied address.', 404, { code: 'communication_agent_not_found' }));
 const usage = { activeSeconds: 2.125, elapsedSeconds: 3.25, inputTokens: 20, outputTokens: 10 };
 const result = await runProviderAssignment({ client: api, assignment: input, treeDx, leaseToken: 'lease', runnerId: 'runner', runtimeBuild,
  executor: { id: 'codex', observe: async () => ({ available: true }), execute: async request => {
   await request.beginExecution?.(); return { status: 'responded', summary: 'Original model response.', responseMarkdown: 'Original unpublished response.', outputs: { timingAwareness }, usage: [usage] };
  } } });
 expect(result).toEqual({ status: 'failed' });
 expect(api.respondToAssignmentDiscussion).toHaveBeenCalledOnce();
 expect(api.failAssignment).toHaveBeenCalledOnce();
 expect(api.failAssignment.mock.calls[0]?.[1]).toMatchObject({ code: 'communication_agent_not_found', retryable: false, activeSeconds: 3, elapsedSeconds: 4, usage,
  output: { assignmentResult: { status: 'failed', references: [], diagnostics: [{ code: 'communication_agent_not_found', severity: 'error' }] } } });
 expect(api.reportAssignmentUsage.mock.calls[0]?.[1]).toMatchObject({ accountingMode: 'informational', usageActual: usage });
 expect(api.completeAssignment).not.toHaveBeenCalled(); expect(api.settleAssignment).not.toHaveBeenCalled(); expect(api.returnAssignment).not.toHaveBeenCalled();
 expect(input).toEqual(held);
});
