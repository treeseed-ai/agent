import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { providerExecutionProgress } from '../../../../src/sandbox/guest.ts';
import { codexThreadId, codexTreeDxMcpConfig, completedTimeStatusChecks, prepareNodeWorkspace, providerEventShapeSummary, providerResourceAbort, providerResponsePreview, requiresNodeDependencyRestore, timingAwarenessContract, timingRecoveryEligible, treeDxToolDefinitions, verifyReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { assertArchitectSourceCitation, assertReplayableVerificationCommand, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTestFirstRedVerification, omitUnreplayableVerification, codexInteractiveTimeoutMs, codexProjectInstructionArguments, codexReasoningArguments, completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext, requiresActivityCompletion } from '../../../../src/sandbox/guest-contract.ts';
import { assertPredecessorSynthesis } from '../../../../src/kernel/handlers/planning-synthesis.ts';
import { activityCompletionOutputSchema } from '../../../../src/activity-completion.ts';
import { activityAllowsVerification } from '../../../../src/sandbox/guest-contract.ts';
import { architectureTaskInstructions } from '../../architecture/knowledge-task-fixture.ts';
import { request as executionRequest } from '../../kernel/provider-kernel-fixture.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
const clockResult = { content: [{ type: 'text', text: JSON.stringify({ startedAt: '2026-10-04T00:00:00.000Z', deadlineAt: '2026-10-04T00:01:00.000Z', remainingSeconds: 60 }) }] };
describe('Codex chat executor', () => {
	it('accepts timing awareness only from completed model-initiated clock checks', () => {
		expect(completedTimeStatusChecks([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'in_progress' } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null, result: clockResult } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null, result: clockResult } },
		])).toBe(2);
		expect(completedTimeStatusChecks([
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'failed', error: 'unavailable' } },
		])).toBe(0);
	});
	it('requires clock checks to bracket every other provider tool action', () => {
		const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null, result: clockResult } };
		const command = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', error: null } };
		expect(timingAwarenessContract([clock, command, clock])).toMatchObject({
			completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true,
		});
		expect(timingAwarenessContract([command, clock, clock])).toMatchObject({ firstToolCompliant: false });
		expect(timingAwarenessContract([clock, clock, command])).toMatchObject({ finalToolCompliant: false });
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command]), 20_000)).toBe(true);
		expect(timingRecoveryEligible(timingAwarenessContract([command, clock]), 20_000)).toBe(false);
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock]), 20_000)).toBe(false);
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock, command]), 20_000)).toBe(true);
		expect(codexThreadId([{ type: 'thread.started', thread_id: '12345678-1234-1234-1234-123456789abc' }])).toBe('12345678-1234-1234-1234-123456789abc');
		expect(codexThreadId([{ type: 'thread.started', thread_id: '../other-session' }])).toBeNull();
		expect(timingAwarenessContract([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'wrong_clock_alias', status: 'in_progress' } },
			clock, clock,
		])).toMatchObject({ firstTool: 'treedx:wrong_clock_alias', firstToolCompliant: false });
	});
	it.each(['planning', 'estimating', 'acting', 'reviewing', 'chat'] as const)(
		'applies the same first/final clock boundary to %s', (activity) => {
			const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
				id: `assignment-${activity}`, workspace: { mode: 'read-only' },
				...(activity === 'reviewing' ? { authorityRefs: [{ model: 'decision', id: 'accepted-decision' }] } : {}),
				effectiveProfile: { activity, handler: 'writer', prompt: { system: 'Complete the assigned work.' } },
			}, context: [], predecessorResults: [] } });
			expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
			expect(prompt).toContain('Your FIRST tool action must call mcp__treedx__treeseed_time_status');
			expect(prompt).toContain('call mcp__treedx__treeseed_time_status again as your FINAL tool action');
		},
	);
	it('summarizes provider event shapes without retaining arguments or output', () => {
		expect(providerEventShapeSummary([{ type: 'item.completed', item: {
			type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
			arguments: { secret: 'never retain' }, result: { remainingSeconds: 42 },
	} }])).toEqual([{ type: 'item.completed', itemType: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null }]);
	});
	it('redacts the last provider response used to diagnose a missing clock boundary', () => {
		expect(providerResponsePreview([{ type: 'item.completed', item: { type: 'agent_message', text: 'Cannot call sk-secret.' } }], ['sk-secret']))
			.toBe('Cannot call [redacted].');
	});
	it('reports remaining time from the API-started productive window without a content grant', async () => {
		const startedAt = new Date().toISOString(), deadlineAt = new Date(Date.now() + 60_000).toISOString();
		const input = executionRequest(), attempt = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt);
		attempt.limits.maximumSeconds = 60;
		attempt.createdAt = startedAt; attempt.deadline = deadlineAt;
		input.assignment = { ...input.assignment, assignmentAttempt: attempt };
		const result = await executeAssignmentTreeDxTool(input, 'treeseed_time_status', {}, {
			startedAt, deadlineAt,
		});
		expect(result).toMatchObject({ deadlineAt });
		expect(Number((result as Record<string, unknown>).remainingSeconds)).toBeGreaterThan(55);
	});
});
