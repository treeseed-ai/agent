import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentReferenceSchema, assignmentTimingAwarenessReceiptSchema, estimateSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { DEFAULT_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import { read, row, type Row } from './acceptance-cli.ts';
import { readDecisionContent, readGovernedContentFile, verifyDecisionContent, verifyReviewFindingContent } from './workday/support/decision-evidence.ts';
import { verifyAssignmentAuthority, verifyTeardownAuthority, verifyTreeDxWorkspaceClosure } from './workday/support/assignment-authority.ts';
import { verifyPlanningEvidence } from './workday/support/planning-evidence.ts';
import { readCompleteEvidence } from './workday/support/evidence-pages.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

// Each exact test is independently selectable by the existing guarantee runner.
// These read-back gates do not stand in for campaign orchestration or external-state proof.
const gates = ['lifecycle', 'collaboration', 'graph', 'revision', 'results', 'settlement', 'reporter', 'stopped'] as const;
type Gate = typeof gates[number];
function verifyAllocation(item: Row, run: Row): void {
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
		&& calibration.measurementIds.every(id => typeof id === 'string' && id.length > 0 && id === id.trim())
		&& new Set(calibration.measurementIds).size === calibration.measurementIds.length,
		'ACCEPTANCE_ALLOCATION_CALIBRATION: At most twenty unique exact sample identities required');
	if (calibration.measurementIds.length === 0) assert.equal(desired, estimate.data.maximumSeconds, 'ACCEPTANCE_ALLOCATION_CALIBRATION: Cold start must preserve the maximum estimate');
	const opportunity = row(allocation.opportunity);
	const weight = row(row(row(run.parameters).appliedPlan).policySnapshot).allocationWeight;
	assert.ok(finite(weight) && weight > 0, 'ACCEPTANCE_ALLOCATION_POLICY: Original applied policy weight required');
	assert.equal(opportunity.weight, weight, 'ACCEPTANCE_ALLOCATION_POLICY: Receipt cannot invent another workday entitlement');
	assert.ok(['planning', 'acting'].includes(text(opportunity.phase)), 'ACCEPTANCE_ALLOCATION_PHASE: Exact original phase required');
	for (const field of ['shareSeconds', 'availableSeconds']) assert.ok(Number.isInteger(opportunity[field]),
		'ACCEPTANCE_ALLOCATION_SUPPLY: Original integer shared opportunity required');
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
	const start = Date.parse(startedAt);
	assert.ok(workdayId && Number.isFinite(start), 'ACCEPTANCE_ASSIGNMENT_ROW: Exact workday start authority required');
	for (const item of readCompleteEvidence(['assignments', 'list'], team, DEFAULT_CAPACITY_PAGE_LIMIT, 'ACCEPTANCE_ASSIGNMENT')) {
			const time = Date.parse(text(item.createdAt));
			assert.ok(item.workDayId === null || typeof item.workDayId === 'string', 'ACCEPTANCE_ASSIGNMENT_ROW: Workday scope required');
			if (item.workDayId === workdayId) {
				assert.ok(time >= start, 'ACCEPTANCE_ASSIGNMENT_ROW: Target assignment predates its authoritative workday');
				assignments.push(item);
			}
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
	if (['lifecycle', 'results', 'settlement', 'reporter', 'stopped'].includes(gate)) {
		for (const item of assignments) { verifyTeardownAuthority(item); verifyTreeDxWorkspaceClosure(item, team); }
	}
	if (['lifecycle', 'graph', 'revision', 'results', 'reporter'].includes(gate)) for (const item of assignments) verifyAssignmentAuthority(item);
	if (gate === 'lifecycle') for (const item of assignments) {
		verifyAllocation(item, run);
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
			assert.ok(['unleased', 'released', 'expired'].includes(text(item.leaseState))
				&& item.leaseExpiresAt === null && item.leaseRenewedAt === null,
				'ACCEPTANCE_STOP_LEASE: Lease state, expiry and renewal custody must be durably cleared');
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
	const rounds = rows(row(parameters.appliedPlan).planningRounds);
	assert.ok(rounds.filter(round => round.state === 'complete').length >= 2, 'ACCEPTANCE_PLANNING_CYCLES: Two completed graph planning cycles are required, not merely sixteen assignments');
	verifyPlanningEvidence(rounds, assignments, classes, run, team);
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
		for (const prior of attempts.filter(item => item.status === 'returned')) {
			const frozen = row(prior.assignmentAttempt);
			assert.ok(frozen.nodeId === node.id && frozen.nodeRevision === prior.executionNodeRevision
				&& Number.isInteger(frozen.nodeRevision) && Number(frozen.nodeRevision) >= 1
				&& Number(frozen.nodeRevision) < Number(attempt.nodeRevision),
				'ACCEPTANCE_RETRY_REVISION: A completed retry must follow an advanced node revision without rebinding returned history');
		}
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
		const prior = actors.filter(item => row(item.assignmentAttempt).workItemId === workItemId
			&& Date.parse(text(item.completedAt)) <= Date.parse(text(requested.createdAt)))
			.sort((a, b) => Date.parse(text(b.completedAt)) - Date.parse(text(a.completedAt)))[0];
		assert.ok(prior, 'ACCEPTANCE_REVISION_PRIOR: Request changes must follow its real original Actor');
		const approval = reviews.find(item => row(item.assignmentAttempt).workItemId === workItemId
			&& disposition(item) === 'approved' && text(item.createdAt) > text(revision.completedAt));
		assert.ok(approval, 'Revision must receive its own later approval');
		const chain = [prior, requested, revision, approval];
		assert.equal(new Set(chain.map(item => item.id)).size, chain.length, 'ACCEPTANCE_REVISION_IDENTITIES: Distinct attempts required');
		assert.equal(new Set(chain.map(item => row(item.assignmentResult).id)).size, chain.length,
			'ACCEPTANCE_REVISION_IDENTITIES: Distinct completed result identities required');
		for (const item of chain) {
			const result = row(item.assignmentResult), attempt = row(item.assignmentAttempt);
			assert.ok(text(result.id) && result.assignmentId === item.id && result.status === 'completed',
				'ACCEPTANCE_REVISION_RESULT: Exact owning completed result required');
			assert.ok(Array.isArray(attempt.predecessorResultIds)
				&& attempt.predecessorResultIds.every((value: unknown) => typeof value === 'string' && value.length > 0)
				&& new Set(attempt.predecessorResultIds).size === attempt.predecessorResultIds.length,
				'ACCEPTANCE_REVISION_PREDECESSORS: Original unique result inventory required');
		}
		for (const [review, actor] of [[requested, prior], [approval, revision]] as const) {
			assert.notEqual(row(review.assignmentAttempt).agentClass, row(actor.assignmentAttempt).agentClass,
				'ACCEPTANCE_REVISION_INDEPENDENCE: Actor cannot supply its own review');
			const predecessorIds = row(review.assignmentAttempt).predecessorResultIds;
			assert.ok(Array.isArray(predecessorIds) && predecessorIds.includes(row(actor.assignmentResult).id),
				'ACCEPTANCE_REVISION_PREDECESSORS: Review must consume its exact Actor result');
		}
		const correctionPredecessors = row(revision.assignmentAttempt).predecessorResultIds;
		assert.ok(Array.isArray(correctionPredecessors) && correctionPredecessors.includes(row(requested.assignmentResult).id),
			'ACCEPTANCE_REVISION_PREDECESSORS: Correction must consume the original request-changes result');
		const changes: Row[] = [], changeReferences: Row[] = [], cache = new Map<string, Row>();
		for (const reference of rows(row(requested.assignmentResult).references).filter(value => value.kind === 'treedx')) {
			const content = readDecisionContent(reference, text(requested.projectId), team, cache, 'ACCEPTANCE_REVISION');
			if (content.schemaVersion !== 'treeseed.decision/v1') continue;
			const decision = verifyDecisionContent(content, text(requested.projectId), 'ACCEPTANCE_REVISION');
			if (decision.decisionClass === 'work-review') { changes.push(decision); changeReferences.push(reference); }
		}
		assert.equal(changes.length, 1, 'ACCEPTANCE_REVISION_DECISION: Exactly one genuine work-review Decision required');
		const change = changes[0]!, subject = row(change.subjectRef);
		assert.equal(change.disposition, 'request-changes', 'ACCEPTANCE_REVISION_DISPOSITION: Lifecycle flag is not a governed finding');
		assert.ok(rows(row(prior.assignmentResult).references).some(reference => subject.store === reference.kind
			&& subject.repository === reference.repository && subject.commit === reference.commit
			&& (!reference.path || subject.path === reference.path)), 'ACCEPTANCE_REVISION_CANDIDATE: Exact original Actor artifact required');
		assert.ok(rows(change.decidedByRefs).some(reference => JSON.stringify(reference)
			=== JSON.stringify(row(row(row(requested.assignmentAttempt).effectiveProfile).profileRef))),
			'ACCEPTANCE_REVISION_REVIEWER: Assigned independent Reviewer profile required');
		const decided = Date.parse(text(change.decidedAt));
		assert.ok(Number.isFinite(decided) && decided >= Date.parse(text(requested.createdAt))
			&& decided <= Date.parse(text(requested.completedAt)), 'ACCEPTANCE_REVISION_CLOCK: Original review interval required');
		assert.ok(Array.isArray(change.findingRefs) && change.findingRefs.length > 0
			&& new Set(change.findingRefs.map(value => JSON.stringify(value))).size === change.findingRefs.length,
			'ACCEPTANCE_REVISION_FINDINGS: Genuine unique governed feedback required');
		for (const finding of change.findingRefs.map(row)) {
			const source = { ...finding, commit: finding.commit ?? changeReferences[0]!.commit };
			const file = readGovernedContentFile(source, text(requested.projectId), team, cache, 'ACCEPTANCE_REVISION');
			verifyReviewFindingContent(finding, changeReferences[0]!, change, file, requested, 'ACCEPTANCE_REVISION');
			assert.deepEqual(readGovernedContentFile(source, text(requested.projectId), team, new Map<string, Row>(), 'ACCEPTANCE_REVISION'), file,
				'ACCEPTANCE_REVISION_FINDING_READBACK: Exact native finding observations must remain immutable');
		}
	}
	for (const workItemId of new Set(actors.map(item => row(item.assignmentAttempt).workItemId))) {
		const itemReviews = reviews.filter(item => row(item.assignmentAttempt).workItemId === workItemId)
			.sort((a, b) => text(a.completedAt).localeCompare(text(b.completedAt)));
		assert.equal(disposition(itemReviews.at(-1) ?? {}), 'approved', `Final review did not approve ${text(workItemId)}`);
	}
	assert.deepEqual(readWorkdayAssignments(workdayId, text(run.startedAt), team), assignments,
		'ACCEPTANCE_REVISION_READBACK: Failed review and correction history must remain immutable');
	}
	const modelResults = completed.filter(item => ['chat', 'acting', 'reviewing', 'planning', 'estimating'].includes(activity(item)));
	if (gate === 'results') assert.ok(modelResults.length > 0, 'No model-backed results were inspected');
	if (gate === 'results') for (const item of modelResults) {
		const result = row(item.assignmentResult), timing = row(result.timingAwareness);
		assert.equal(result.status, 'completed', `Missing canonical result for ${text(item.id)}`);
		assert.equal(result.assignmentId, item.id, 'ACCEPTANCE_RESULT_CUSTODY: Result must bind this exact assignment');
		const attempt = row(item.assignmentAttempt), time = row(row(row(item.capacityEnvelope).budget).time);
		const created = Date.parse(text(attempt.createdAt)), start = Date.parse(text(time.executionStartedAt));
		const deadline = Date.parse(text(attempt.deadline)), terminal = Date.parse(text(item.completedAt));
		const resultTime = Date.parse(text(result.completedAt));
		assert.ok([created, start, deadline, terminal, resultTime].every(Number.isFinite)
			&& created <= start && start <= resultTime && resultTime <= deadline && resultTime <= terminal,
			'ACCEPTANCE_RESULT_CLOCK: Canonical completion must fit the original immutable productive and actual reporting interval');
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
		const workspace = row(attempt.workspace);
		if (workspace.mode === 'git') assert.ok(rows(result.references).some(reference => reference.kind === 'git'
			&& reference.repository === workspace.repository
			&& (reference.branch === undefined || reference.branch === workspace.branch)),
			'ACCEPTANCE_RESULT_WORKSPACE: Git completion requires an exact candidate in the sole immutable repository and any presented branch must match');
	}
	if (gate === 'settlement' || gate === 'stopped') {
	const usageItems: Row[] = [];
	const usageIds = new Set<string>(), usageKeys = new Set<string>();
	for (const projectId of new Set(assignments.map(item => text(item.projectId)))) {
	assert.ok(projectId, 'Settlement evidence requires exact project attribution');
	for (const measurement of readCompleteEvidence(['capacity', 'usage', '--project', projectId, '--workday', workdayId], team, 100, 'ACCEPTANCE_USAGE')) {
		const assignment = assignments.find(item => item.id === measurement.assignmentId);
		assert.ok(measurement.projectId === projectId && measurement.workDayId === workdayId && assignment
			&& assignment.projectId === projectId, 'ACCEPTANCE_USAGE_SCOPE: Exact project/workday/assignment attribution required');
		assert.ok(typeof measurement.id === 'string' && typeof measurement.idempotencyKey === 'string' && measurement.idempotencyKey
			&& !usageIds.has(measurement.id) && !usageKeys.has(measurement.idempotencyKey)
			&& typeof measurement.assignmentAttempt === 'number' && Number.isInteger(measurement.assignmentAttempt) && measurement.assignmentAttempt >= 0,
			'ACCEPTANCE_USAGE_IDENTITY: Unique idempotency and valid attempt authority required');
		usageIds.add(measurement.id); usageKeys.add(measurement.idempotencyKey);
		assert.ok(measurement.assignmentAttempt === row(assignment.assignmentAttempt).attempt,
			'ACCEPTANCE_USAGE_ACCOUNTING: ACCEPTANCE_USAGE_ATTEMPT: Measurement must belong to the exact immutable assignment attempt');
		const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
		assert.ok(finite(measurement.activeSeconds) && finite(measurement.elapsedSeconds) && measurement.activeSeconds <= measurement.elapsedSeconds
			&& (!measurement.elapsedSeconds || measurement.activeSeconds > 0), 'ACCEPTANCE_USAGE_MEASURED: Finite truthful productive time required');
		assert.ok(measurement.nativeUsage && typeof measurement.nativeUsage === 'object' && !Array.isArray(measurement.nativeUsage)
			&& Object.values(measurement.nativeUsage).every(finite), 'ACCEPTANCE_USAGE_MEASURED: Finite nonnegative native usage required');
		assert.ok(typeof measurement.accountingMode === 'string' && ['aggregate', 'incremental', 'informational'].includes(measurement.accountingMode),
			'ACCEPTANCE_USAGE_IDENTITY: Valid accounting mode required');
		assert.ok(measurement.accountingMode !== 'informational' || (measurement.activeSeconds === 0 && measurement.elapsedSeconds === 0),
			'ACCEPTANCE_USAGE_ACCOUNTING: Informational dimensions cannot charge productive seconds');
		const result = row(assignment.assignmentResult);
		if (measurement.accountingMode === 'aggregate' && result.status === 'completed') {
			const usage = row(result.usage), native = row(usage.native), observedNative = row(measurement.nativeUsage);
			assert.ok(finite(usage.elapsedSeconds) && usage.elapsedSeconds === measurement.elapsedSeconds
				&& Object.entries(native).every(([key, value]) => finite(value) && observedNative[key] === value)
				&& (native.activeSeconds === undefined || native.activeSeconds === measurement.activeSeconds),
				'ACCEPTANCE_USAGE_RESULT: Aggregate measurement must retain the exact completed result usage');
		}
		usageItems.push(measurement);
	}
	}
	assert.equal(new Set(usageItems.map(item => item.id)).size, usageItems.length, 'Settlement pages repeated usage records');
	const aggregate = usageItems.filter(item => item.accountingMode === 'aggregate');
	const settlementKeys = new Set<string>();
	for (const item of assignments) {
		if (gate === 'settlement') {
			assert.ok(item.status === 'completed' || phaseBoundaryCancelled(item,run), 'Normal settlement requires completed or authoritative phase-cancelled attempts');
			assert.equal(item.leaseToken, null, 'ACCEPTANCE_SETTLEMENT_LEASE: Settlement cannot retain a live lease');
			assert.equal(row(row(item.lifecycleOutput).teardown).verified, true, 'ACCEPTANCE_SETTLEMENT_TEARDOWN: Settlement requires durable teardown');
		}
		const settlements = aggregate.filter(measurement => measurement.assignmentId === item.id);
		assert.equal(settlements.length, 1, `ACCEPTANCE_SETTLEMENT_COUNT: Exactly one actual settlement required for ${text(item.id)}`);
		const time = row(row(row(item.capacityEnvelope).budget).time);
		if (time.executionStartedAt != null) {
			const started = Date.parse(text(time.executionStartedAt));
			const terminal = Date.parse(text(item.status === 'completed' ? item.completedAt
				: item.status === 'returned' ? item.returnedAt ?? item.failedAt ?? item.completedAt
					: item.failedAt ?? item.returnedAt ?? item.completedAt));
			assert.ok(Number.isFinite(started) && Number.isFinite(terminal) && terminal >= started,
				'ACCEPTANCE_USAGE_CLOCK: Declared execution requires ordered terminal clock evidence');
			assert.ok(terminal === started || (Number(settlements[0]?.activeSeconds) > 0 && Number(settlements[0]?.elapsedSeconds) > 0),
				'ACCEPTANCE_USAGE_CLOCK: Visibly elapsed productive work cannot settle as zero');
		}
		const incremental = usageItems.filter(measurement => measurement.assignmentId === item.id && measurement.accountingMode === 'incremental');
		assert.ok(incremental.every(measurement => measurement.assignmentAttempt === settlements[0]?.assignmentAttempt)
			&& incremental.reduce((total, measurement) => total + (measurement.activeSeconds as number), 0) <= (settlements[0]?.activeSeconds as number),
			'ACCEPTANCE_USAGE_ACCOUNTING: Incremental seconds must belong to the sole immutable attempt and fit its terminal aggregate');
		assert.ok(text(row(settlements[0]?.metadata).settlementKey), 'ACCEPTANCE_SETTLEMENT_KEY: Stable settlement key required');
		const key = text(row(settlements[0]?.metadata).settlementKey);
		assert.ok(!settlementKeys.has(key), 'ACCEPTANCE_USAGE_IDENTITY: A settlement key cannot account for two assignments');
		settlementKeys.add(key);
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
