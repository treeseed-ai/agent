import assert from 'node:assert/strict';
import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { appliedWorkdaySchema, assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { validateWorkdayIntent, type WorkdayIntent } from '@treeseed/sdk/operator-contracts';
import { collectCompleteEvidence } from './evidence-pages.ts';

// Read later pages only through the existing public events operation. Without
// a supplied reader an incomplete show still denies; no inferred terminal page.
export function verifyInitialStartCustody(observed: Row, assignments: Row[], readEvents?: (cursor: string, limit: number) => Row): void {
	const run = row(observed.run), id = String(run.id ?? '');
	const snapshot = observeCampaign(observed, id, new Map(), readEvents);
	const parameters = row(run.parameters), plan = appliedWorkdaySchema.parse(parameters.appliedPlan);
	const selection = parameters.decisionIds;
	if (selection !== undefined) assert.ok(Array.isArray(selection) && selection.length > 0
		&& selection.every(value => typeof value === 'string' && value.length > 0 && value === value.trim())
		&& new Set(selection).size === selection.length,
	'ACCEPTANCE_START_SELECTION: Explicit frozen decision inventory must be complete unique and exact');
	assert.equal(plan.id, id, 'ACCEPTANCE_START_ID: Applied plan differs from public run');
	assert.equal(plan.teamId, run.teamId, 'ACCEPTANCE_START_TEAM: Applied plan differs from public team');
	assert.equal(plan.executionMode, run.executionMode, 'ACCEPTANCE_START_MODE: Workday is the sole mode authority');
	assert.equal(Date.parse(plan.startsAt), Date.parse(String(run.startedAt)), 'ACCEPTANCE_START_CLOCK: Original start changed');
	assert.equal(Date.parse(plan.endsAt), Date.parse(plan.startsAt) + plan.policySnapshot.durationSeconds * 1000,
		'ACCEPTANCE_START_CLOCK: Original productive duration changed');
	assert.equal(Date.parse(String(parameters.deadlineAt)), Date.parse(plan.endsAt), 'ACCEPTANCE_START_CLOCK: Productive deadline drift');
	for (const [key, value] of Object.entries(plan.policySnapshot)) assert.deepEqual(parameters[key], value,
		`ACCEPTANCE_START_POLICY: Frozen ${key} differs from applied original authority`);
	assert.ok(Array.isArray(observed.events), 'ACCEPTANCE_START_EVENTS: Complete event history required');
	const events = snapshot.events, starts = events.filter(event => event.eventType === 'workday.started'), ready = events.filter(event => event.eventType === 'assignment.polling_ready');
	assert.ok(Array.isArray(parameters.scheduledProjectIds) && parameters.scheduledProjectIds.length > 0,
		'ACCEPTANCE_START_PROJECTS: Exact admitted project inventory required');
	assert.equal(starts.length, parameters.scheduledProjectIds.length, 'ACCEPTANCE_START_EVENTS: One start per selected project required');
	assert.equal(new Set(starts.map(event => event.projectId)).size, starts.length, 'ACCEPTANCE_START_EVENTS: Duplicate project start');
	assert.deepEqual(starts.map(event => event.projectId).sort(), [...parameters.scheduledProjectIds].sort());
	assert.equal(ready.length, 1, 'ACCEPTANCE_START_EVENTS: Exactly one polling-ready transition required');
	const readiness = ready[0]!;
	for (const event of starts) assert.ok(Number(event.eventIndex) < Number(readiness.eventIndex)
		&& Date.parse(String(event.createdAt)) <= Date.parse(String(readiness.createdAt)), 'ACCEPTANCE_START_EVENTS: Readiness preceded required start');
	assert.ok(assignments.length > 0, 'ACCEPTANCE_START_ATTEMPTS: Empty admission is not managed execution proof');
	for (const item of assignments) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(attempt.workdayId, id, 'ACCEPTANCE_START_ATTEMPT: Foreign frozen workday');
		assert.equal(attempt.teamId, plan.teamId, 'ACCEPTANCE_START_ATTEMPT: Foreign frozen team');
		assert.ok(parameters.scheduledProjectIds.includes(attempt.projectId), 'ACCEPTANCE_START_ATTEMPT: Unselected frozen project');
		if (Array.isArray(selection) && ['acting', 'reviewing'].includes(attempt.effectiveProfile.activity)) {
			const authority = attempt.authorityRefs.find(reference => reference.model === 'decision');
			assert.ok(authority && selection.includes(authority.id),
				'ACCEPTANCE_START_SELECTION: Governed acting or reviewing attempt escaped its original explicit Decision selection');
		}
		assert.ok(Date.parse(attempt.createdAt) >= Date.parse(String(readiness.createdAt))
			&& Date.parse(attempt.createdAt) >= Date.parse(plan.startsAt)
			&& Date.parse(attempt.deadline) <= Date.parse(plan.endsAt), 'ACCEPTANCE_START_ATTEMPT_CLOCK: Admission preceded readiness or widened original deadline');
	}
}
export function verifyRecurringStartCustody(observed: Row, assignments: Row[], schedule: Row, readEvents?: (cursor: string, limit: number) => Row): void {
	verifyInitialStartCustody(observed, assignments, readEvents);
	for (const [field, minimum] of [['cadenceSeconds', 60], ['stateVersion', 1]] as const)
		assert.ok(typeof schedule[field] === 'number' && Number.isInteger(schedule[field]) && schedule[field] >= minimum,
			'ACCEPTANCE_RECURRING_SCHEDULE: Canonical integer cadence and state version required');
	const run = row(observed.run), plan = appliedWorkdaySchema.parse(row(run.parameters).appliedPlan), intent = row(schedule.intent);
	assertIntentShape(intent);
	assert.deepEqual(validateWorkdayIntent(intent), [], 'ACCEPTANCE_RECURRING_INTENT: Complete canonical intent required');
	assert.equal(schedule.teamId, run.teamId); assert.equal(schedule.lastRunId, run.id, 'ACCEPTANCE_RECURRING_RUN: Exact recurring start must be independently linked');
	assert.equal(intent.teamId, run.teamId); assert.equal(intent.executionMode, run.executionMode, 'ACCEPTANCE_RECURRING_MODE: Canonical recurring mode drift');
	const duration = intent.endsAt === undefined ? intent.durationSeconds : (Date.parse(String(intent.endsAt)) - Date.parse(String(intent.startsAt))) / 1000;
	assert.equal(duration, plan.policySnapshot.durationSeconds, 'ACCEPTANCE_RECURRING_CLOCK: Recurrence changed the original intent duration');
	const projects = row(run.parameters).scheduledProjectIds;
	assert.ok(Array.isArray(projects));
	if (intent.projects !== 'all') { assert.ok(Array.isArray(intent.projects)); assert.deepEqual([...intent.projects].sort(), [...projects].sort()); }
}
function assertIntentShape(intent: Row): asserts intent is Row & WorkdayIntent {
	assert.equal(intent.schemaVersion, 'treeseed.workday-intent/v1');
	for (const field of ['teamId', 'profileId', 'startsAt']) assert.ok(typeof intent[field] === 'string' && intent[field].length > 0,
		'ACCEPTANCE_RECURRING_INTENT: Exact required identity or clock missing');
	assert.ok(intent.projects === 'all' || Array.isArray(intent.projects) && intent.projects.length > 0
		&& intent.projects.every(project => typeof project === 'string' && project.length > 0));
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_OBSERVATION: Missing or malformed record');
	return value as Row;
}
function text(value: unknown) {
	assert.ok(typeof value === 'string' && value.trim(), 'ACCEPTANCE_OBSERVATION: Missing exact identity or status');
	return value;
}

/** Acceptance-only custody of existing public workday records; not another event authority. */
export function observeCampaign(observed: unknown, workdayId: string, retained: Map<string, Row>, readEvents?: (cursor: string, limit: number) => Row) {
	const data = row(observed), run = row(data.run), scheduling = row(data.scheduling);
	assert.equal(run.id, workdayId, 'ACCEPTANCE_CAMPAIGN_ID: Read-back changed identity');
	assert.equal(scheduling.executionId, workdayId, 'ACCEPTANCE_OBSERVATION: Scheduling changed workday');
	assert.equal(scheduling.executionMode, run.executionMode, 'ACCEPTANCE_OBSERVATION: Scheduling changed mode');
	assert.equal(scheduling.status, run.status, 'ACCEPTANCE_OBSERVATION: Scheduling missing, stale or unavailable');
	let failedBoundary: `assignment_${'failed' | 'returned' | 'expired'}` | `graph_${'failed' | 'returned' | 'expired'}` | undefined;
	for (const [field, kind] of [['assignments', 'assignment'], ['nodes', 'graph']] as const) {
		const items = scheduling[field];
		assert.ok(Array.isArray(items), 'ACCEPTANCE_OBSERVATION: Scheduling rows unavailable');
		const keys = new Set<string>();
		for (const value of items) {
			const item = row(value), status = text(item.status);
			const key = kind === 'graph' ? `${text(item.kind)}:${status}` : status;
			assert.ok(!keys.has(key), 'ACCEPTANCE_OBSERVATION: Duplicate scheduling rows'); keys.add(key);
			assert.ok(typeof item.count === 'number' && Number.isSafeInteger(item.count) && item.count >= 0,
				'ACCEPTANCE_OBSERVATION: Malformed scheduling count');
			if (item.count > 0 && (status === 'failed' || status === 'returned' || status === 'expired'))
				failedBoundary ??= `${kind}_${status}`;
		}
	}
	const page = row(data.eventPage);
	assert.ok(typeof page.limit === 'number', 'ACCEPTANCE_OBSERVATION: Missing event page limit');
	const limit = page.limit;
	try { normalizeCapacityPageLimit(page.limit); } catch { assert.fail('ACCEPTANCE_OBSERVATION: Invalid event page limit'); }
	assert.equal(typeof page.hasMore, 'boolean', 'ACCEPTANCE_OBSERVATION: Incomplete event pagination');
	assert.ok(Array.isArray(data.events), 'ACCEPTANCE_OBSERVATION: Missing event observations');
	assert.ok(data.events.length <= page.limit, 'ACCEPTANCE_OBSERVATION: Event page exceeds declared limit');
	if (page.hasMore) assert.ok(readEvents, 'ACCEPTANCE_OBSERVATION: Incomplete event pagination without public reader');
	else assert.equal(page.nextCursor, null, 'ACCEPTANCE_OBSERVATION: Unconsumed event cursor');
	const events: unknown[] = page.hasMore ? collectCompleteEvidence(cursor => {
		if (cursor === undefined) return { items: data.events, page };
		assert.ok(readEvents, 'ACCEPTANCE_OBSERVATION: Public event reader required');
		return row(readEvents(cursor, limit));
	}, limit, 'ACCEPTANCE_OBSERVATION', 'ascending') : data.events;
	const current = new Map<string, Row>(), indexes = new Set<number>();
	for (const value of events) {
		const event = row(value), id = text(event.id);
		assert.equal(event.runId, workdayId, 'ACCEPTANCE_OBSERVATION: Foreign event workday');
		assert.equal(event.teamId, text(run.teamId), 'ACCEPTANCE_OBSERVATION: Foreign event team');
		text(event.eventType); text(event.status);
		assert.ok(Number.isFinite(Date.parse(text(event.createdAt))), 'ACCEPTANCE_OBSERVATION: Malformed event clock');
		assert.ok(typeof event.eventIndex === 'number' && Number.isSafeInteger(event.eventIndex) && event.eventIndex >= 0,
			'ACCEPTANCE_OBSERVATION: Malformed event index');
		assert.ok(!current.has(id) && !indexes.has(event.eventIndex), 'ACCEPTANCE_OBSERVATION: Duplicate event authority');
		for (const field of ['parameters', 'context', 'refs', 'metadata']) row(event[field]);
		assert.ok(event.status !== 'failed' && event.status !== 'error', 'ACCEPTANCE_OBSERVATION: Historical failed event');
		current.set(id, event); indexes.add(event.eventIndex);
	}
	assert.deepEqual([...indexes].sort((a, b) => a - b), Array.from({ length: indexes.size }, (_, i) => i),
		'ACCEPTANCE_OBSERVATION: Missing event transition');
	for (const [id, previous] of retained) assert.deepEqual(current.get(id), previous,
		'ACCEPTANCE_OBSERVATION: Previously observed event mutated or disappeared');
	assert.ok(run.status !== 'completed' || !failedBoundary, 'ACCEPTANCE_OBSERVATION: Completed run hides failed scheduling');
	for (const [id, event] of current) retained.set(id, structuredClone(event));
	return { run, failedBoundary, events: [...current.values()] };
}
