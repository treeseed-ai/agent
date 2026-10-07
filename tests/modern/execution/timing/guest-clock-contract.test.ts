import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { clockReading, providerExecutionProgress } from '../../../../src/sandbox/guest.ts';
import { codexThreadId, codexTreeDxMcpConfig, completedTimeStatusChecks, prepareNodeWorkspace, providerEventShapeSummary, providerResourceAbort, providerResponsePreview, requiresNodeDependencyRestore, timingAwarenessContract, timingRecoveryEligible, treeDxToolDefinitions, verifyReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { assertArchitectSourceCitation, assertReplayableVerificationCommand, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTestFirstRedVerification, omitUnreplayableVerification, codexInteractiveTimeoutMs, codexProjectInstructionArguments, codexReasoningArguments, completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext, requiresActivityCompletion } from '../../../../src/sandbox/guest-contract.ts';
import { assertPredecessorSynthesis } from '../../../../src/kernel/handlers/planning-synthesis.ts';
import { activityCompletionOutputSchema } from '../../../../src/activity-completion.ts';
import { activityAllowsVerification } from '../../../../src/sandbox/guest-contract.ts';
import { architectureTaskInstructions } from '../../architecture/knowledge-task-fixture.ts';
import { request as executionRequest } from '../../kernel/provider-kernel-fixture.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { redactProviderEvents } from '../../../../src/sandbox/provider-failure.ts';
import { verifyModelClockEvidence, modelExecutionInventory } from '../../../acceptance/workday/support/assignment-authority.ts';
const clockResult = { content: [{ type: 'text', text: JSON.stringify({ startedAt: '2026-10-04T00:00:00.000Z', deadlineAt: '2026-10-04T00:01:00.000Z', observedAt: '2026-10-04T00:00:00.000Z', remainingSeconds: 60 }) }] };
describe('Codex chat executor', () => {
	it('discovers every recorded model execution including failed and returned renamed activities and denies missing ambiguous or foreign inventory without rewriting history', () => {
		const fixture = () => {
			const run = { id: 'workday-clock', teamId: 'team-clock' }, items = ['completed', 'failed', 'returned'].map((status, index) => ({
				id: `assignment-${index}`, status, assignmentAttempt: { id: `assignment-${index}`, workdayId: run.id, teamId: run.teamId,
					projectId: 'original-project', effectiveProfile: { activity: 'arbitrarily-renamed-model-input' } } }));
			const events = items.flatMap((item, index) => ['started', index ? 'failed' : 'completed'].map((phase, offset) => ({
				id: `original-event-${index}-${offset}`, eventIndex: index * 2 + offset, eventType: `provider.execution.${phase}`,
				runId: run.id, workdayId: run.id, teamId: run.teamId, projectId: 'original-project', assignmentId: item.id,
				createdAt: `2026-10-07T00:00:0${index * 2 + offset}.000Z`, payload: { model: 'supplied-not-actual-model', isolation: 'microvm' } })));
			return { run, items, events };
		};
		const f = fixture(), before = structuredClone(f);
		expect(modelExecutionInventory(f.items, f.events, f.run).map(value => value.item.status)).toEqual(['completed', 'failed', 'returned']); expect(f).toEqual(before);
		for (const mode of ['empty', 'missing-start', 'missing-terminal', 'duplicate-start', 'duplicate-terminal', 'duplicate-owner', 'missing-owner',
			'foreign-run', 'foreign-team', 'foreign-project', 'foreign-attempt', 'empty-model', 'missing-model', 'bad-clock', 'reversed', 'duplicate-index']) {
			const supplied = fixture();
			if (mode === 'empty') supplied.events = [];
			if (mode === 'missing-start') supplied.events.splice(0, 1);
			if (mode === 'missing-terminal') supplied.events.splice(1, 1);
			if (mode.startsWith('duplicate-') && ['duplicate-start', 'duplicate-terminal'].includes(mode)) supplied.events.push({
				...supplied.events[mode === 'duplicate-start' ? 0 : 1]!, id: 'additional-event', eventIndex: 6 });
			if (mode === 'duplicate-owner') supplied.items.push(structuredClone(supplied.items[0]!));
			if (mode === 'missing-owner') supplied.items.splice(0, 1);
			if (mode === 'foreign-run') supplied.events[0]!.runId = 'foreign';
			if (mode === 'foreign-team') supplied.events[0]!.teamId = 'foreign';
			if (mode === 'foreign-project') supplied.events[0]!.projectId = 'foreign';
			if (mode === 'foreign-attempt') supplied.items[0]!.assignmentAttempt.id = 'foreign';
			if (mode === 'empty-model') supplied.events[0]!.payload.model = '';
			if (mode === 'missing-model') Object.assign(supplied.events[0]!.payload, { model: undefined });
			if (mode === 'bad-clock') supplied.events[0]!.createdAt = 'invalid';
			if (mode === 'reversed') supplied.events[0]!.createdAt = '2026-10-07T00:00:59.000Z';
			if (mode === 'duplicate-index') supplied.events[1]!.eventIndex = 0;
			const held = structuredClone(supplied); expect(() => modelExecutionInventory(supplied.items, supplied.events, supplied.run), mode).toThrow(); expect(supplied).toEqual(held);
		}
		// Supplied records prove this acceptance consumer, not native model production.
	});
	it('denies missing foreign and empty selected proposal work-item context without repairing the supplied assignment', () => {
		const sourceRef = { store: 'treedx', model: 'proposal', id: 'supplied-proposal', repository: 'supplied-library', commit: 'a'.repeat(40), path: 'proposals/supplied.yaml' };
		for (const [index, context] of [[], [{ ref: { ...sourceRef, id: 'foreign' }, value: { frontmatter: { executionPlan: { workItems: [{ id: 'selected' }] } } } }],
			[{ ref: sourceRef, value: { frontmatter: { executionPlan: { workItems: [] } } } }],
			[{ ref: sourceRef, value: { frontmatter: { executionPlan: { workItems: [{ id: 'foreign' }] } } } }]].entries()) {
			const input = { canonicalAssignmentContext: { assignment: { id: 'supplied-assignment', sourceRef, workItemId: 'selected',
				workspace: { mode: 'read-only' }, effectiveProfile: { activity: 'chat', handler: 'writer' } }, context, predecessorResults: [] } };
			const before = structuredClone(input);
			expect(() => promptFromContext(input)).toThrow(index < 2 ? 'assignment_exact_proposal_context_required' : 'assignment_work_item_context_required'); expect(input).toEqual(before);
		}
	});
	it('retains ordered untrimmed first and final clocks and early fatal command evidence through a long sanitized provider observation', () => {
		const clock = (id: string) => ({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status',
			status: 'completed', result: structuredClone(clockResult) } });
		const command = { type: 'item.completed', item: { id: 'original-fatal-command', type: 'command_execution', command: 'original command', exit_code: 137, aggregated_output: 'Killed\n' } };
		const events = [clock('first'), command, ...Array.from({ length: 300 }, (_, index) => ({ type: 'item.completed',
			item: { id: `reasoning-${index}`, type: 'reasoning', text: 'supplied-secret' } })), clock('final')];
		const before = structuredClone(events), sanitized = redactProviderEvents(events, ['supplied-secret']);
		expect(sanitized).toHaveLength(303); expect(sanitized[0]).toEqual(before[0]); expect(sanitized.at(-1)).toEqual(before.at(-1));
		expect(sanitized[2]).toMatchObject({ item: { text: '[redacted]' } });
		expect(timingAwarenessContract(sanitized)).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
		expect(providerResourceAbort(sanitized)).toEqual({ exitCode: 137, command: 'original command' }); expect(events).toEqual(before);
	});
	it('binds public raw model clock evidence to its exact completed assignment event receipt and immutable original timestamps', () => {
		const startedAt = '2026-10-04T00:00:00.000Z', deadlineAt = '2026-10-04T00:01:00.000Z';
		const fixture = () => {
			const clock = (id: string, observedAt: string, remainingSeconds: number) => { const value = { startedAt, deadlineAt, observedAt, remainingSeconds }; return {
				type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
					result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
			const events = [clock('first', startedAt, 60), clock('final', '2026-10-04T00:00:01.000Z', 59)];
			return { item: { id: 'assignment-clock', status: 'completed', assignmentAttempt: { id: 'assignment-clock', teamId: 'team-clock', projectId: 'sdk',
				workdayId: 'workday-clock', deadline: deadlineAt }, capacityEnvelope: { budget: { time: { executionStartedAt: startedAt } } },
				assignmentResult: { assignmentId: 'assignment-clock', status: 'completed', completedAt: '2026-10-04T00:00:02.000Z', timingAwareness: {
					schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2, firstTool: 'treedx:treeseed_time_status',
					firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status', lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true } } },
				event: { id: 'provider-runtime:assignment-clock:complete', runId: 'workday-clock', workdayId: 'workday-clock', teamId: 'team-clock', projectId: 'sdk',
					assignmentId: 'assignment-clock', eventIndex: 3, eventType: 'provider.execution.completed', status: 'recorded',
					createdAt: '2026-10-04T00:00:02.001Z', protectedPayload: { providerEvents: events } } };
		};
		const original = fixture(), before = structuredClone(original); expect(() => verifyModelClockEvidence(original.item, original.event)).not.toThrow(); expect(original).toEqual(before);
		const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
			f => { f.item.status = 'failed'; }, f => { f.event.assignmentId = 'foreign'; }, f => { f.event.teamId = 'foreign'; },
			f => { f.event.runId = 'foreign'; }, f => { f.event.workdayId = 'foreign'; }, f => { f.event.projectId = 'foreign'; },
			f => { f.event.eventType = 'provider.execution.failed'; }, f => { f.event.status = 'error'; },
			f => { f.event.createdAt = startedAt; }, f => { Object.assign(f.event, { protectedPayload: undefined }); },
			f => { f.event.protectedPayload.providerEvents = []; }, f => { f.item.assignmentResult.timingAwareness.completedChecks = 3; },
			f => { f.item.assignmentResult.assignmentId = 'foreign'; }, f => { f.item.assignmentResult.completedAt = '2026-10-04T00:00:00.500Z'; },
			f => { f.event.protectedPayload.providerEvents[1]!.item.id = 'first'; },
			f => { const v = f.event.protectedPayload.providerEvents[1]!.item.result; Object.assign(v.structuredContent, { observedAt: undefined }); v.content[0]!.text = JSON.stringify(v.structuredContent); },
			f => { const v = f.event.protectedPayload.providerEvents[1]!.item.result; v.structuredContent.observedAt = startedAt; v.content[0]!.text = JSON.stringify(v.structuredContent); },
		];
		for (const mutate of mutations) {
			const f = fixture(); mutate(f); const held = structuredClone(f); expect(() => verifyModelClockEvidence(f.item, f.event)).toThrow(); expect(f).toEqual(held);
		}
		// Supplied public event/receipt inputs, not actual model actions or API issuance.
	});
	it('retains exact clock timestamps and derives remaining seconds from the same observation without rewriting provider evidence', () => {
		const startedAt = '2026-10-04T00:00:00.000Z', deadlineAt = '2026-10-04T00:01:00.000Z';
		for (const [observedAt, remainingSeconds] of [['2026-10-04T00:00:00.000Z', 60], ['2026-10-04T00:00:00.001Z', 60],
			['2026-10-04T00:00:01.000Z', 59], ['2026-10-04T00:00:59.999Z', 1], ['2026-10-04T00:01:00.000Z', 0],
			['2026-10-04T00:01:00.001Z', 0]] as const) {
			const value = { startedAt, deadlineAt, observedAt, remainingSeconds };
			const result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }, before = structuredClone(result);
			expect(clockReading(result)).toEqual(value); expect(result).toEqual(before);
		}
	});
	it('denies missing malformed regressing and contradictory clock timestamps without repairing either raw observation', () => {
		const base = { startedAt: '2026-10-04T00:00:00.000Z', deadlineAt: '2026-10-04T00:01:00.000Z', observedAt: '2026-10-04T00:00:00.000Z', remainingSeconds: 60 };
		const action = (value: Record<string, unknown>) => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx',
			tool: 'treeseed_time_status', status: 'completed', error: null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } });
		const absent = { startedAt: base.startedAt, deadlineAt: base.deadlineAt, remainingSeconds: 60 };
		for (const value of [absent, ...[undefined, null, '', 'not-a-clock', 0, false, [], {}, '2026-02-30T00:00:00.000Z',
			'2026-10-03T23:59:59.999Z'].map(observedAt => ({ ...base, observedAt })),
			{ ...base, observedAt: '2026-10-04T00:00:01.000Z', remainingSeconds: 60 },
			{ ...base, observedAt: '2026-10-04T00:01:00.000Z', remainingSeconds: 1 }]) {
			for (const events of [[action(value), action(base)], [action(base), action(value)]]) {
				const before = structuredClone(events);
				expect(timingAwarenessContract(events)).toMatchObject({ firstToolCompliant: false, finalToolCompliant: false });
				expect(events).toEqual(before);
			}
		}
		const events = [action({ ...base, observedAt: '2026-10-04T00:00:00.900Z' }), action({ ...base, observedAt: '2026-10-04T00:00:00.100Z' })];
		const before = structuredClone(events);
		expect(timingAwarenessContract(events)).toMatchObject({ firstToolCompliant: false, finalToolCompliant: false }); expect(events).toEqual(before);
	});
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
		const now = Date.now(), startedAt = new Date(now).toISOString(), deadlineAt = new Date(now + 60_000).toISOString();
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
