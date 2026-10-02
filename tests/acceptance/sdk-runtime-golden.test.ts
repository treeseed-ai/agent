import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentReferenceSchema, assignmentTimingAwarenessReceiptSchema, estimateSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from './acceptance-cli.ts';
import { readDecisionContent, verifyDecisionContent } from './workday/decision-evidence.ts';
import { verifyAssignmentAuthority } from './workday/assignment-authority.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

// Each exact test is independently selectable by the existing guarantee runner.
// These read-back gates do not stand in for campaign orchestration or external-state proof.
const gates = ['lifecycle', 'collaboration', 'graph', 'revision', 'results', 'settlement', 'reporter', 'stopped'] as const;
type Gate = typeof gates[number];
function verifyAllocation(item: Row): void {
	const attempt = row(item.assignmentAttempt), envelope = row(item.capacityEnvelope);
	const allocation = row(row(row(item.explanation).metadata).allocation), calibration = row(allocation.calibration);
	const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
	const estimate = estimateSchema.safeParse(attempt.estimate);
	assert.ok(estimate.success, 'ACCEPTANCE_ALLOCATION_ESTIMATE: Exact expected/maximum estimate required');
	assert.ok(allocation.admitted === true && Number.isInteger(allocation.allocatedSeconds) && Number(allocation.allocatedSeconds) > 0,
		'ACCEPTANCE_ALLOCATION_RECEIPT: Successful positive immutable allocation required');
	const allocated = Number(allocation.allocatedSeconds), desired = Number(allocation.desiredSeconds);
	assert.ok(Number.isInteger(allocation.desiredSeconds) && desired > 0 && allocated <= desired,
		'ACCEPTANCE_ALLOCATION_DURATION: Allocation must be bounded by its calibrated task duration');
	assert.equal(row(attempt.limits).maximumSeconds, allocated, 'ACCEPTANCE_ALLOCATION_LIMIT: Immutable attempt limit drifted');
	assert.equal(envelope.requestedSeconds, allocated, 'ACCEPTANCE_ALLOCATION_RESERVATION: Requested authority drifted');
	assert.equal(envelope.reservedSeconds, allocated, 'ACCEPTANCE_ALLOCATION_RESERVATION: Reserved authority drifted');
	assert.ok(Array.isArray(allocation.constraints) && allocation.constraints.length > 0,
		'ACCEPTANCE_ALLOCATION_CONSTRAINTS: Original hard ceilings required');
	const constraints = rows(allocation.constraints);
	assert.equal(new Set(constraints.map(value => value.id)).size, constraints.length, 'ACCEPTANCE_ALLOCATION_CONSTRAINTS: Duplicate ceiling authority');
	for (const constraint of constraints) assert.ok(text(constraint.id) && finite(constraint.remainingSeconds)
		&& Number(constraint.remainingSeconds) >= 0 && allocated <= Math.floor(Number(constraint.remainingSeconds)),
		'ACCEPTANCE_ALLOCATION_CONSTRAINTS: Invalid or exceeded ceiling');
	const minimum = [...constraints].sort((a, b) => Number(a.remainingSeconds) - Number(b.remainingSeconds) || text(a.id).localeCompare(text(b.id)))[0]!;
	assert.equal(allocation.limitingConstraint, allocated < desired ? minimum.id : 'task-duration', 'ACCEPTANCE_ALLOCATION_CONSTRAINTS: Limiting authority mismatch');
	assert.ok(finite(calibration.multiplier) && calibration.multiplier > 0 && calibration.seconds === desired
		&& Math.ceil(estimate.data.expectedSeconds * calibration.multiplier) === desired,
		'ACCEPTANCE_ALLOCATION_CALIBRATION: Finite normalized calibration required');
	assert.ok(Array.isArray(calibration.measurementIds) && calibration.measurementIds.length <= 20
		&& calibration.measurementIds.every(id => typeof id === 'string' && id.length > 0)
		&& new Set(calibration.measurementIds).size === calibration.measurementIds.length,
		'ACCEPTANCE_ALLOCATION_CALIBRATION: At most twenty unique exact sample identities required');
	if (calibration.measurementIds.length === 0) assert.equal(desired, estimate.data.maximumSeconds, 'ACCEPTANCE_ALLOCATION_CALIBRATION: Cold start must preserve the maximum estimate');
	const opportunity = row(allocation.opportunity);
	for (const field of ['shareSeconds', 'availableSeconds', 'remainingSupplySeconds', 'committedSeconds', 'planningCommittedSeconds']) {
		assert.ok(finite(opportunity[field]) && Number(opportunity[field]) >= 0, 'ACCEPTANCE_ALLOCATION_SUPPLY: Finite weighted supply required');
	}
	assert.ok(finite(opportunity.weight) && opportunity.weight > 0 && finite(opportunity.totalEligibleWeight)
		&& opportunity.totalEligibleWeight >= opportunity.weight && allocated <= Number(opportunity.availableSeconds)
		&& Number(opportunity.availableSeconds) <= Number(opportunity.shareSeconds)
		&& Number(opportunity.shareSeconds) <= Number(opportunity.remainingSupplySeconds)
		&& Number(opportunity.planningCommittedSeconds) <= Number(opportunity.committedSeconds), 'ACCEPTANCE_ALLOCATION_SUPPLY: Weighted supply authority exceeded');
}
function phaseBoundaryCancelled(item: Row, run: Row): boolean {
	const parameters = row(run.parameters), time = row(row(row(item.capacityEnvelope).budget).time);
	const boundary = Date.parse(text(run.startedAt)) + Number(parameters.durationSeconds) * Number(parameters.planningPercent) * 10;
	return Number.isFinite(boundary) && item.status === 'cancelled' && item.lifecycleCode === 'planning_boundary_cancelled'
		&& ['planning','estimating'].includes(text(row(row(item.assignmentAttempt).effectiveProfile).activity))
		&& Date.parse(text(time.authorityDeadlineAt)) === boundary
		&& Date.parse(text(time.executionDeadlineAt ?? time.preparationDeadlineAt)) === boundary
		&& Date.parse(text(item.failedAt)) >= boundary
		&& row(row(item.lifecycleOutput).performance).disposition === 'cancelled';
}
export function readWorkdayAssignments(workdayId: string, startedAt: string, team: string): Row[] {
	const assignments: Row[] = [];
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const page = read(['assignments', 'list', '--limit', '50', ...(cursor ? ['--cursor', cursor] : [])], team);
		const items = rows(page.items);
		assignments.push(...items.filter(item => item.workDayId === workdayId));
		const pageInfo = row(page.page);
		if (!pageInfo.hasMore || items.every(item => text(item.createdAt) < startedAt)) break;
		cursor = text(pageInfo.nextCursor);
		assert.ok(cursor, 'Assignment pagination omitted its cursor');
		assert.ok(pageNumber < 39, 'Complete assignment evidence was not reached');
	}
	assert.ok(assignments.length > 0, 'No real assignment evidence');
	assert.equal(new Set(assignments.map(item => item.id)).size, assignments.length);
	return assignments;
}
export function verifyGolden(gate: Gate): void {
	const workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	assert.ok(workdayId.startsWith('workday-'), 'Explicit real workday ID is required; no fixture or skipped pass is allowed');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const workday = read(['workdays', 'show', workdayId], team);
	const run = row(workday.run), parameters = row(run.parameters);
	if (gate === 'lifecycle') {
	assert.equal(run.status, 'completed', 'An active, cancelled or failed workday is not accepted');
	assert.equal(run.executionMode, 'simulation');
	assert.equal(parameters.durationSeconds, 3600);
	assert.equal(parameters.planningPercent, 100 / 3);
	assert.ok(parameters.maximumConcurrency === 5 && parameters.communicationConcurrency === 5,
		'ACCEPTANCE_CONCURRENCY_POLICY: Golden requires its exact five-slot policy without increased allowances');
	assert.equal(parameters.allocationWeight, 1);
	assert.equal(parameters.planningTurnMaximumSeconds, 180);
	assert.ok(text(run.startedAt) && text(run.completedAt), 'Terminal timestamps are required');
	}
	assert.equal(run.executionMode, 'simulation', 'Every gate requires authoritative simulation custody');
	const assignments = readWorkdayAssignments(workdayId, text(run.startedAt), team);
	if (['lifecycle', 'graph', 'revision', 'results', 'reporter'].includes(gate)) for (const item of assignments) verifyAssignmentAuthority(item);
	let cursor: string | undefined;
	if (gate === 'lifecycle') for (const item of assignments) {
		verifyAllocation(item);
		assert.ok(item.status === 'completed' || phaseBoundaryCancelled(item,run),
			`Normal golden cannot contain a failed, returned, expired or non-phase cancelled assignment: ${text(item.id)}`);
		assert.equal(item.leaseToken, null, `Live lease remains for ${text(item.id)}`);
		assert.equal(row(row(item.lifecycleOutput).teardown).verified, true, `Durable teardown missing for ${text(item.id)}`);
	}
	const completed = assignments.filter(item => item.status === 'completed');
	if (gate === 'lifecycle') {
		const edges = completed.flatMap(item => {
			const time = row(row(row(item.capacityEnvelope).budget).time);
			const start = Date.parse(text(time.executionStartedAt)), completedAt = Date.parse(text(item.completedAt));
			const closeout = Date.parse(text(time.closeoutStartedAt));
			const end = Number.isFinite(closeout) ? Math.min(closeout, completedAt) : completedAt;
			assert.ok(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'ACCEPTANCE_CONCURRENCY_EVIDENCE: Exact execution interval required');
			return [{ time: start, change: 1 }, { time: end, change: -1 }];
		}).sort((a, b) => a.time - b.time || a.change - b.change);
		let active = 0, peak = 0;
		for (const edge of edges) { active += edge.change; peak = Math.max(peak, active); }
		assert.ok(peak >= 5, 'ACCEPTANCE_CONCURRENCY_OVERLAP: Five real executions must overlap');
	}
	if (gate !== 'stopped') assert.ok(completed.length > 0, 'No completed assignment evidence; empty gates cannot pass');
	if (gate === 'stopped') {
		assert.ok(['cancelled', 'failed'].includes(text(run.status)),
			'ACCEPTANCE_STOP_TERMINAL: Failed or cancelled terminal simulation required');
		assert.ok(text(run.completedAt), 'ACCEPTANCE_STOP_TIMESTAMP: Terminal stop timestamp is required');
		for (const item of assignments) {
			assert.ok(['completed', 'failed', 'returned', 'cancelled', 'expired'].includes(text(item.status)),
				'ACCEPTANCE_STOP_ASSIGNMENT: An unfinished assignment remains after stop');
			assert.equal(item.leaseToken, null, 'ACCEPTANCE_STOP_LEASE: A live lease remains after stop');
			assert.equal(row(row(item.lifecycleOutput).teardown).verified, true,
				'ACCEPTANCE_STOP_TEARDOWN: Durable per-attempt teardown evidence is required');
		}
	}
	const activity = (item: Row) => text(row(row(item.assignmentAttempt).effectiveProfile).activity);
	if (gate === 'collaboration') {
	const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
	assert.deepEqual([...new Set(completed.filter(item => activity(item) === 'chat').map(item => row(item.assignmentAttempt).agentClass))].sort(),
		[...classes].sort(), 'ACCEPTANCE_CHAT_ROLES: Exact campaign-selected chat contributors must complete');
	for (const agentClass of classes) assert.ok(completed.filter(item => activity(item) === 'planning'
		&& row(item.assignmentAttempt).agentClass === agentClass).length >= 2, `ACCEPTANCE_PLANNING_ROLE_TURNS: Two planning turns required for ${agentClass}`);
	const rounds = rows(row(parameters.appliedPlan).planningRounds).filter(round => round.state === 'complete');
	assert.ok(rounds.length >= 2, 'ACCEPTANCE_PLANNING_CYCLES: Two completed graph planning cycles are required, not merely sixteen assignments');
	assert.deepEqual([...new Set(completed.filter(item => activity(item) === 'estimating').map(item => row(item.assignmentAttempt).agentClass))].sort(),
		classes.filter(value => value !== 'reporter').sort(), 'ACCEPTANCE_ESTIMATE_ROLES: Exact seven selected estimating contributors must complete');
	}
	const actors = completed.filter(item => activity(item) === 'acting');
	if (['graph', 'revision', 'settlement', 'reporter'].includes(gate)) assert.ok(actors.length > 0, 'Missing acting evidence');
	const reviews = completed.filter(item => activity(item) === 'reviewing' && text(row(item.assignmentAttempt).workItemId));
	if (gate === 'graph' || gate === 'revision') {
	assert.equal(new Set(actors.map(item => row(item.assignmentAttempt).workItemId)).size, 6, 'All six useful work items must complete');
	const decisionIds = new Set(actors.map(item => item.decisionId));
	assert.equal(decisionIds.size, 1, 'Actors must retain one exact decision authority');
	const decisionId = text([...decisionIds][0]);
	assert.ok(decisionId);
	const graph = read(['execution', 'graph', 'show', '--decision', decisionId], team);
	const nodes = rows(graph.nodes).filter(node => node.workdayId === workdayId && node.pairRole);
	const decisionContents = new Map<string, Row>(); // Deduplicate exact reads only within this invocation.
	assert.equal(nodes.filter(node => node.pairRole === 'actor').length, 6);
	assert.equal(nodes.filter(node => node.pairRole === 'reviewer').length, 6);
	for (const node of nodes) {
		// Terminal simulations retire their live projection; immutable attempts,
		// not arbitrary stale state, prove the exact pair's historical completion.
		const retired = node.status === 'stale';
		assert.ok(node.status === 'completed' || (run.status === 'completed' && retired), 'ACCEPTANCE_PAIR_TERMINAL: Incomplete pairs cannot pass');
		const attempts = assignments.filter(item => item.executionNodeId === node.id)
			.sort((a, b) => Number(b.executionNodeRevision) - Number(a.executionNodeRevision)
				|| text(b.createdAt).localeCompare(text(a.createdAt)));
		const latest = row(attempts[0]), attempt = row(latest.assignmentAttempt);
		assert.ok(latest.status === 'completed' && row(latest.assignmentResult).assignmentId === latest.id
			&& attempt.nodeId === node.id && attempt.workdayId === workdayId && attempt.workItemId === node.workItemId
			&& attempt.nodeRevision === latest.executionNodeRevision
			&& Number.isInteger(node.nodeRevision) && Number.isInteger(attempt.nodeRevision)
			&& (retired ? Number(node.nodeRevision) > Number(attempt.nodeRevision) : node.nodeRevision === attempt.nodeRevision),
			'ACCEPTANCE_PAIR_CUSTODY: Every node requires its latest exact completed attempt');
		assert.ok(Object.keys(row(node.sourceRef)).length > 0 && rows(node.authorityRefs).length > 0,
			'ACCEPTANCE_PAIR_AUTHORITY: Exact proposal and decision authorities are required');
		const source = exactEntityReferenceSchema.safeParse(node.sourceRef);
		assert.ok(source.success && source.data.store === 'treedx' && source.data.model === 'proposal',
			'ACCEPTANCE_PAIR_SOURCE: Governed exact proposal content is required, not a moving or operational substitute');
		let governedDecision = false;
		for (const value of rows(node.authorityRefs)) {
			const authority = exactEntityReferenceSchema.safeParse(value);
			assert.ok(authority.success, 'ACCEPTANCE_PAIR_AUTHORITY: Every authority must be an exact typed reference');
			if (authority.data.store !== 'treedx' || authority.data.model !== 'decision' || authority.data.id !== decisionId) continue;
			governedDecision = true;
			const reference = authority.data;
			assert.ok(reference.repository && reference.path && reference.commit, 'ACCEPTANCE_DECISION_SOURCE: Native exact content readback required');
			const decision = verifyDecisionContent(readDecisionContent(reference, text(node.projectId), team, decisionContents, 'ACCEPTANCE_DECISION'),
				text(node.projectId), 'ACCEPTANCE_DECISION');
			assert.ok(decision.id === reference.id && decision.projectId === node.projectId && decision.decisionClass === 'proposal'
				&& decision.disposition === 'approved', 'ACCEPTANCE_DECISION_AUTHORITY: Only the exact approved proposal Decision authorizes acting');
			assert.ok(rows(decision.decidedByRefs).some(reference => reference.model === 'user')
				&& rows(decision.decidedByRefs).every(reference => reference.model !== 'agent'),
				'ACCEPTANCE_DECISION_OPERATOR: Golden proposal approval requires an external operator, never an agent');
			assert.deepEqual(decision.subjectRef, source.data, 'ACCEPTANCE_DECISION_PROPOSAL: Decision must bind the exact proposal revision and digest');
			assert.ok(Number.isFinite(Date.parse(text(decision.decidedAt))) && Date.parse(text(decision.decidedAt)) <= Date.parse(text(latest.createdAt)),
				'ACCEPTANCE_DECISION_TIME: Decision authority must precede admission');
		}
		assert.ok(governedDecision, 'ACCEPTANCE_PAIR_DECISION: Exact governed Decision content is required');
		assert.deepEqual(attempt.sourceRef, node.sourceRef, 'ACCEPTANCE_PAIR_SOURCE: Retired source authority drifted');
		assert.deepEqual(attempt.authorityRefs, node.authorityRefs, 'ACCEPTANCE_PAIR_DECISION: Retired decision authority drifted');
		if (node.pairRole === 'reviewer') {
			assert.equal(row(row(latest.lifecycleOutput).activityCompletion).reviewDisposition, 'approved', 'ACCEPTANCE_PAIR_APPROVAL: Final review must approve');
			const actor = actors.filter(item => row(item.assignmentAttempt).workItemId === node.workItemId)
				.sort((a, b) => text(b.completedAt).localeCompare(text(a.completedAt)))[0];
			assert.ok(actor && text(latest.createdAt) > text(actor.completedAt), 'ACCEPTANCE_PAIR_CHRONOLOGY: Approval must follow the latest Actor candidate');
			const decisions: Row[] = [];
			for (const reference of rows(row(latest.assignmentResult).references).filter(value => value.kind === 'treedx')) {
				const content = readDecisionContent(reference, text(latest.projectId), team, decisionContents, 'ACCEPTANCE_REVIEW');
				if (content.schemaVersion !== 'treeseed.decision/v1') continue; // Notes are evidence, never review disposition authority.
				const decision = verifyDecisionContent(content, text(latest.projectId), 'ACCEPTANCE_REVIEW');
				if (decision.decisionClass === 'work-review') decisions.push(decision);
			}
			assert.equal(decisions.length, 1, 'ACCEPTANCE_REVIEW_AUTHORITY: Exactly one returned classed work-review Decision required');
			const reviewed = decisions[0]!, subject = row(reviewed.subjectRef);
			assert.equal(reviewed.disposition, 'approved', 'ACCEPTANCE_REVIEW_DISPOSITION: Lifecycle output is not governed approval');
			assert.ok(rows(row(actor.assignmentResult).references).some(reference => subject.store === reference.kind && subject.repository === reference.repository
				&& subject.commit === reference.commit && (!reference.path || subject.path === reference.path)), 'ACCEPTANCE_REVIEW_CANDIDATE: Exact latest actor result required');
			assert.ok(rows(reviewed.decidedByRefs).some(reference => JSON.stringify(reference) === JSON.stringify(row(row(attempt.effectiveProfile).profileRef))),
				'ACCEPTANCE_REVIEW_IDENTITY: Exact assigned reviewing profile evidence required');
			assert.ok(Number.isFinite(Date.parse(text(reviewed.decidedAt))) && Date.parse(text(reviewed.decidedAt)) >= Date.parse(text(latest.createdAt))
				&& Date.parse(text(reviewed.decidedAt)) <= Date.parse(text(latest.completedAt)), 'ACCEPTANCE_REVIEW_TIME: Original review window required');
		}
	}
	}
	const disposition = (item: Row) => text(row(row(item.lifecycleOutput).activityCompletion).reviewDisposition);
	if (gate === 'revision') {
	assert.ok(reviews.some(item => disposition(item) === 'request-changes'), 'A genuine request-changes cycle is required');
	for (const requested of reviews.filter(item => disposition(item) === 'request-changes')) {
		const workItemId = row(requested.assignmentAttempt).workItemId;
		const revision = actors.find(item => row(item.assignmentAttempt).workItemId === workItemId
			&& text(item.createdAt) > text(requested.completedAt));
		assert.ok(revision, `Request changes requires a later real Actor revision for ${text(workItemId)}`);
		assert.ok(reviews.some(item => row(item.assignmentAttempt).workItemId === workItemId
			&& disposition(item) === 'approved' && text(item.createdAt) > text(revision.completedAt)), 'Revision must receive its own later approval');
	}
	for (const workItemId of new Set(actors.map(item => row(item.assignmentAttempt).workItemId))) {
		const itemReviews = reviews.filter(item => row(item.assignmentAttempt).workItemId === workItemId)
			.sort((a, b) => text(a.completedAt).localeCompare(text(b.completedAt)));
		assert.equal(disposition(itemReviews.at(-1) ?? {}), 'approved', `Final review did not approve ${text(workItemId)}`);
	}
	}
	const modelResults = completed.filter(item => ['chat', 'acting', 'reviewing', 'planning', 'estimating'].includes(activity(item)));
	if (gate === 'results') assert.ok(modelResults.length > 0, 'No model-backed results were inspected');
	if (gate === 'results') for (const item of modelResults) {
		const result = row(item.assignmentResult), timing = row(result.timingAwareness);
		assert.equal(result.status, 'completed', `Missing canonical result for ${text(item.id)}`);
		assert.equal(result.assignmentId, item.id, 'ACCEPTANCE_RESULT_CUSTODY: Result must bind this exact assignment');
		assert.ok(Number.isInteger(timing.completedChecks) && Number(timing.completedChecks) >= 2,
			`ACCEPTANCE_CLOCK_BOUNDARIES: Missing first/final clock evidence for ${text(item.id)}`);
		assert.equal(timing.firstToolCompliant, true);
		assert.equal(timing.finalToolCompliant, true);
		assert.ok(assignmentTimingAwarenessReceiptSchema.safeParse(timing).success,
			'ACCEPTANCE_CLOCK_BOUNDARIES: Complete successful first/final authoritative clock evidence required');
		assert.equal(row(row(item.lifecycleOutput).teardown).verified, true);
		const activeSeconds = row(row(result.usage).native).activeSeconds;
		assert.ok(typeof activeSeconds === 'number' && Number.isFinite(activeSeconds) && activeSeconds > 0, 'Measured active usage must be positive and finite');
		assert.ok(rows(result.references).length > 0, 'A claimed completion without exact output references cannot pass');
		for (const reference of rows(result.references)) assert.ok(assignmentReferenceSchema.safeParse(reference).success,
			'ACCEPTANCE_RESULT_REFERENCE: Canonical exact output references required');
	}
	if (gate === 'settlement' || gate === 'stopped') {
	const usageItems: Row[] = [];
	cursor = undefined;
	for (const projectId of new Set(assignments.map(item => text(item.projectId)))) {
	assert.ok(projectId, 'Settlement evidence requires exact project attribution');
	cursor = undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const usage = read(['capacity', 'usage', '--project', projectId, '--workday', workdayId,
			'--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], team);
		usageItems.push(...rows(usage.items));
		const pageInfo = row(usage.page);
		if (!pageInfo.hasMore) break;
		const next = text(pageInfo.nextCursor);
		assert.ok(next && next !== cursor, 'Settlement pagination omitted its next cursor or repeated it');
		cursor = next;
		assert.ok(pageNumber < 39, 'Complete settlement evidence was not reached; do not claim a pass');
	}
	}
	assert.equal(new Set(usageItems.map(item => item.id)).size, usageItems.length, 'Settlement pages repeated usage records');
	const aggregate = usageItems.filter(item => text(item.id).endsWith(':aggregate'));
	for (const item of assignments) {
		if (gate === 'settlement') {
			assert.ok(item.status === 'completed' || phaseBoundaryCancelled(item,run), 'Normal settlement requires completed or authoritative phase-cancelled attempts');
			assert.equal(item.leaseToken, null, 'ACCEPTANCE_SETTLEMENT_LEASE: Settlement cannot retain a live lease');
			assert.equal(row(row(item.lifecycleOutput).teardown).verified, true, 'ACCEPTANCE_SETTLEMENT_TEARDOWN: Settlement requires durable teardown');
		}
		const settlements = aggregate.filter(measurement => measurement.assignmentId === item.id);
		assert.equal(settlements.length, 1, `ACCEPTANCE_SETTLEMENT_COUNT: Exactly one actual settlement required for ${text(item.id)}`);
		assert.ok(text(row(settlements[0]?.metadata).settlementKey), 'ACCEPTANCE_SETTLEMENT_KEY: Stable settlement key required');
	}
	}
	if (gate === 'reporter') {
	assert.ok(!Object.hasOwn(run, 'reportRefs'), 'ACCEPTANCE_REPORT_AUTHORITY: Retired plural report map is forbidden');
	const report = row(run.reportRef);
	assert.ok(report.kind === 'treedx' && assignmentReferenceSchema.safeParse(report).success, 'Native Reporter must store one exact report reference');
	const reporting = assignments.filter(item => activity(item) === 'reporting');
	assert.equal(reporting.length, 1, 'ACCEPTANCE_REPORT_ASSIGNMENT: Exactly one selected closeout assignment required');
	const reporter = reporting[0]!, result = row(reporter.assignmentResult);
	assert.ok(reporter.status === 'completed' && result.status === 'completed' && result.assignmentId === reporter.id,
		'ACCEPTANCE_REPORT_COMPLETION: Canonical completed reporting result must bind its assignment');
	assert.equal(reporter.leaseToken, null, 'ACCEPTANCE_REPORT_LEASE: Closeout lease must be released');
	assert.equal(row(row(reporter.lifecycleOutput).teardown).verified, true, 'ACCEPTANCE_REPORT_TEARDOWN: Durable closeout teardown required');
	const references = rows(result.references).filter(ref => ref.kind === 'treedx' && ref.projectId === report.projectId && ref.path === report.path && ref.commit === report.commit);
	assert.equal(references.length, 1, 'ACCEPTANCE_REPORT_CUSTODY: Workday report must be the exact reporting result output');
	assert.deepEqual(references[0], report, 'ACCEPTANCE_REPORT_CUSTODY: Report output authority drifted');
	const ended = Date.parse(text(run.endedAt)), completedAt = Date.parse(text(reporter.completedAt));
	assert.ok(run.state === 'ended' && Number.isFinite(ended) && Number.isFinite(completedAt) && completedAt <= ended,
		'ACCEPTANCE_REPORT_CHRONOLOGY: Reporter must complete before the workday ends');
	const readBack = read(['library', 'read', text(report.projectId), text(report.path), '--ref', text(report.commit)], team, true);
	const observed = row(readBack.result);
	assert.equal(observed.resolvedRef, report.commit, 'ACCEPTANCE_REPORT_READBACK: Resolved report commit must remain exact');
	const files = rows(observed.files);
	assert.equal(files.length, 1);
	assert.equal(files[0]?.path, report.path, 'ACCEPTANCE_REPORT_READBACK: Exact report path required');
	const frontmatter = row(files[0]?.frontmatter);
	assert.ok(frontmatter.schemaVersion === 'treeseed.note/v1' && frontmatter.classification === 'workday-report'
		&& frontmatter.projectId === report.projectId, 'ACCEPTANCE_REPORT_NOTE: Canonical classified report note required');
	const source = row(row(reporter.assignmentAttempt).sourceRef);
	assert.ok(source.store === 'postgresql' && source.model === 'workday' && source.id === workdayId, 'ACCEPTANCE_REPORT_SUBJECT: Reporting assignment must bind the exact workday');
	const subjects = rows(frontmatter.subjectRefs).filter(ref => ref.store === 'postgresql' && ref.model === 'workday' && ref.id === workdayId);
	assert.equal(subjects.length, 1, 'ACCEPTANCE_REPORT_SUBJECT: Note must retain one exact workday subject');
	assert.deepEqual(subjects[0], source, 'ACCEPTANCE_REPORT_SUBJECT: Workday subject authority drifted');
	const body = text(files[0]?.body);
	assert.ok(body.includes(workdayId), 'Reporter must describe this exact workday');
	assert.ok(body.includes(text(actors[0]?.id)), 'Reporter must include actual predecessor evidence, not an empty summary');
	}
}

test('Golden runtime lifecycle evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('lifecycle'));
test('Golden runtime collaboration evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('collaboration'));
test('Golden runtime graph evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('graph'));
test('Golden runtime revision evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('revision'));
test('Golden runtime results evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('results'));
test('Golden runtime settlement evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('settlement'));
test('Golden runtime reporter evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('reporter'));
test('Stopped simulation retains terminal leases teardown and exactly-once settlement', { timeout: 120_000 }, () => verifyGolden('stopped'));
