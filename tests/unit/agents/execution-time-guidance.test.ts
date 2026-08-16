import { describe, expect, it } from 'vitest';
import { assignmentDeadlineExpired, deadlineBoundExecutionTimeoutMs } from '../../../src/agents/adapters/reconciliation/execution-codex-adapter.ts';
import { executionCompletionDeadlineMs } from '../../../src/agents/adapters/reconciliation/execution-timeout.ts';
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
			closeoutWarningSeconds: 48,
			phase: 'working',
			shouldCloseOut: false,
		});
		expect(deadlineBoundExecutionTimeoutMs(900_000, timing, Date.parse('2026-08-05T10:01:00.000Z'))).toBe(87_000);
		expect(assignmentDeadlineExpired(timing, Date.parse('2026-08-05T10:03:59.999Z'))).toBe(false);
		expect(assignmentDeadlineExpired(timing, Date.parse('2026-08-05T10:04:00.000Z'))).toBe(true);
	});

	it('reserves bounded provider lifecycle time before the immutable hard deadline', () => {
		const now = Date.parse('2026-08-05T10:00:00.000Z');
		expect(deadlineBoundExecutionTimeoutMs(900_000, {
			deadlineAt: '2026-08-05T10:02:00.000Z', closeoutWarningSeconds: 24,
		}, now)).toBe(66_000);
		expect(deadlineBoundExecutionTimeoutMs(900_000, {
			deadlineAt: '2026-08-05T10:15:00.000Z', closeoutWarningSeconds: 180,
		}, now)).toBe(600_000);
		expect(deadlineBoundExecutionTimeoutMs(900_000, {
			deadlineAt: '2026-08-05T10:00:08.000Z', closeoutWarningSeconds: 24,
		}, now)).toBe(1);
		expect(deadlineBoundExecutionTimeoutMs(60_000, {
			deadlineAt: '2026-08-05T10:00:34.000Z', closeoutWarningSeconds: 12,
		}, now)).toBe(1);
		expect(executionCompletionDeadlineMs(240_000, {
			deadlineAt: '2026-08-05T10:05:00.000Z',
		}, now)).toBe(Date.parse('2026-08-05T10:04:00.000Z'));
		expect(executionCompletionDeadlineMs(900_000, {
			deadlineAt: '2026-08-05T10:05:00.000Z',
		}, now)).toBe(Date.parse('2026-08-05T10:04:30.000Z'));
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
		expect(instructions).toContain('Protected closeout allocation: 48 seconds outside productive execution');
		expect(instructions).toContain('Call treeseed.status at the start');
		expect(instructions).toContain('shouldCloseOut=true');
		expect(instructions).toContain('validate every content artifact with its Zod-backed model');
		expect(instructions).toContain('The proposal does not extend this assignment');
	});

	it('uses an explicit closeout warning from the governed capacity envelope', () => {
		const timing = assignmentTimeGuidance({ capacity: {
			assignment: { claimedAt: '2026-08-05T10:00:00.000Z' },
			envelope: { reservedSeconds: 900, budget: { time: { closeoutWarningSeconds: 120 } } },
		} } as never, Date.parse('2026-08-05T10:13:10.000Z'));
		expect(timing).toMatchObject({ remainingSeconds: 110, closeoutWarningSeconds: 120, shouldCloseOut: true });
	});

	it('prevents agents from inventing subject groups for signal routing', () => {
		const instructions = buildExecutionContentInstructions({
			agent:{ systemPrompt:'Research carefully.' },capacity:{ mode:'planning',assignmentId:'assignment-a',assignment:{},envelope:{} },
		} as never,{
			payload:{ signalContracts:{ 'evidence-ready':{ id:'evidence-ready' } } },
			subject:{ model:'objective',id:'core',title:'Core' },artifactKind:'planning_note',contextPackSummaries:[],assignedObjective:null,contentRoot:'src/content',
		});
		expect(instructions).toContain("otherwise omit subjectGroupIds so the control plane can apply its frozen primary-group fallback");
		expect(instructions).toContain('Never infer group IDs from an artifact path, editorial category, provider, role, or agent class.');
	});
});
