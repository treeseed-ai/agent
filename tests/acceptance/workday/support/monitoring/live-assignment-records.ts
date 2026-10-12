import assert from 'node:assert/strict';
import { assignmentAttemptSchema, executionNodeSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import { verifyAssignmentAuthority, verifyGovernedProfile, verifyHandlerInspection } from '../assignment-authority.ts';
import { readGovernedContentFile } from '../decision-evidence.ts';
import { verifyAppliedWorkdayCustody, verifyDerivedWorkdayModes } from '../campaign-observation.ts';
import { verifyGraphProvenance } from '../evidence-pages.ts';

const issuedAuthority = ({ status: _status, startedAt: _started, finishedAt: _finished, ...value }: Row) => value;

/** A matching list/show pair cannot establish independent graph authority. */
export function verifyLiveAssignmentGraph(item: Row, graph: Row): void {
	const code = 'ACCEPTANCE_LIVE_GRAPH', attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	assert.equal(graph.teamId, attempt.teamId, `${code}: Foreign graph`);
	assert.ok(Number.isSafeInteger(graph.revision) && graph.revision >= attempt.graphRevision,
		`${code}: Original issued graph revision is missing or in the future`);
	assert.ok(Array.isArray(graph.nodes), `${code}: Complete owning graph required`);
	const matches = graph.nodes.filter((node: Row) => node?.id === attempt.nodeId);
	assert.equal(matches.length, 1, `${code}: Unique independent owning node required`);
	const parsed = executionNodeSchema.safeParse(matches[0]);
	assert.ok(parsed.success, `${code}: Canonical independent owning node required`);
	const node = parsed.data;
	assert.deepEqual(node, matches[0], `${code}: Original graph node must not be normalized`);
	for (const field of ['teamId', 'projectId', 'nodeRevision', 'agentClass', 'workItemId', 'sourceRef', 'authorityRefs',
		'estimate', 'requiredCapabilities', 'acceptanceCriteria'] as const)
		assert.deepEqual(node[field], attempt[field], `${code}: Issued ${field} differs from independent graph`);
	if (node.workdayId !== undefined) assert.equal(node.workdayId, attempt.workdayId, `${code}: Foreign node workday`);
	assert.equal(node.kind, attempt.effectiveProfile.activity === 'chat' ? 'communication' : attempt.effectiveProfile.activity,
		`${code}: Activity differs from graph authority`);
	assert.equal(node.workspace, attempt.workspace.mode, `${code}: Workspace differs from graph authority`);
	assert.ok(node.graphRevisionCreated <= attempt.graphRevision && node.graphRevisionUpdated <= graph.revision,
		`${code}: Node does not belong to the original issued graph history`);
	verifyGraphProvenance(graph);
}

export function inspectLiveAssignmentProfile(item: Row, team: string): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
	const shown = read(['assignments', 'show', attempt.id], team);
	assert.ok(validateProviderAssignment(shown).ok, 'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public record is malformed');
	assert.deepEqual(issuedAuthority(row(shown.assignmentAttempt)), issuedAuthority(attempt),
		'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public view changed issued authority');
	const graph = read(['execution', 'graph', 'show'], team);
	verifyLiveAssignmentGraph(item, graph);
	verifyGovernedProfile(item, readGovernedContentFile(profile.profileRef, attempt.projectId, team, new Map(), 'ACCEPTANCE_LIVE_PROFILE'), graph);
	const catalog = read(['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local'], team, true);
	const selected = read(['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local'], team, true);
	verifyHandlerInspection(item, catalog, selected);
	verifyLiveAssignmentGraph(item, read(['execution', 'graph', 'show'], team));
}

/** Observe the existing canonical records before campaign progress. This is
 * record/profile/grant custody. Public graph inspection is mandatory for each
 * new record; provider completeness remains a separate owning observation. */
export function observeLiveAssignmentRecords(run: Row, items: readonly Row[], retained: Map<string, Row>, inspect: (item: Row) => void): void {
	const label = 'ACCEPTANCE_LIVE_ASSIGNMENT';
	assert.ok(typeof run.id === 'string' && run.id && typeof run.teamId === 'string' && run.teamId, `${label}: Exact workday and team required`);
	assert.equal(run.executionMode, 'simulation', `${label}: Workday is the sole mode authority`);
	const plan = verifyAppliedWorkdayCustody(run), workdayEnd = Date.parse(plan.endsAt);
	const started = Date.parse(String(run.startedAt)), projects = row(run.parameters).scheduledProjectIds;
	assert.ok(Number.isFinite(started) && Array.isArray(projects) && projects.length > 0
		&& projects.every(value => typeof value === 'string' && value) && new Set(projects).size === projects.length,
		`${label}: Original start and complete admitted project selection required`);
	const observed = new Map<string, Row>(), pending: Row[] = [];
	verifyDerivedWorkdayModes(run, items);
	for (const item of items) {
		assert.ok(validateProviderAssignment(item).ok, `${label}: Complete unchanged canonical public record required`);
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.ok(!observed.has(attempt.id), `${label}: Duplicate attempt identity`);
		assert.equal(attempt.workdayId, run.id, `${label}: Foreign workday`);
		assert.equal(attempt.teamId, run.teamId, `${label}: Foreign team`);
		assert.ok(projects.includes(attempt.projectId), `${label}: Unselected project`);
		const created = Date.parse(attempt.createdAt), deadline = Date.parse(attempt.deadline);
		assert.ok(created >= started && deadline > created, `${label}: Original admission clock required`);
		assert.ok(deadline <= workdayEnd, `${label}: Original workday deadline cannot be extended`);
		const executionStart = attempt.startedAt === undefined ? created : Date.parse(attempt.startedAt);
		assert.ok(executionStart >= created && (attempt.finishedAt === undefined || Date.parse(attempt.finishedAt) >= executionStart),
			`${label}: Original lifecycle clock order required`);
		// Late failed closeout remains observed truth; this does not move or
		// extend the original execution deadline or permit campaign progress.
		verifyAssignmentAuthority(item);
		const previous = retained.get(attempt.id);
		if (previous) {
			// API alone advances these lifecycle fields. Every issued authority
			// field, including estimates, limits, runtime and deadline, is fixed.
			assert.deepEqual(issuedAuthority(attempt), issuedAuthority(previous), `${label}: Issued authority changed`);
			const active = ['created', 'leased', 'running'], prior = active.indexOf(String(previous.status)), next = active.indexOf(attempt.status);
			assert.ok(prior < 0 ? attempt.status === previous.status : next < 0 || next >= prior,
				`${label}: Lifecycle status regressed or changed terminal disposition`);
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
