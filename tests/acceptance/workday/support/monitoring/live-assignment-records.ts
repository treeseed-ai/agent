import assert from 'node:assert/strict';
import { assignmentAttemptSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import { verifyAssignmentAuthority, verifyGovernedProfile, verifyHandlerInspection } from '../assignment-authority.ts';
import { readGovernedContentFile } from '../decision-evidence.ts';

const issuedAuthority = ({ status: _status, startedAt: _started, finishedAt: _finished, ...value }: Row) => value;

export function inspectLiveAssignmentProfile(item: Row, team: string): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
	const shown = read(['assignments', 'show', attempt.id], team);
	assert.ok(validateProviderAssignment(shown).ok, 'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public record is malformed');
	assert.deepEqual(issuedAuthority(row(shown.assignmentAttempt)), issuedAuthority(attempt),
		'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public view changed issued authority');
	verifyGovernedProfile(item, readGovernedContentFile(profile.profileRef, attempt.projectId, team, new Map(), 'ACCEPTANCE_LIVE_PROFILE'));
	const catalog = read(['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local'], team, true);
	const selected = read(['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local'], team, true);
	verifyHandlerInspection(item, catalog, selected);
}

/** Observe the existing canonical records before campaign progress. This is
 * record/profile/grant custody, not proof of graph or provider completeness. */
export function observeLiveAssignmentRecords(run: Row, items: readonly Row[], retained: Map<string, Row>, inspect: (item: Row) => void): void {
	const label = 'ACCEPTANCE_LIVE_ASSIGNMENT';
	assert.ok(typeof run.id === 'string' && run.id && typeof run.teamId === 'string' && run.teamId, `${label}: Exact workday and team required`);
	assert.equal(run.executionMode, 'simulation', `${label}: Workday is the sole mode authority`);
	const started = Date.parse(String(run.startedAt)), projects = row(run.parameters).scheduledProjectIds;
	assert.ok(Number.isFinite(started) && Array.isArray(projects) && projects.length > 0
		&& projects.every(value => typeof value === 'string' && value) && new Set(projects).size === projects.length,
		`${label}: Original start and complete admitted project selection required`);
	const observed = new Map<string, Row>(), pending: Row[] = [];
	for (const item of items) {
		assert.ok(validateProviderAssignment(item).ok, `${label}: Complete unchanged canonical public record required`);
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.ok(!observed.has(attempt.id), `${label}: Duplicate attempt identity`);
		assert.equal(attempt.workdayId, run.id, `${label}: Foreign workday`);
		assert.equal(attempt.teamId, run.teamId, `${label}: Foreign team`);
		assert.ok(projects.includes(attempt.projectId), `${label}: Unselected project`);
		const created = Date.parse(attempt.createdAt), deadline = Date.parse(attempt.deadline);
		assert.ok(created >= started && deadline > created, `${label}: Original admission clock required`);
		verifyAssignmentAuthority(item);
		const previous = retained.get(attempt.id);
		if (previous) {
			// API alone advances these lifecycle fields. Every issued authority
			// field, including estimates, limits, runtime and deadline, is fixed.
			assert.deepEqual(issuedAuthority(attempt), issuedAuthority(previous), `${label}: Issued authority changed`);
			for (const field of ['startedAt', 'finishedAt']) if (previous[field] !== undefined)
				assert.equal(attempt[field as 'startedAt' | 'finishedAt'], previous[field], `${label}: Original lifecycle clock changed`);
		} else pending.push(item);
		observed.set(attempt.id, structuredClone(attempt));
	}
	for (const id of retained.keys()) assert.ok(observed.has(id), `${label}: Previously observed attempt disappeared`);
	// A denied later record or public inspection must preserve the entire prior
	// observation. Do not repair inputs or cache a partly verified new batch.
	for (const item of pending) inspect(item);
	for (const [id, attempt] of observed) retained.set(id, attempt);
}
