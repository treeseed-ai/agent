import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalStandardsJson} from '@treeseed/sdk/standards';
import assert from 'node:assert/strict';
import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { compileWorkday, appliedWorkdaySchema, assignmentAttemptSchema, executionNodeSchema, usageSettlementSchema } from '@treeseed/sdk/agent-capacity';
import { validateWorkdayIntent, type WorkdayIntent } from '@treeseed/sdk/operator-contracts';
import { collectCompleteEvidence } from './evidence-pages.ts';

/** Public labels derive from the original Workday; free-form nested content is not mode authority. */
export function verifyDerivedWorkdayModes(run: Row, records: readonly Row[]): void {
	assert.ok(run.executionMode === 'simulation' || run.executionMode === 'production', 'ACCEPTANCE_DERIVED_MODE: Exact owning Workday mode required');
	for (const record of records) if (Object.hasOwn(record, 'executionMode')) assert.equal(record.executionMode, run.executionMode,
		'ACCEPTANCE_DERIVED_MODE: Public label contradicts the sole Workday authority');
}

/** The original applied workday owns productive clocks and policy in both
 * initial-start and live assignment read-back. */
export function verifyAppliedWorkdayCustody(run: Row) {
	const id = String(run.id ?? '');
	const parameters = row(run.parameters);
	assert.ok(!Object.hasOwn(parameters, 'executionMode'), 'ACCEPTANCE_START_MODE: Workday is the sole mode authority; duplicate parameter mode forbidden');
	const plan = appliedWorkdaySchema.parse(parameters.appliedPlan);
	assert.deepEqual(plan, parameters.appliedPlan, 'ACCEPTANCE_START_RAW: Public Workday authority must already be canonical without normalization');
	assert.equal(plan.id, id, 'ACCEPTANCE_START_ID: Applied plan differs from public run');
	assert.equal(plan.teamId, run.teamId, 'ACCEPTANCE_START_TEAM: Applied plan differs from public team');
	assert.equal(plan.executionMode, run.executionMode, 'ACCEPTANCE_START_MODE: Workday is the sole mode authority');
	assert.equal(Date.parse(plan.startsAt), Date.parse(String(run.startedAt)), 'ACCEPTANCE_START_CLOCK: Original start changed');
	assert.equal(Date.parse(plan.endsAt), Date.parse(plan.startsAt) + plan.policySnapshot.durationSeconds * 1000,
		'ACCEPTANCE_START_CLOCK: Original productive duration changed');
	assert.equal(Date.parse(String(parameters.deadlineAt)), Date.parse(plan.endsAt), 'ACCEPTANCE_START_CLOCK: Productive deadline drift');
	for (const [key, value] of Object.entries(plan.policySnapshot)) assert.deepEqual(parameters[key], value,
		`ACCEPTANCE_START_POLICY: Frozen ${key} differs from applied original authority`);
	return plan;
}

/** The public API record retains an empty historical map; only its original applied plan owns report and lifecycle. */
export function verifyReportWorkdayAuthority(run:Row){
 const label='ACCEPTANCE_REPORT_AUTHORITY',plan=verifyAppliedWorkdayCustody(run);
 assert.ok(run.status==='completed'&&run.executionMode==='simulation'&&plan.state==='ended'&&plan.reportRef?.kind==='treedx',label+': Native Reporter must store one exact report reference');
 for(const field of ['reportRef','state','endedAt'])assert.ok(!Object.hasOwn(run,field),label+': Duplicate top-level lifecycle or report authority');
 assert.ok(Object.hasOwn(run,'reportRefs')&&run.reportRefs&&typeof run.reportRefs==='object'&&!Array.isArray(run.reportRefs)&&Object.keys(run.reportRefs).length===0,label+': Populated or malformed retired plural report map');
 assert.ok(typeof plan.closingAt==='string'&&Number.isFinite(Date.parse(plan.closingAt))&&typeof plan.endedAt==='string'
  &&Number.isFinite(Date.parse(plan.endedAt))&&Date.parse(plan.closingAt)<=Date.parse(plan.endedAt)
  &&run.completedAt===plan.endedAt,label+': Original closing and terminal clocks must agree');
 return plan;
}

// Read later pages only through the existing public events operation. Without
// a supplied reader an incomplete show still denies; no inferred terminal page.
export function verifyInitialStartCustody(observed: Row, assignments: Row[], readEvents?: (cursor: string, limit: number) => Row): void {
	const run = row(observed.run), id = String(run.id ?? '');
	const snapshot = observeCampaign(observed, id, new Map(), readEvents);
	const parameters = row(run.parameters), plan = verifyAppliedWorkdayCustody(run), selection = parameters.decisionIds;
	if (selection !== undefined) assert.ok(Array.isArray(selection) && selection.length > 0
		&& selection.every(value => typeof value === 'string' && value.length > 0 && value === value.trim())
		&& new Set(selection).size === selection.length,
	'ACCEPTANCE_START_SELECTION: Explicit frozen decision inventory must be complete unique and exact');
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
export function observeCampaign(observed: unknown, workdayId: string, retained: Map<string, Row>, readEvents?: (cursor: string, limit: number) => Row, capture?: (event:Row)=>void) {
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
	assert.ok(run.status !== 'completed' || !failedBoundary, 'ACCEPTANCE_OBSERVATION: Completed run hides failed scheduling');
	return {run,failedBoundary,events:retainCampaignEventHistory(events,run,retained,capture)};
}

/** The assignment list is held before the complete public history is read.
 * Later events remain observations; the next poll inspects their current rows.
 * Clock-tool contents retain their existing protected native verifier. */
export function verifyAssignmentTransitionHistory(run: Row, assignments: readonly Row[], events: readonly Row[]): void {
 const label='ACCEPTANCE_ASSIGNMENT_TRANSITIONS',clock=(value:unknown)=>{assert.ok(typeof value==='string'&&Number.isFinite(Date.parse(value)),label+': Original transition clock required');return Date.parse(value);};
 const ids=new Set<string>(),indexes=new Set<number>();
 for(const event of events){
  assert.equal(event.runId,run.id,label+': Foreign run');assert.equal(event.teamId,run.teamId,label+': Foreign team');
  assert.ok(typeof event.id==='string'&&event.id&&!ids.has(event.id),label+': Duplicate event');ids.add(event.id);
  assert.ok(Number.isSafeInteger(event.eventIndex)&&Number(event.eventIndex)>=0&&!indexes.has(Number(event.eventIndex)),label+': Duplicate event index');indexes.add(Number(event.eventIndex));clock(event.createdAt);
 }
 assert.deepEqual([...indexes].sort((a,b)=>a-b),Array.from({length:indexes.size},(_,index)=>index),label+': Missing public event');
 const owners=new Set<string>();
 for(const item of assignments){
  const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt),metadata=row(item.metadata);
  assert.equal(item.id,attempt.id,label);assert.equal(attempt.workdayId,run.id,label);assert.equal(attempt.teamId,run.teamId,label);
  assert.ok(!owners.has(attempt.id),label+': Duplicate original assignment');owners.add(attempt.id);
  assert.ok(Number.isSafeInteger(item.stateVersion)&&Number(item.stateVersion)>=1,label+': Exact owning version required');
  const created=clock(attempt.createdAt);assert.equal(clock(item.createdAt),created,label+': Original creation changed');
  const observed=events.filter(event=>event.assignmentId===attempt.id&&typeof event.eventType==='string'&&event.eventType.startsWith('assignment.'));
  const one=(type:string)=>{const matches=observed.filter(event=>event.eventType===type);assert.equal(matches.length,1,label+': Missing or duplicate '+type);return matches[0]!;};
  const version=(event:Row,prefix:string)=>{assert.ok(typeof event.id==='string'&&event.id.startsWith(prefix),label+': Wrong owning transition identity');const suffix=event.id.slice(prefix.length);assert.match(suffix,/^[1-9][0-9]*$/u,label);const value=Number(suffix);assert.ok(Number.isSafeInteger(value)&&value>1,label);return value;};
  const birth=one('assignment.created');assert.equal(birth.id,'assignment-created:'+attempt.id,label);assert.equal(clock(birth.createdAt),created,label);
  const common={nodeId:attempt.nodeId,graphRevision:attempt.graphRevision,leaseId:attempt.leaseId,reservationId:attempt.reservationId};
  for(const event of observed){
   assert.equal(event.workdayId,run.id,label);assert.equal(event.projectId,attempt.projectId,label);assert.equal(event.status,'recorded',label);
   const context=row(event.context);for(const[key,value]of Object.entries(common))assert.deepEqual(context[key],value,label+': Changed '+key);
   assert.ok(event.eventType==='assignment.retry-requested'?Number.isSafeInteger(context.nodeRevision)&&Number(context.nodeRevision)>=attempt.nodeRevision:context.nodeRevision===attempt.nodeRevision,label+': Changed node revision');
   assert.ok(clock(event.createdAt)>=created,label+': Transition before creation');
   if(event!==birth)assert.ok(Number(event.eventIndex)>Number(birth.eventIndex),label+': Transition before creation observation');
  }
  assert.equal(row(birth.context).status,'created',label);
  const leases=observed.filter(event=>event.eventType==='assignment.leased');
  for(const event of leases){version(event,'assignment-lease:'+attempt.id+':');assert.equal(row(event.context).status,'leased',label);}
  if(item.claimedAt!==undefined&&item.claimedAt!==null){
   const first=leases.filter(event=>clock(event.createdAt)===clock(item.claimedAt)&&version(event,'assignment-lease:'+attempt.id+':')<=Number(item.stateVersion));
   assert.equal(first.length,1,label+': Missing original claim');
  }else assert.ok(leases.every(event=>version(event,'assignment-lease:'+attempt.id+':')>Number(item.stateVersion)),label+': Unmatched original claim');
  let execution:Row|undefined,closeout:Row|undefined;
  for(const phase of ['execution','closeout']as const){
   const window=metadata[phase+'Window'];if(window===undefined)continue;
   const original=row(window),event=one('assignment.'+phase+'.started');assert.equal(event.id,'assignment-'+phase+':'+attempt.id,label);assert.equal(clock(event.createdAt),clock(original.startedAt),label);
   assert.equal(row(event.context).status,phase==='execution'?'running':'closeout',label);
   assert.ok(leases.some(lease=>Number(lease.eventIndex)<Number(event.eventIndex)&&clock(lease.createdAt)<=clock(event.createdAt)),label+': Window without earlier claim');
   if(phase==='execution')execution=event;else closeout=event;
  }
  if(execution&&closeout)assert.ok(Number(execution.eventIndex)<Number(closeout.eventIndex)&&clock(execution.createdAt)<=clock(closeout.createdAt),label+': Reversed productive windows');
  const terminalTypes=['completed','failed','returned','cancelled','expired'],terminal=observed.filter(event=>terminalTypes.includes(String(event.eventType).slice('assignment.'.length)));
  for(const event of terminal){
   const originalVersion=version(event,'assignment-terminal:'+attempt.id+':'),context=row(event.context);assert.equal(context.status,String(event.eventType).slice('assignment.'.length),label);
   if(originalVersion<=Number(item.stateVersion))assert.deepEqual(context.resultId,item.assignmentResult?row(item.assignmentResult).id:null,label+': Changed canonical result');
  }
  if(terminalTypes.includes(String(item.status))){
   const matches=terminal.filter(event=>event.eventType==='assignment.'+String(item.status)&&version(event,'assignment-terminal:'+attempt.id+':')<=Number(item.stateVersion));
   assert.equal(matches.length,1,label+': Missing owning terminal transition');const event=matches[0]!;
   if(item.status==='completed')assert.equal(clock(event.createdAt),clock(item.completedAt),label+': Changed completion clock');
   if(item.status==='returned')assert.equal(clock(event.createdAt),clock(item.returnedAt),label+': Changed return clock');
   if(item.status==='failed'||item.status==='expired')assert.equal(clock(event.createdAt),clock(item.failedAt),label+': Changed failure clock');
   if(attempt.finishedAt!==undefined)assert.ok(terminal.some(value=>clock(value.createdAt)===clock(attempt.finishedAt)&&version(value,'assignment-terminal:'+attempt.id+':')<=Number(item.stateVersion)),label+': Missing original terminal clock');
   for(const window of [execution,closeout])if(window)assert.ok(Number(window.eventIndex)<Number(event.eventIndex)&&clock(window.createdAt)<=clock(event.createdAt),label+': Terminal precedes its productive window');
  }
  if(metadata.cancellationRequested===true){
   const event=one('assignment.cancellation-requested'),context=row(event.context),parameters=row(event.parameters);
   assert.equal(context.status,'leased',label);assert.ok(leases.some(value=>Number(value.eventIndex)<Number(event.eventIndex)&&clock(value.createdAt)<=clock(event.createdAt)),label+': Cancellation request must follow claim');
   assert.equal(event.id,'assignment-cancellation-requested:'+attempt.id,label);assert.equal(clock(event.createdAt),clock(metadata.cancellationRequestedAt),label);
   assert.ok(Number.isSafeInteger(context.stateVersion)&&Number(context.stateVersion)<=Number(item.stateVersion)&&Number(context.stateVersion)>1,label);
   assert.deepEqual(parameters.actorId,metadata.cancellationRequestedBy,label);assert.ok(typeof parameters.idempotencyKey==='string'&&parameters.idempotencyKey.trim(),label);
  }
  if(metadata.operatorRetry!==undefined){
   const retry=row(metadata.operatorRetry),event=one('assignment.retry-requested'),context=row(event.context),parameters=row(event.parameters),written=version(event,'assignment-retry:'+attempt.id+':');
   assert.equal(terminal.filter(value=>row(value.context).status===context.status&&version(value,'assignment-terminal:'+attempt.id+':')<written
    &&Number(value.eventIndex)<Number(event.eventIndex)&&clock(value.createdAt)<=clock(event.createdAt)).length,1,label+': Retry must follow its original terminal observation');
   assert.equal(written,context.stateVersion,label);assert.ok(written<=Number(item.stateVersion),label);assert.equal(clock(event.createdAt),clock(retry.requestedAt),label);
   assert.deepEqual(parameters.actorId,retry.requestedBy,label);assert.deepEqual(parameters.reason,retry.reason,label);assert.ok(typeof parameters.idempotencyKey==='string'&&parameters.idempotencyKey.trim(),label);
  }
 }
}


/** Same immutable event check for show pagination and the post-assignment public inventory. */
export function retainCampaignEventHistory(events:readonly unknown[],run:Row,retained:Map<string,Row>,capture?:(event:Row)=>void):Row[]{
 const workdayId=String(run.id);
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
 for(const[id,event]of current)if(!retained.has(id))capture?.(structuredClone(event));
	for (const [id, event] of current) retained.set(id, structuredClone(event));
	return [...current.values()];
}

/** Complete existing node observations must explain the independently read
 * current node inventory. This creates no graph or transition authority. */
export function verifyNodeTransitionHistory(run:Row,graph:Row,events:readonly Row[]):void{
 const label='ACCEPTANCE_NODE_TRANSITIONS',statuses=new Set(['proposed','blocked','ready','assigned','running','completed','failed','cancelled','stale']);
 const started=Date.parse(typeof run.startedAt==='string'?run.startedAt:'');assert.ok(Number.isFinite(started),label+': Original owning workday start required');
 assert.equal(graph.teamId,run.teamId,label+': Foreign owning graph');assert.ok(Number.isSafeInteger(graph.revision)&&Number(graph.revision)>=0,label+': Exact graph revision required');
 assert.ok(Array.isArray(graph.nodes),label+': Complete owning node inventory required');
 const nodes=new Map<string,ReturnType<typeof executionNodeSchema.parse>>();
 for(const value of graph.nodes){const parsed=executionNodeSchema.safeParse(value);assert.ok(parsed.success,label+': Canonical owning node required');assert.deepEqual(parsed.data,value,label+': Owning node must not be normalized');
  const node=parsed.data;assert.equal(node.teamId,run.teamId,label+': Foreign node team');assert.ok(!nodes.has(node.id),label+': Duplicate owning node');assert.ok(node.graphRevisionUpdated<=Number(graph.revision),label+': Future owning node');nodes.set(node.id,node);
 }
 const histories=new Map<string,Array<{event:Row;context:Row;clock:number}>>(),ids=new Set<string>(),indexes=new Set<number>();
 for(const event of events){if(event.eventType!=='execution.node.state')continue;
  assert.equal(event.teamId,run.teamId,label+': Foreign event team');assert.equal(event.runId,run.id,label+': Foreign event run');assert.equal(event.workdayId,run.id,label+': Foreign event workday');assert.equal(event.assignmentId,null,label+': Node observations are not assignment records');assert.equal(event.status,'recorded',label+': Failed node observation');
  assert.ok(typeof event.id==='string'&&event.id&&!ids.has(event.id),label+': Duplicate observation');ids.add(event.id);
  assert.ok(Number.isSafeInteger(event.eventIndex)&&Number(event.eventIndex)>=0&&!indexes.has(Number(event.eventIndex)),label+': Duplicate transition index');indexes.add(Number(event.eventIndex));
  assert.ok(event.context&&typeof event.context==='object'&&!Array.isArray(event.context),label+': Missing original node context');const context=event.context as Row;
  assert.ok(typeof context.nodeId==='string',label+': Exact node identity required');const node=nodes.get(context.nodeId);assert.ok(node,label+': Observed owning node missing');
  assert.equal(event.projectId,node.projectId,label+': Foreign node project');assert.ok(node.workdayId===undefined||node.workdayId===run.id,label+': Foreign owning workday');
  assert.ok(Number.isSafeInteger(context.nodeRevision)&&Number(context.nodeRevision)>=1,label+': Exact node revision required');
  assert.ok(Number.isSafeInteger(context.graphRevision)&&Number(context.graphRevision)>=node.graphRevisionCreated&&Number(context.graphRevision)<=Number(graph.revision),label+': Original graph revision missing or in the future');
  assert.ok(statuses.has(String(context.status)),label+': Unknown node state');assert.ok(context.previousStatus===null||statuses.has(String(context.previousStatus)),label+': Original previous state required');
  const clock=Date.parse(typeof event.createdAt==='string'?event.createdAt:'');assert.ok(Number.isFinite(clock)&&clock>=started,label+': Original transition cannot precede its owning workday');
  const history=histories.get(node.id)??[],prior=history.at(-1);
  if(prior){assert.ok(Number(event.eventIndex)>Number(prior.event.eventIndex)&&clock>=prior.clock,label+': Reversed transition order');assert.equal(context.previousStatus,prior.context.status,label+': Missing node transition');
   assert.ok(Number(context.nodeRevision)>=Number(prior.context.nodeRevision)&&Number(context.nodeRevision)<=Number(prior.context.nodeRevision)+1,label+': Missing or regressed node revision');
   assert.ok(Number(context.graphRevision)>=Number(prior.context.graphRevision),label+': Regressed graph revision');assert.ok(context.status!==prior.context.status||context.nodeRevision!==prior.context.nodeRevision,label+': Duplicate unchanged transition');
  }else if(node.workdayId===run.id)assert.equal(context.previousStatus,null,label+': Missing original node birth');
  history.push({event,context,clock});histories.set(node.id,history);
 }
 for(const node of nodes.values()){
  const history=histories.get(node.id);if(node.workdayId!==run.id&&!history)continue;
  assert.ok(history?.length,label+': Missing original owning node history');const last=history.at(-1)!.context;
  assert.equal(last.status,node.status,label+': Current node state lacks its transition');assert.equal(last.nodeRevision,node.nodeRevision,label+': Current node revision lacks its transition');assert.ok(Number(last.graphRevision)<=node.graphRevisionUpdated,label+': Node observation exceeds its owning graph revision');
 }
}
/** Existing public inventories must explain every accounting observation;
 * history never reconstructs a missing producer row or creates charge authority. */
export function verifyAccountingTransitionHistory(run:Row,assignments:readonly Row[],usage:readonly Row[],ledger:readonly Row[],events:readonly Row[]):void{
 const label='ACCEPTANCE_ACCOUNTING_TRANSITIONS',clock=(value:unknown)=>{assert.ok(typeof value==='string'&&Number.isFinite(Date.parse(value)),label+': Original accounting clock required');return Date.parse(value);};
 const number=(value:unknown)=>{assert.ok(typeof value==='number'&&Number.isFinite(value)&&value>=0,label+': Original nonnegative numeric accounting required');return value;};
 const started=clock(run.startedAt),history=retainCampaignEventHistory(events,run,new Map()),owners=new Map<string,{item:Row;attempt:ReturnType<typeof assignmentAttemptSchema.parse>}>();
 for(const item of assignments){const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt);assert.deepEqual(attempt,item.assignmentAttempt,label+': Issued authority must already be canonical');
  assert.equal(item.id,attempt.id,label);assert.equal(attempt.teamId,run.teamId,label);assert.equal(attempt.workdayId,run.id,label);assert.equal(item.projectId,attempt.projectId,label);assert.ok(!owners.has(attempt.id),label+': Duplicate owning attempt');owners.set(attempt.id,{item,attempt});
 }
 const current=(items:readonly Row[],kind:'usage'|'ledger')=>{const result=new Map<string,Row>();for(const value of items){assert.ok(typeof value.id==='string'&&value.id&&!result.has(value.id),label+': Duplicate or missing '+kind+' identity');
  const owner=owners.get(String(value.assignmentId));assert.ok(owner,label+': Public '+kind+' omitted its original owning assignment');const{attempt}=owner;
  assert.equal(value.projectId,attempt.projectId,label);assert.equal(value.workDayId,run.id,label);assert.equal(value.capacityProviderId,attempt.provider.providerId,label);
  if(kind==='usage'){assert.equal(value.assignmentAttempt,attempt.attempt,label);assert.equal(value.executionProviderId,attempt.provider.executionProviderId,label);assert.ok(['informational','incremental','aggregate'].includes(String(value.accountingMode)),label);}
  else{assert.equal(value.teamId,run.teamId,label);assert.equal(value.reservationId,attempt.reservationId,label);assert.equal(value.phase,'task_completed_actual_settlement',label);}
  const native=kind==='usage'?row(value.nativeUsage):undefined;number(value.activeSeconds);number(value.elapsedSeconds);assert.ok(clock(value.createdAt)>=clock(attempt.createdAt),label+': Accounting precedes its original attempt');
  if(native){for(const unit of Object.values(native))number(unit);for(const field of['activeSeconds','elapsedSeconds'])if(Object.hasOwn(native,field))assert.equal(native[field],value[field],label+': Native repeated seconds disagree');}
  result.set(value.id,value);
 }return result;};
 const currentUsage=current(usage,'usage'),currentLedger=current(ledger,'ledger'),seenUsage=new Set<string>(),seenLedger=new Set<string>(),byOwner=new Map<string,Row[]>(),counterVersions=new Map<string,{version:number;authority:unknown}>();
 for(const event of history){if(event.eventType!=='capacity.accounting.updated')continue;
  const owner=owners.get(String(event.assignmentId));assert.ok(owner,label+': Accounting observation omitted its original owner');const{item,attempt}=owner,context=row(event.context),reservation=row(context.reservation),prior=byOwner.get(attempt.id)??[];
  assert.equal(event.workdayId,run.id,label);assert.equal(event.projectId,attempt.projectId,label);assert.equal(event.status,'recorded',label);
  for(const field of['parameters','metadata','refs'])assert.deepEqual(event[field],{},label+': Unchanged owning accounting envelope required');
  assert.deepEqual(Object.keys(context).sort(),['reservation','usageActual','ledgerEntry','remainingSupply'].sort(),label+': Complete original accounting context required');
  const expected={id:attempt.reservationId,idempotencyKey:attempt.idempotencyKey,assignmentId:attempt.id,teamId:attempt.teamId,projectId:attempt.projectId,workDayId:attempt.workdayId,
   capacityProviderId:attempt.provider.providerId,executionProviderId:attempt.provider.executionProviderId,membershipId:item.membershipId,requestedSeconds:attempt.limits.maximumSeconds,reservedSeconds:attempt.limits.maximumSeconds,createdAt:attempt.createdAt};
  for(const[key,value]of Object.entries(expected))assert.deepEqual(reservation[key],value,label+': Reservation changed '+key);
  assert.equal(reservation.mode,['planning','estimating'].includes(attempt.effectiveProfile.activity)?'planning':'acting',label);
  assert.ok(['reserved','consuming','consumed'].includes(String(reservation.state)),label+': Normal SDK accounting cannot hide unresolved recovery or failed custody');
  for(const field of['requestedSeconds','reservedSeconds','activeSeconds','elapsedSeconds','releasedSeconds','overrunSeconds'])number(reservation[field]);
  const at=clock(event.createdAt);assert.ok(at>=started&&at>=clock(attempt.createdAt),label);assert.equal(clock(reservation.updatedAt),at,label+': Observation differs from actual reservation mutation clock');
  if(prior.length){assert.ok(Number(event.eventIndex)>Number(prior.at(-1)!.eventIndex)&&at>=clock(prior.at(-1)!.createdAt),label+': Reversed accounting history');assert.equal(row(prior.at(-1)!.context).ledgerEntry,null,label+': Accounting continued after terminal settlement');}
  const measurement=context.usageActual===null?null:row(context.usageActual),entry=context.ledgerEntry===null?null:row(context.ledgerEntry);
  if(!prior.length){assert.equal(measurement,null,label+': Original reservation admission missing');assert.equal(entry,null,label);assert.equal(reservation.state,'reserved',label);assert.equal(at,clock(attempt.createdAt),label);
   for(const field of['activeSeconds','elapsedSeconds','releasedSeconds','overrunSeconds'])assert.equal(reservation[field],0,label);
  }else{assert.ok(measurement,label+': Duplicate admission or unresolved recovery is not normal SDK accounting');}
  if(measurement){assert.ok(typeof measurement.id==='string'&&!seenUsage.has(measurement.id),label+': Duplicate usage observation');assert.deepEqual(measurement,currentUsage.get(measurement.id),label+': Missing or changed public usage');seenUsage.add(measurement.id);
   assert.equal(clock(measurement.createdAt),at,label);assert.ok(Number(measurement.activeSeconds)<=attempt.limits.maximumSeconds,label+': Actual productive usage exceeded original authority');
  }
  if(entry){assert.ok(measurement&&measurement.accountingMode==='aggregate',label+': Terminal settlement requires its original aggregate');assert.ok(typeof entry.id==='string'&&!seenLedger.has(entry.id),label+': Duplicate settlement observation');
   assert.deepEqual(entry,currentLedger.get(entry.id),label+': Missing or changed public settlement');seenLedger.add(entry.id);assert.equal(reservation.state,'consumed',label);
   const settled=usageSettlementSchema.parse(entry.usageSettlement);assert.deepEqual(settled,entry.usageSettlement,label+': Stored settlement must already be canonical');
   for(const[key,value]of Object.entries({id:entry.id,idempotencyKey:entry.settlementKey,assignmentId:attempt.id,reservationId:attempt.reservationId,teamId:run.teamId,projectId:attempt.projectId,workdayId:run.id,providerId:attempt.provider.providerId,agentClass:attempt.agentClass,actualSeconds:measurement.activeSeconds,settledAt:event.createdAt}))assert.deepEqual(Reflect.get(settled,key),value,label);
   assert.deepEqual(settled.nativeUsage,measurement.nativeUsage,label);assert.equal(clock(entry.createdAt),at,label);
   for(const field of['activeSeconds','elapsedSeconds']){assert.equal(entry[field],measurement[field],label);assert.equal(reservation[field],measurement[field],label);}
   assert.equal(reservation.releasedSeconds,Math.max(0,attempt.limits.maximumSeconds-Number(measurement.activeSeconds)),label);assert.equal(reservation.overrunSeconds,Math.max(0,Number(measurement.activeSeconds)-attempt.limits.maximumSeconds),label);
   assert.deepEqual(reservation.consumedProviderUnits,entry.providerUnits,label);assert.deepEqual(reservation.consumedUsd,entry.usd,label);
  }else if(measurement){assert.ok(measurement.accountingMode==='informational'||measurement.accountingMode==='incremental',label+': Aggregate lacks its atomic settlement');assert.ok(reservation.state==='reserved'||reservation.state==='consuming',label);}
  assert.ok(Array.isArray(context.remainingSupply)&&context.remainingSupply.length===2,label+': Complete original model and capability claims required');
  const scopes=new Set<string>(),claimIds=new Set<string>();
  for(const value of context.remainingSupply){const counter=row(value);assert.ok(typeof counter.id==='string'&&counter.id&&!claimIds.has(counter.id),label+': Missing or duplicate supply claim');claimIds.add(counter.id);
   assert.ok(counter.scope==='model-day'||counter.scope==='capability-day',label+': Foreign supply scope');assert.ok(!scopes.has(String(counter.scope)),label+': Duplicate supply scope');scopes.add(String(counter.scope));
   assert.equal(counter.scopeId,JSON.stringify([attempt.provider.providerId,attempt.provider.modelConfigurationId,...(counter.scope==='capability-day'?[attempt.provider.executionCapabilityId]:[])]),label);
   assert.equal(counter.periodKey,attempt.createdAt.slice(0,10),label);assert.ok(typeof counter.teamId==='string'&&counter.teamId,label+': Original shared counter owner required');assert.equal(counter.releasePolicy,'actual-settlement',label);
   for(const field of['hardLimit','committedAmount','reservedAmount','releasedAmount','remainingAmount','stateVersion'])number(counter[field]);assert.ok(Number.isSafeInteger(counter.stateVersion)&&Number(counter.stateVersion)>=1,label);
   assert.equal(counter.reservedAmount,attempt.limits.maximumSeconds,label);assert.equal(counter.releasedAmount,entry?reservation.releasedSeconds:0,label);assert.equal(counter.remainingAmount,Math.max(0,Number(counter.hardLimit)-Number(counter.committedAmount)),label);
   const authority=[counter.teamId,counter.scope,counter.scopeId,counter.periodKey,counter.hardLimit],previous=counterVersions.get(counter.id);if(previous){assert.deepEqual(authority,previous.authority,label+': Frozen supply authority changed');assert.ok(Number(counter.stateVersion)>=previous.version,label+': Shared counter version regressed');}
   counterVersions.set(counter.id,{version:Number(counter.stateVersion),authority});
  }
  if(prior.length)assert.deepEqual([...claimIds].sort(),(row(prior[0]!.context).remainingSupply as Row[]).map(value=>String(value.id)).sort(),label+': Original supply claims changed');
  prior.push(event);byOwner.set(attempt.id,prior);
 }
 assert.deepEqual([...seenUsage].sort(),[...currentUsage.keys()].sort(),label+': Public usage lacks its original observation');assert.deepEqual([...seenLedger].sort(),[...currentLedger.keys()].sort(),label+': Public settlement lacks its original observation');
 for(const[id]of owners){const owned=byOwner.get(id);assert.ok(owned?.length,label+': Original reservation admission missing');if(run.status==='completed')assert.ok(row(owned.at(-1)!.context).ledgerEntry,label+': Completed workday lacks final accounting closure');}
}
/** Reconcile every original lifecycle mutation with the public Workday; existing reservation receipts remain derived. */
export function verifyWorkdayLifecycleTransitionHistory(run:Row,events:readonly Row[]):void{
 const label='ACCEPTANCE_WORKDAY_TRANSITIONS',current=verifyAppliedWorkdayCustody(run),history=retainCampaignEventHistory(events,run,new Map()).filter(event=>event.eventType==='workday.lifecycle.changed');

 const clock=(value:unknown)=>{assert.ok(typeof value==='string'&&Number.isFinite(Date.parse(value)),label+': Original lifecycle clock required');return Date.parse(value);};
 const states=['planned','active','closing','ended'],roundStates=['pending','active','complete'];
 if(!history.length){assert.ok(current.state==='planned'&&current.planningRounds.length===0&&run.status!=='completed',label+': Original lifecycle observations missing');return;}
 let previous:ReturnType<typeof appliedWorkdaySchema.parse>|undefined,previousStatus:unknown,at=clock(run.startedAt),observedCurrent=false;
 for(const event of history){
  assert.equal(event.workdayId,run.id,label);assert.equal(event.projectId,null,label);assert.equal(event.assignmentId,null,label);assert.equal(event.status,'recorded',label);assert.equal(event.title,null,label);assert.equal(event.message,null,label);
  for(const field of['parameters','metadata','refs'])assert.deepEqual(event[field],{},label+': Original lifecycle envelope required');
  const context=row(event.context);assert.deepEqual(Object.keys(context).sort(),['previousStatus','status','previousPlan','plan'].sort(),label+': Exact original lifecycle context required');
  assert.equal(event.id,'workday-lifecycle:'+run.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex'),label+': Changed original transition identity');
  const before=context.previousPlan===null?null:appliedWorkdaySchema.parse(context.previousPlan),next=appliedWorkdaySchema.parse(context.plan);assert.deepEqual(before,context.previousPlan,label+': Previous plan is not canonical');assert.deepEqual(next,context.plan,label+': Next plan is not canonical');
  for(const plan of[before,next].filter(value=>value!==null))for(const field of['id','teamId','executionMode','startsAt','endsAt','policyId','policyRevision','policySnapshot'])assert.deepEqual(Reflect.get(plan,field),Reflect.get(current,field),label+': Original frozen lifecycle authority changed');
  if(before===null){
   assert.equal(previous,undefined,label+': Repeated initial plan creation');assert.ok(context.previousStatus==='queued'||context.previousStatus==='running',label+': Original initial status required');
   assert.equal(context.status,'running',label);assert.equal(next.state,'active',label+': Original initial active plan required');assert.equal(next.activatedAt,next.startsAt,label);const prefix='planning:'+next.id+':1:',agentIds=next.planningRounds.flatMap(round=>round.assignmentIds.map(id=>{assert.ok(id.startsWith(prefix)&&id.length>prefix.length,label+': Original compiled planning identity required');return id.slice(prefix.length);}));
   const compiled=compileWorkday({id:next.id,teamId:next.teamId,executionMode:next.executionMode,policyId:next.policyId,policyRevision:next.policyRevision,policy:next.policySnapshot,startsAt:next.startsAt,agentIds});assert.deepEqual(workdayLifecycleAuthority(next),workdayLifecycleAuthority({...compiled,state:'active',activatedAt:compiled.startsAt}),label+': Original compiled initial plan required');
   for(const field of['closingAt','endedAt','reportRef'])assert.equal(Reflect.get(next,field),undefined,label+': Initial plan cannot borrow later products');
   const now=clock(event.createdAt);assert.ok(now>=at,label+': Reversed initial observation clock');at=now;previous=next;previousStatus=context.status;
   if(isDeepStrictEqual(workdayLifecycleAuthority(next),workdayLifecycleAuthority(current))&&context.status===run.status)observedCurrent=true;continue;
  }
  assert.ok(previous,label+': Original initial plan creation missing');
  if(isDeepStrictEqual(workdayLifecycleAuthority(before),workdayLifecycleAuthority(current))&&context.previousStatus===run.status||isDeepStrictEqual(workdayLifecycleAuthority(next),workdayLifecycleAuthority(current))&&context.status===run.status)observedCurrent=true;
  if(previous){assert.deepEqual(workdayLifecycleAuthority(before),workdayLifecycleAuthority(previous),label+': Missing original lifecycle transition');assert.equal(context.previousStatus,previousStatus,label+': Missing original status transition');}
  else{assert.equal(before.state,'planned',label+': Initial lifecycle transition missing');assert.equal(before.planningRounds.length,0,label+': Initial planning history missing');assert.ok(context.previousStatus==='queued'||context.previousStatus==='running',label+': Original starting status required');}
  assert.ok(states.indexOf(next.state)>=states.indexOf(before.state),label+': Regressed original lifecycle');assert.equal(context.status,next.state==='ended'?'completed':'running',label+': Plan and terminal status disagree');
  for(const round of before.planningRounds){const fresh=next.planningRounds.find(value=>value.round===round.round);assert.ok(fresh,label+': Lost original planning round');assert.deepEqual(fresh.assignmentIds,round.assignmentIds,label+': Original admitted turns changed');assert.ok(roundStates.indexOf(fresh.state)>=roundStates.indexOf(round.state),label+': Planning round regressed');for(const field of['startedAt','completedAt'])if(Reflect.get(round,field)!==undefined)assert.equal(Reflect.get(fresh,field),Reflect.get(round,field),label+': Original planning clocks changed');}
  for(const field of['activatedAt','closingAt','endedAt','reportRef'])if(Reflect.get(before,field)!==undefined)assert.deepEqual(Reflect.get(next,field),Reflect.get(before,field),label+': Original lifecycle product or clock changed');
  assert.ok(context.previousStatus!==context.status||!isDeepStrictEqual(before,next),label+': Duplicate unchanged lifecycle observation');const now=clock(event.createdAt);assert.ok(now>=at,label+': Reversed lifecycle clock');at=now;previous=next;previousStatus=context.status;
 }
 assert.ok(previous&&observedCurrent,label+': Current Workday omits its original transition');
 // As with assignment observations, later public events are retained and validated before the next original Workday poll. A terminal read must match the final transition.
 if(run.status==='completed'){assert.deepEqual(workdayLifecycleAuthority(previous),workdayLifecycleAuthority(current),label+': Terminal Workday omits its final transition');assert.equal(previousStatus,run.status,label+': Terminal status omits its final transition');}
 if(current.state==='ended'){assert.equal(current.reportRef?.kind,'treedx',label+': Reporter product missing');assert.equal(current.endedAt,run.completedAt,label+': Original terminal clocks disagree');}
}
function workdayLifecycleAuthority(plan:ReturnType<typeof appliedWorkdaySchema.parse>){const{admittedSecondsByProject:_projects,admittedSecondsByAgentClass:_agents,...original}=plan;return original;}

/** Reporter retains the original closing input; the public lifecycle remains the sole mutation authority. */
export function verifyFrozenReporterLifecycle(snapshot:Row,run:Row,reporter:Row,events:readonly Row[]):void{
 const label='ACCEPTANCE_REPORT_LIFECYCLE';verifyWorkdayLifecycleTransitionHistory(run,events);
 const current=verifyReportWorkdayAuthority(run),plan=verifyAppliedWorkdayCustody({...run,parameters:{...row(run.parameters),appliedPlan:row(row(snapshot.closingEvent).context).plan}});
 assert.equal(snapshot.teamId,run.teamId,label);assert.equal(snapshot.workdayId,run.id,label);assert.equal(plan.state,'closing',label+': Original frozen closing phase required');
 assert.ok(plan.planningRounds.every(round=>round.state==='complete'),label+': Every admitted planning round must have ended');
 const expected:Row={...workdayLifecycleAuthority(current),state:'closing'};delete expected.endedAt;delete expected.reportRef;
 assert.deepEqual(workdayLifecycleAuthority(plan),expected,label+': Frozen original planning history, policy, clocks or closing authority changed');
 const closing=events.filter(event=>event.eventType==='workday.lifecycle.changed'&&row(row(event.context).plan).state==='closing'&&row(row(event.context).previousPlan).state!=='closing');
 assert.equal(closing.length,1,label+': Exact original closing observation required');assert.deepEqual(snapshot.closingEvent,closing[0],label+': Frozen closing event differs from its public history');
 assert.deepEqual(workdayLifecycleAuthority(appliedWorkdaySchema.parse(row(closing[0]!.context).plan)),workdayLifecycleAuthority(plan),label+': Frozen plan differs from the original closing event');
 const closed=Date.parse(String(plan.closingAt)),issued=Date.parse(String(reporter.createdAt));assert.ok(Number.isFinite(closed)&&Number.isFinite(issued)&&closed<=issued&&closed>=Date.parse(String(run.startedAt)),label+': Reporter cannot precede its original closing observation');
}
