import { describe, expect, it } from 'vitest';
import { assignmentDeadlineExpired, deadlineBoundExecutionTimeoutMs } from '../../../src/agents/adapters/reconciliation/execution-codex-adapter.ts';
import { assignmentTimeGuidance, buildExecutionContentInstructions } from '../../../src/agents/handlers/execution-content-prompt.ts';

describe('assignment execution timing', () => {
	it('derives a deadline from the assignment claim and reserved agent time', () => {
		const timing = assignmentTimeGuidance({ capacity: {
			assignment: { claimedAt: '2026-08-05T10:00:00.000Z' },
			envelope: { reservedSeconds: 240 },
		} } as never, Date.parse('2026-08-05T10:01:00.000Z'));
		expect(timing).toEqual({
			startedAt: '2026-08-05T10:00:00.000Z',
			allocatedSeconds: 240,
			deadlineAt: '2026-08-05T10:04:00.000Z',
			remainingSeconds: 180,
		});
		expect(deadlineBoundExecutionTimeoutMs(900_000, timing, Date.parse('2026-08-05T10:01:00.000Z'))).toBe(180_000);
		expect(assignmentDeadlineExpired(timing, Date.parse('2026-08-05T10:03:59.999Z'))).toBe(false);
		expect(assignmentDeadlineExpired(timing, Date.parse('2026-08-05T10:04:00.000Z'))).toBe(true);
	});

	it('tells the agent to preserve useful work before expiration', () => {
		const instructions = buildExecutionContentInstructions({
			agent: { systemPrompt: 'Research carefully.' },
			capacity: {
				mode: 'planning', assignmentId: 'assignment-a',
				assignment: { claimedAt: '2026-08-05T10:00:00.000Z' },
				envelope: { reservedSeconds: 240 },
			},
		} as never, {
			payload: {}, subject: { model: 'objective', id: 'core', title: 'Core' }, artifactKind: 'planning_note',
			contextPackSummaries: [], assignedObjective: null, contentRoot: 'src/content',
		});
		expect(instructions).toContain('Allocated agent time: 240 seconds');
		expect(instructions).toContain('Track elapsed time throughout execution');
		expect(instructions).toContain('checkpoint or commit valid work');
	});
});
