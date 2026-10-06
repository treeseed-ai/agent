import assert from 'node:assert/strict';
import test from 'node:test';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';
import { verifyInitialStartCustody, verifyRecurringStartCustody } from './support/campaign-observation.ts';

function actualStart() {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_START_WORKDAY: Exact real managed run required');
	const observed = read(['workdays', 'show', id], team), run = row(observed.run);
	return { id, team, observed, assignments: readWorkdayAssignments(id, String(run.startedAt), team) };
}
test('Actual workday start retains exact applied policy original clocks and complete native readiness before every frozen attempt', { timeout: 120_000 }, () => {
	const f = actualStart(); verifyInitialStartCustody(f.observed, f.assignments);
	assert.deepEqual(read(['workdays', 'show', f.id], f.team), f.observed);
	assert.deepEqual(readWorkdayAssignments(f.id, String(row(f.observed.run).startedAt), f.team), f.assignments);
	verifyGolden('settlement'); verifyGolden('reporter');
});
test('Actual recurring start independently links unchanged canonical intent to the same managed execution and settled readback', { timeout: 120_000 }, () => {
	const f = actualStart(), listed = read(['workdays', 'schedules', 'list'], f.team);
	assert.ok(Array.isArray(listed.items), 'ACCEPTANCE_RECURRING_SCHEDULES: Public schedule inventory required');
	assert.equal(listed.cursor, null, 'ACCEPTANCE_RECURRING_SCHEDULES: Incomplete schedule inventory');
	const schedules = listed.items.map(row).filter(schedule => schedule.lastRunId === f.id);
	assert.equal(schedules.length, 1, 'ACCEPTANCE_RECURRING_SCHEDULES: Exactly one actual recurring owner required');
	verifyRecurringStartCustody(f.observed, f.assignments, schedules[0]!);
	assert.deepEqual(read(['workdays', 'schedules', 'list'], f.team), listed);
	assert.deepEqual(read(['workdays', 'show', f.id], f.team), f.observed);
	verifyGolden('settlement'); verifyGolden('reporter');
});
