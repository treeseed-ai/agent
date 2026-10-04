import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { request } from '../provider-kernel-fixture.ts';
import { verifyInitialStartCustody, verifyRecurringStartCustody } from '../../../acceptance/workday/campaign-observation.ts';
import { state } from './golden-readback-fixture.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';

function suppliedStart() {
	const original = request().assignment.assignmentAttempt;
	if (!original) throw new Error('Whole canonical attempt fixture required');
	const plan = compileWorkday({ id: 'workday-1', teamId: 'team-1', executionMode: 'simulation', policyId: 'default', policyRevision: 1,
		policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 60 }, startsAt: '2026-09-13T12:00:00.000Z', agentIds: ['configured/renamed-planner'] });
	const attempt = assignmentAttemptSchema.parse({ ...original, deadline: '2026-09-13T12:00:30.000Z' });
	const event = (id: string, eventType: string, eventIndex: number, projectId: string | null) => ({ id, eventType, eventIndex, projectId,
		runId: plan.id, teamId: plan.teamId, status: 'recorded', createdAt: plan.startsAt, parameters: {}, context: {}, refs: {}, metadata: {} });
	const events = [event('start', 'workday.started', 0, 'project-1'), event('ready', 'assignment.polling_ready', 1, null)];
	const observed: Row = { run: { id: plan.id, teamId: plan.teamId, executionMode: plan.executionMode, status: 'running', startedAt: plan.startsAt,
		parameters: { ...plan.policySnapshot, deadlineAt: plan.endsAt, scheduledProjectIds: ['project-1'], appliedPlan: { ...plan, state: 'active' } } },
		scheduling: { executionId: plan.id, executionMode: plan.executionMode, status: 'running', assignments: [], nodes: [] },
		events,
		eventPage: { limit: 50, hasMore: false, nextCursor: null } };
	const assignments: Row[] = [{ id: attempt.id, assignmentAttempt: attempt }];
	const schedule: Row = { id: 'schedule-1', teamId: plan.teamId, lastRunId: plan.id, intent: { schemaVersion: 'treeseed.workday-intent/v1',
		teamId: plan.teamId, profileId: 'default', projects: ['project-1'], executionMode: 'simulation', startsAt: plan.startsAt, durationSeconds: 60 } };
	return { observed, assignments, schedule, events };
}
// UNIT of the actual native read-back assertions. Supplied DTOs are not an
// independently captured real start receipt, event producer or live execution.
describe('managed initial manual and recurring start custody', () => {
	it('accepts complete supplied canonical policy readiness and frozen attempts without rewriting evidence', () => {
		const f = suppliedStart(), before = structuredClone(f); expect(() => verifyInitialStartCustody(f.observed, f.assignments)).not.toThrow();
		expect(() => verifyRecurringStartCustody(f.observed, f.assignments, f.schedule)).not.toThrow(); expect(f).toEqual(before);
		row(row(f.observed.run).parameters).decisionIds = ['decision-1'];
		const selected = structuredClone(f); expect(() => verifyInitialStartCustody(f.observed, f.assignments)).not.toThrow();
		expect(f).toEqual(selected);
	});
	it('denies missing foreign widened or contradictory applied plan mode clock and policy authority', () => {
		const modes = ['missing', 'foreign', 'mode', 'deadline', 'duration', 'policy'];
		const outcomes = modes.map(mode => { const f = suppliedStart(), parameters = row(row(f.observed.run).parameters), plan = row(parameters.appliedPlan);
			if (mode === 'missing') delete parameters.appliedPlan;
			if (mode === 'foreign') plan.id = 'foreign';
			if (mode === 'mode') plan.executionMode = 'production';
			if (mode === 'deadline') parameters.deadlineAt = '2099-09-13T12:00:00.000Z';
			if (mode === 'duration') plan.endsAt = '2026-09-13T12:01:01.000Z';
			if (mode === 'policy') parameters.maximumConcurrency = 2;
			try { verifyInitialStartCustody(f.observed, f.assignments); return 'admitted'; } catch { return 'denied'; }
		}); expect(outcomes).toEqual(modes.map(() => 'denied'));
	});
	it('denies missing duplicate foreign partial and out-of-order start readiness events instead of trusting a running disposition', () => {
		const modes = ['missing', 'duplicate', 'foreign', 'partial', 'order'], outcomes = modes.map(mode => {
			const f = suppliedStart();
			if (mode === 'missing') f.observed.events = [];
			if (mode === 'duplicate') f.events.push({ ...f.events[1]!, id: 'duplicate', eventIndex: 2 });
			if (mode === 'foreign') f.events[0]!.projectId = 'foreign';
			if (mode === 'partial') f.observed.eventPage = { limit: 50, hasMore: true, nextCursor: 'unconsumed' };
			if (mode === 'order') { f.events[0]!.eventIndex = 1; f.events[1]!.eventIndex = 0; }
			try { verifyInitialStartCustody(f.observed, f.assignments); return 'admitted'; } catch { return 'denied'; }
		}); expect(outcomes).toEqual(modes.map(() => 'denied'));
	});
	it('denies empty foreign pre-readiness and widened immutable attempts with original supplied inputs retained', () => {
		const modes = ['empty', 'workday', 'team', 'project', 'clock', 'deadline'], outcomes = modes.map(mode => {
			const f = suppliedStart(), attempt = row(f.assignments[0]!.assignmentAttempt);
			if (mode === 'empty') f.assignments = [];
			if (mode === 'workday') attempt.workdayId = 'foreign';
			if (mode === 'team') attempt.teamId = 'foreign';
			if (mode === 'project') attempt.projectId = 'foreign';
			if (mode === 'clock') attempt.createdAt = '2026-09-13T11:59:59.999Z';
			if (mode === 'deadline') attempt.deadline = '2099-09-13T12:00:00.000Z';
			const before = structuredClone(f); let admitted = false; try { verifyInitialStartCustody(f.observed, f.assignments); admitted = true; } catch { /* Supplied negative mutation. */ }
			expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(modes.map(() => false));
		for (const selection of [null, [], 'decision-1', ['decision-1', 'decision-1'], ['decision-1', ''], [' decision-1 '], ['foreign-decision']]) {
			const f = suppliedStart(); row(row(f.observed.run).parameters).decisionIds = selection;
			const before = structuredClone(f); expect(() => verifyInitialStartCustody(f.observed, f.assignments)).toThrow('ACCEPTANCE_START_SELECTION');
			expect(f).toEqual(before);
		}
		for (const variant of ['missing-decision', 'foreign-decision']) {
			const f = suppliedStart(); row(row(f.observed.run).parameters).decisionIds = ['decision-1'];
			const attempt = row(f.assignments[0]!.assignmentAttempt);
			attempt.authorityRefs = variant === 'missing-decision' ? [structuredClone(row(attempt.sourceRef))]
				: [{ store: 'treedx', model: 'decision', id: variant, revision: 1, digest: `sha256:${'c'.repeat(64)}` }];
			const before = structuredClone(f); expect(() => verifyInitialStartCustody(f.observed, f.assignments)).toThrow('ACCEPTANCE_START_SELECTION');
			expect(f).toEqual(before);
		}
	});
	it('denies foreign conflicting or malformed recurring intent while retaining ordinary manual start and exact-duration recurrence', () => {
		const modes = ['foreign', 'mode', 'duration', 'project', 'malformed'], outcomes = modes.map(mode => {
			const f = suppliedStart(), intent = row(f.schedule.intent);
			if (mode === 'foreign') f.schedule.lastRunId = 'other-run';
			if (mode === 'mode') intent.executionMode = 'production';
			if (mode === 'duration') intent.durationSeconds = 61;
			if (mode === 'project') intent.projects = ['foreign'];
			if (mode === 'malformed') f.schedule.intent = {};
			try { verifyRecurringStartCustody(f.observed, f.assignments, f.schedule); return 'admitted'; } catch { return 'denied'; }
		}); expect(outcomes).toEqual(modes.map(() => 'denied'));
		expect(state.cases.has('Actual workday start retains exact applied policy original clocks and complete native readiness before every frozen attempt')).toBe(true);
		expect(state.cases.has('Actual recurring start independently links unchanged canonical intent to the same managed execution and settled readback')).toBe(true);
	});
});
