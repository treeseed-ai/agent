import { describe, expect, it } from 'vitest';
import { assignmentActivityContext, assignmentRuntimeSeconds } from '../../../src/provider/execution/activity/context.ts';

describe('guest assignment task authority', () => {
	it('uses the immutable graph attempt rather than the retired decision input', () => {
		const assignment = { mode: 'acting', decisionInput: { input: { objective: 'Wrong legacy task' } },
			assignmentAttempt: { id: 'attempt-1', sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal-1' },
				workItemId: 'work-1', acceptanceCriteria: ['Pass tests'], predecessorResultIds: ['prior-1'],
				effectiveProfile: { activity: 'acting', prompt: { system: 'Implement the work.' } },
				grant: { tools: ['source.read'] }, limits: { maximumSeconds: 120 }, deadline: '2026-09-20T12:02:00.000Z' } };
		expect(assignmentActivityContext(assignment)).toMatchObject({ activityType: 'acting',
			task: { workItemId: 'work-1', acceptanceCriteria: ['Pass tests'], prompt: { system: 'Implement the work.' } },
			executionWindow: { deadline: '2026-09-20T12:02:00.000Z' } });
		expect(JSON.stringify(assignmentActivityContext(assignment))).not.toContain('Wrong legacy task');
		expect(assignmentRuntimeSeconds(assignment, Date.parse('2026-09-20T12:00:00.000Z'))).toBe(120);
		expect(() => assignmentRuntimeSeconds(assignment, Date.parse('2026-09-20T12:02:00.000Z'))).toThrow(/exhausted/u);
	});

	it('fails closed when an attempt is missing', () => {
		expect(() => assignmentActivityContext({ decisionInput: { input: { objective: 'Legacy only' } } })).toThrow('assignment_attempt_invalid');
		expect(() => assignmentRuntimeSeconds({ capacityEnvelope: { budget: { time: { executionSeconds: 120 } } } })).toThrow(/deadline is absent/u);
	});
});
