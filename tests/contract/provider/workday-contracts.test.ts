import { describe, expect, it } from 'vitest';
import {
	evaluateWorkdayContinuation,
	selectFairPlanningAgentCycles,
} from '@treeseed/sdk/agent-capacity';

describe('capacity workday contracts', () => {
	it('continues useful work until duration or budget bound', () => {
		const active = {
			status: 'active',
			now: '2026-07-16T12:00:00.000Z',
			deadlineAt: '2026-07-16T13:00:00.000Z',
			totalSeconds: 100,
			committedSeconds: 40,
			usefulEligibleWork: true,
		};

		expect(evaluateWorkdayContinuation(active)).toEqual({
			continue: true,
			reason: 'within_duration_and_budget',
		});
		expect(evaluateWorkdayContinuation({ ...active, now: active.deadlineAt })).toEqual({
			continue: false,
			reason: 'duration_bound_reached',
		});
		expect(evaluateWorkdayContinuation({ ...active, committedSeconds: 100 })).toEqual({
			continue: false,
			reason: 'budget_bound_reached',
		});
		expect(evaluateWorkdayContinuation({ ...active, usefulEligibleWork: false })).toEqual({
			continue: false,
			reason: 'no_useful_eligible_work',
		});
	});

	it('exercises every eligible planning agent before repeats', () => {
		const agents = [
			{ slug: 'alpha', projectAgentClassSlug: 'planning' },
			{ slug: 'beta', projectAgentClassSlug: 'planning' },
			{ slug: 'gamma', projectAgentClassSlug: 'planning' },
		];
		const initial = selectFairPlanningAgentCycles('project-1', agents, [], 4);
		expect(initial.slice(0, 3).map(({ agent }) => agent.slug)).toEqual(['alpha', 'beta', 'gamma']);
		expect(initial[3]).toMatchObject({ agent: { slug: 'alpha' }, cycle: 2 });

		const resumed = selectFairPlanningAgentCycles('project-1', agents, [{
			projectId: 'project-1',
			agentId: 'alpha',
			metadata: { cycle: 1 },
		}], 3);
		expect(resumed.map(({ agent }) => agent.slug)).toEqual(['beta', 'gamma', 'alpha']);
		expect(resumed[2]?.cycle).toBe(2);
	});
});
