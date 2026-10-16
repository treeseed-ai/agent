import assert from 'node:assert/strict';
import { estimateSchema,assignmentAttemptSchema,appliedWorkdaySchema,workdayPlanningEndsAt } from '@treeseed/sdk/agent-capacity';
import { row, type Row } from '../../../acceptance-cli.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function verifyAllocation(item: Row, run: Row): void {
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

/** Observe original issued authority before continuing the existing SDK campaign.
 * The API owns phase/admission; this comparison creates no scheduler state. */
export function verifyPlanningWindow(item:Row,run:Row):void{
 const label='ACCEPTANCE_PLANNING_WINDOW: Original planning floor and allocator phase required';
 const parsedAttempt=assignmentAttemptSchema.safeParse(item.assignmentAttempt),parsedPlan=appliedWorkdaySchema.safeParse(row(run.parameters).appliedPlan);
 assert.ok(parsedAttempt.success&&parsedPlan.success,label);const attempt=parsedAttempt.data,plan=parsedPlan.data;
 assert.ok(plan.id===run.id&&plan.teamId===run.teamId&&attempt.workdayId===plan.id&&attempt.teamId===plan.teamId&&plan.startsAt===run.startedAt&&plan.executionMode===run.executionMode,label);
 const issued=Date.parse(attempt.createdAt),floor=Date.parse(workdayPlanningEndsAt(plan)),activity=attempt.effectiveProfile.activity;
 assert.ok(Number.isFinite(issued)&&Number.isFinite(floor),label);
 const opportunity=row(row(row(row(item.explanation).metadata).allocation).opportunity);
 assert.ok(Object.hasOwn(opportunity,'phase')&&typeof opportunity.phase==='string'&&['planning','acting'].includes(opportunity.phase),label);
 if(['acting','reviewing'].includes(activity)){assert.ok(issued>=floor,label);assert.equal(opportunity.phase,'acting',label);}
 if(['planning','estimating'].includes(activity)||activity==='chat'&&issued<floor)assert.equal(opportunity.phase,'planning',label);
 if(activity==='reporting')assert.equal(opportunity.phase,'acting',label);
}
