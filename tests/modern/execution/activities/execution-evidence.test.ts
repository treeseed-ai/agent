import { describe, expect, it } from 'vitest';
import { emitExecutionEvidence } from '../../../../src/provider/execution/activity/execution-evidence.ts';
import { modelExecutionInventory } from '../../../acceptance/workday/support/assignment-authority.ts';
import type { AgentExecutionRequest } from '../../../../src/provider/execution/contracts.ts';

type Event = Parameters<NonNullable<AgentExecutionRequest['emit']>>[0];
const usage = { inputTokens: 17, outputTokens: 3, activeSeconds: 1.25 }, outputs = { sandboxId: 'owned', teardown: { verified: true } };
const event: Event = { type: 'execution.completed', occurredAt: '2026-10-26T19:11:00.000Z', summary: 'Original completed execution',
	payload: { model: 'configured-model' }, protectedPayload: { providerEvents: [{ type: 'turn.completed' }], sourceCommit: 'exact' } };

describe('protected execution evidence', () => {
	it('retains the original failure and measured usage when any transcript or terminal write is denied', async () => {
		for (const deniedStage of ['provider.events', 'terminal']) {
			const original = new Error('Original API trace denial'), before = structuredClone(event);
			await expect(emitExecutionEvidence(async value => {
				if ((value.payload.stage === 'provider.events') === (deniedStage === 'provider.events')) throw original;
			}, event, usage, outputs)).rejects.toBe(original);
			expect(original).toMatchObject({ usage: [usage], outputs }); expect(event).toEqual(before);
		}
	});
	it('preserves unstreamed diagnostics and missing observers without manufacturing provider events', async () => {
		const original = { ...event, protectedPayload: { original: 'diagnostic' } }, retained: Event[] = [];
		await emitExecutionEvidence(async value => { retained.push(value); }, original, usage, outputs);
		expect(retained).toEqual([original]); await expect(emitExecutionEvidence(undefined, event, usage, outputs)).resolves.toBeUndefined();
	});
	it('joins only complete ordered owning transcript batches without modifying retained history', () => {
		const fixture = () => {
			const run = { id: 'workday', teamId: 'team' }, item = { id: 'assignment', status: 'completed',
				assignmentAttempt: { id: 'assignment', workdayId: run.id, teamId: run.teamId, projectId: 'project' } };
			const events = ['started', 'progress', 'progress', 'completed'].map((phase, index) => ({ id: `event-${index}`, eventIndex: index,
				eventType: `provider.execution.${phase}`, assignmentId: item.id, runId: run.id, workdayId: run.id, teamId: run.teamId,
				projectId: 'project', createdAt: '2026-10-26T19:11:00.000Z', context: index === 0 || index === 3 ? { model: 'configured-model' }
					: { stage: 'provider.events', offset: index - 1, count: 1 }, protectedPayload: index === 3 ? { providerEventCount: 2 }
					: { providerEvents: [{ type: index === 1 ? 'turn.started' : 'turn.completed' }] } }));
			return { run, item, events };
		};
		const f = fixture(), before = structuredClone(f);
		expect(modelExecutionInventory([f.item], f.events, f.run)[0]!.terminal.protectedPayload).toMatchObject({ providerEvents: [{ type: 'turn.started' }, { type: 'turn.completed' }] });
		expect(f).toEqual(before);
		for (const mode of ['missing', 'duplicate', 'gap', 'count', 'project', 'workday', 'late', 'empty', 'negative', 'fractional']) {
			const changed = fixture();
			if (mode === 'missing') changed.events.splice(1, 1);
			if (mode === 'duplicate') changed.events[2]!.context.offset = 0;
			if (mode === 'gap') changed.events[2]!.context.offset = 3;
			if (mode === 'count') changed.events[2]!.context.count = 2;
			if (mode === 'project') changed.events[1]!.projectId = 'foreign';
			if (mode === 'workday') changed.events[1]!.workdayId = 'foreign';
			if (mode === 'late') changed.events[1]!.eventIndex = 4;
			if (mode === 'empty') changed.events[1]!.protectedPayload.providerEvents = [];
			if (mode === 'negative') changed.events[3]!.protectedPayload.providerEventCount = -1;
			if (mode === 'fractional') changed.events[3]!.protectedPayload.providerEventCount = 1.5;
			const held = structuredClone(changed);
			expect(() => modelExecutionInventory([changed.item], changed.events, changed.run), mode).toThrow(); expect(changed).toEqual(held);
		}
	});
});
