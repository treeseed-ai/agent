import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { acceptanceWorkdayId, read, row, type Row } from '../acceptance-cli.ts';
import { readGovernedContentFile } from './support/decision-evidence.ts';
import { verifyGovernedProfile, verifyHandlerInspection } from './support/assignment-authority.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';

function evidence() {
	const id = acceptanceWorkdayId();
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_PROFILE_WORKDAY: Actual exact workday required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed', run = row(read(['workdays', 'show', id], team).run);
	assert.equal(run.id, id); assert.equal(run.executionMode, 'simulation');
	const assignments = readWorkdayAssignments(id, String(run.startedAt), team);
	assert.ok(assignments.length > 0, 'ACCEPTANCE_PROFILE_EMPTY: Empty assignments cannot prove configured profiles');
	return { id, team, run, assignments };
}
test('Actual completed project-owned handler retains its exact governed selection canonical result and settled managed history through independent public reads', { timeout: 120_000 }, () => {
	const f = evidence(), before = structuredClone(f), selected = f.assignments.filter(item =>
		assignmentAttemptSchema.parse(item.assignmentAttempt).effectiveProfile.handlerOrigin === 'project-runtime');
	assert.ok(selected.length > 0, 'ACCEPTANCE_PROJECT_HANDLER_EMPTY: Actual project-owned execution required, not a default-handler golden substitute');
	assert.ok(selected.some(item => item.status === 'completed'), 'ACCEPTANCE_PROJECT_HANDLER_COMPLETION: Actual completed project-owned result required');
	const cache = new Map<string, Row>(), observations: Array<{ args: string[]; value: Row }> = [];
	for (const item of selected) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
		assert.ok(profile.handler.includes('/')); assert.match(attempt.provider.runtimeBuild, /^sha256:[a-f0-9]{64}$/u);
		verifyGovernedProfile(item, readGovernedContentFile(profile.profileRef, attempt.projectId, f.team, cache, 'ACCEPTANCE_PROJECT_HANDLER_PROFILE'));
		const listArgs = ['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local'];
		const showArgs = ['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local'];
		const catalog = read(listArgs, f.team, true), shown = read(showArgs, f.team, true); verifyHandlerInspection(item, catalog, shown);
		observations.push({ args: listArgs, value: catalog }, { args: showArgs, value: shown });
		if (item.status === 'completed') {
			const result = assignmentResultSchema.parse(item.assignmentResult);
			assert.equal(result.status, 'completed'); assert.equal(result.assignmentId, attempt.id);
			assert.ok(Date.parse(result.completedAt) >= Date.parse(attempt.createdAt) && Date.parse(result.completedAt) <= Date.parse(attempt.deadline),
				'ACCEPTANCE_PROJECT_HANDLER_CLOCK: Original exact assigned execution window required');
		}
		assert.deepEqual(read(['assignments', 'show', attempt.id], f.team), item);
	}
	verifyGolden('settlement'); verifyGolden('reporter'); verifyGolden('stopped');
	for (const observed of observations) assert.deepEqual(read(observed.args, f.team, true), observed.value);
	const again = new Map<string, Row>();
	for (const item of selected) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		verifyGovernedProfile(item, readGovernedContentFile(attempt.effectiveProfile.profileRef, attempt.projectId, f.team, again, 'ACCEPTANCE_PROJECT_HANDLER_REPEAT'));
	}
	assert.deepEqual(evidence(), before); assert.deepEqual(f, before);
	// Actual governed selection/result/accounting custody, NOT an independent
	// source-to-selected-guest-build hash or executable handler-code observation.
});
test('Every actual assignment matches independently read exact governed profile bytes handler prompt parameters and narrower grants', { timeout: 120_000 }, () => {
	const f = evidence(), cache = new Map<string, Row>();
	for (const item of f.assignments) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		const file = readGovernedContentFile(attempt.effectiveProfile.profileRef, attempt.projectId, f.team, cache, 'ACCEPTANCE_PROFILE');
		verifyGovernedProfile(item, file);
	}
	assert.deepEqual(readWorkdayAssignments(f.id, String(f.run.startedAt), f.team), f.assignments);
});
test('Public assignment views preserve whole canonical attempts results and original authority across repeated readback', { timeout: 120_000 }, () => {
	const f = evidence();
	for (const item of f.assignments) {
		const frozen = assignmentAttemptSchema.parse(item.assignmentAttempt);
		for (let repetition = 0; repetition < 2; repetition++) {
			const observed = read(['assignments', 'show', frozen.id], f.team);
			assert.equal(observed.id, frozen.id, 'ACCEPTANCE_ASSIGNMENT_PUBLIC: Exact owning response required');
			assert.deepEqual(assignmentAttemptSchema.parse(observed.assignmentAttempt), frozen);
			if (item.assignmentResult) assert.deepEqual(assignmentResultSchema.parse(observed.assignmentResult), assignmentResultSchema.parse(item.assignmentResult));
			assert.equal(observed.attemptCount, frozen.attempt); assert.equal(observed.workDayId, frozen.workdayId);
			assert.equal(observed.reservationId, frozen.reservationId); assert.equal(observed.projectId, frozen.projectId);
		}
	}
});
test('Actual governed handlers remain inspectable through exact public list and show without changing frozen execution authority or profile bytes', { timeout: 120_000 }, () => {
	const f = evidence(), cache = new Map<string, Row>(), catalogs = new Map<string, Row>(), selected = new Map<string, Row>();
	const before = structuredClone(f);
	for (const item of f.assignments) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
		verifyGovernedProfile(item, readGovernedContentFile(profile.profileRef, attempt.projectId, f.team, cache, 'ACCEPTANCE_HANDLER_PROFILE'));
		if (!catalogs.has(attempt.projectId)) catalogs.set(attempt.projectId, read(['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local'], f.team, true));
		const key = JSON.stringify([attempt.projectId, profile.handler]);
		if (!selected.has(key)) selected.set(key, read(['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local'], f.team, true));
		verifyHandlerInspection(item, catalogs.get(attempt.projectId)!, selected.get(key)!);
	}
	for (const [projectId, catalog] of catalogs) assert.deepEqual(read(['agents', 'handlers', 'list', '--project', projectId, '--server', 'local'], f.team, true), catalog);
	for (const [key, handler] of selected) { const [projectId, handlerId] = JSON.parse(key);
		assert.deepEqual(read(['agents', 'handlers', 'show', handlerId, '--project', projectId, '--server', 'local'], f.team, true), handler); }
	const reread = new Map<string, Row>();
	for (const item of f.assignments) { const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		verifyGovernedProfile(item, readGovernedContentFile(attempt.effectiveProfile.profileRef, attempt.projectId, f.team, reread, 'ACCEPTANCE_HANDLER_PROFILE_REPEAT')); }
	assert.deepEqual(readWorkdayAssignments(f.id, String(f.run.startedAt), f.team), f.assignments);
	assert.deepEqual(row(read(['workdays', 'show', f.id], f.team).run), f.run); assert.deepEqual(f, before);
});
