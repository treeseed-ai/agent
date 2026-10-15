import { reviewedRevisionFixture, reviewedDecision } from '../../kernel/architecture/custody/graph/review-readiness-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import * as transitionHistory from '../../../acceptance/workday/support/campaign-observation.ts';
import { verifyDerivedWorkdayModes } from '../../../acceptance/workday/support/campaign-observation.ts';
import { observeLiveAssignmentRecords } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import * as normalHistory from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { liveAssignmentGraph, liveAssignmentRecord, liveRun } from './live-assignment-fixture.ts';

describe('live canonical assignment observation (controlled inputs, not managed proof)', () => {
 it('retains every new original transition once and preserves prior history when immutable capture fails',()=>{
  const retain=Reflect.get(transitionHistory,'retainCampaignEventHistory')as(events:readonly Row[],run:Row,history:Map<string,Row>,capture:(event:Row)=>void)=>Row[];
  const run={id:'workday-original-history',teamId:'original-team'},event={id:'original-event',runId:run.id,teamId:run.teamId,eventIndex:0,eventType:'assignment.created',status:'recorded',createdAt:'2026-10-15T00:00:00.000Z',context:{original:'unchanged'},parameters:{},metadata:{},refs:{}},events=[event],history=new Map<string,Row>(),captured:Row[]=[],held=structuredClone(events);
  retain(events,run,history,value=>{captured.push(value);});expect.soft(captured).toEqual(events);expect(events).toEqual(held);expect(history.get(event.id)).toEqual(event);
  retain(events,run,history,value=>{captured.push(value);});expect.soft(captured).toEqual(events);
  const pending={...structuredClone(event),id:'pending-event',eventIndex:1},failure=new Error('Original capture interruption'),before=structuredClone(history);
  expect.soft(()=>retain([...events,pending],run,history,()=>{throw failure;})).toThrow(failure);expect(history).toEqual(before);expect(events).toEqual(held);
  retain([...events,pending],run,history,value=>{row(value.context).original='capture-only mutation';});expect(history.get(pending.id)).toEqual(pending);expect(events).toEqual(held);
 });

 it('requires every owning assignment transition beyond contiguous public event pages before campaign progress without changing original observations',()=>{
  const check=Reflect.get(transitionHistory,'verifyAssignmentTransitionHistory')as((run:Row,items:readonly Row[],events:readonly Row[])=>void)|undefined;
  expect(check,'complete assignment transition comparison is required').toBeTypeOf('function');if(!check)return;
  const item=liveAssignmentRecord(),run=liveRun(item),attempt=row(item.assignmentAttempt),created=String(item.createdAt),at=(seconds:number)=>new Date(Date.parse(created)+seconds*1000).toISOString();
  item.stateVersion=5;item.status='completed';item.leaseState='released';item.claimedAt=at(1);item.completedAt=at(4);item.updatedAt=at(4);
  attempt.status='completed';attempt.startedAt=at(2);attempt.finishedAt=at(4);item.assignmentResult={id:'original-result'};
  item.metadata={executionWindow:{startedAt:at(2)},closeoutWindow:{startedAt:at(3)}};
  const common={nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:null};
  const event=(id:string,eventType:string,status:string,createdAt:string,index:number)=>({id,runId:run.id,teamId:run.teamId,projectId:attempt.projectId,workdayId:run.id,assignmentId:item.id,eventIndex:index,eventType,status:'recorded',title:eventType,message:null,createdAt,parameters:{},metadata:{},refs:{},context:{...common,status}});
  const events=[event('assignment-created:'+item.id,'assignment.created','created',created,0),event('assignment-lease:'+item.id+':2','assignment.leased','leased',at(1),1),event('assignment-execution:'+item.id,'assignment.execution.started','running',at(2),2),event('assignment-closeout:'+item.id,'assignment.closeout.started','closeout',at(3),3),event('assignment-terminal:'+item.id+':5','assignment.completed','completed',at(4),4)];
  Object.assign(events[4]!.context,{resultId:'original-result'});const held=structuredClone({run,item,events});check(run,[item],events);
  for(let index=0;index<events.length;index++){const omitted=events.filter((_,i)=>i!==index).map((value,eventIndex)=>({...structuredClone(value),eventIndex})),before=structuredClone(omitted);expect(()=>check(run,[item],omitted),'omitted '+events[index]!.eventType).toThrow('ACCEPTANCE_ASSIGNMENT_TRANSITIONS');expect(omitted).toEqual(before);}
  for(const mode of ['wrong-team','wrong-run','wrong-project','wrong-node','wrong-revision','wrong-lease','wrong-reservation','wrong-clock','wrong-status','wrong-result','duplicate','wrong-identity','before-created']){
   const changed=structuredClone(events),value=changed[4]!;
   if(mode==='wrong-team')value.teamId='foreign';if(mode==='wrong-run')value.runId='foreign';if(mode==='wrong-project')value.projectId='foreign';if(mode==='wrong-node')value.context.nodeId='foreign';if(mode==='wrong-revision')value.context.nodeRevision=0;
   if(mode==='wrong-lease')value.context.leaseId='foreign';if(mode==='wrong-reservation')value.context.reservationId='foreign';if(mode==='wrong-clock')value.createdAt=at(5);if(mode==='wrong-status')value.context.status='failed';if(mode==='wrong-result')Object.assign(value.context,{resultId:'foreign'});
   if(mode==='duplicate')changed.push({...structuredClone(value),eventIndex:5});if(mode==='wrong-identity')value.id='foreign-terminal';if(mode==='before-created')value.createdAt=at(-1);
   const before=structuredClone(changed);expect(()=>check(run,[item],changed),mode).toThrow('ACCEPTANCE_ASSIGNMENT_TRANSITIONS');expect(changed).toEqual(before);
  }

  const failedItem=structuredClone(item);failedItem.status='failed';failedItem.failedAt=at(4);delete failedItem.completedAt;failedItem.stateVersion=7;
  row(failedItem.assignmentAttempt).status='failed';failedItem.metadata={...structuredClone(row(item.metadata)),cancellationRequested:true,cancellationRequestedAt:at(1),cancellationRequestedBy:'operator',operatorRetry:{requestedAt:at(5),requestedBy:'operator',reason:'Exact original retry'}};
  const failureEvents=structuredClone(events);failureEvents[4]!.id='assignment-terminal:'+item.id+':6';failureEvents[4]!.eventType='assignment.failed';failureEvents[4]!.context.status='failed';
  const cancellation=event('assignment-cancellation-requested:'+item.id,'assignment.cancellation-requested','leased',at(1),2),retry=event('assignment-retry:'+item.id+':7','assignment.retry-requested','failed',at(5),6);
  Object.assign(cancellation.context,{stateVersion:3});cancellation.parameters={idempotencyKey:'original-cancel',actorId:'operator',reason:'Exact original cancel'};
  Object.assign(retry.context,{stateVersion:7,nodeRevision:Number(attempt.nodeRevision)+1});retry.parameters={idempotencyKey:'original-retry',actorId:'operator',reason:'Exact original retry'};
  failureEvents.splice(2,0,cancellation);failureEvents.push(retry);failureEvents.forEach((value,eventIndex)=>{value.eventIndex=eventIndex;});const retainedFailure=structuredClone({failedItem,failureEvents});
  check(run,[failedItem],failureEvents);
  for(const mode of ['missing-cancel','missing-retry','cancel-actor','cancel-version','cancel-clock','retry-actor','retry-version','retry-clock','retry-reason','retry-key','retry-before-terminal']){
   const changed=structuredClone(failureEvents),cancelled=changed[2]!,retried=changed.at(-1)!;
   if(mode==='missing-cancel')changed.splice(2,1);if(mode==='missing-retry')changed.pop();
   if(mode==='cancel-actor')Object.assign(cancelled.parameters,{actorId:'foreign'});if(mode==='cancel-version')Object.assign(cancelled.context,{stateVersion:8});if(mode==='cancel-clock')cancelled.createdAt=at(2);
   if(mode==='retry-actor')Object.assign(retried.parameters,{actorId:'foreign'});if(mode==='retry-version')Object.assign(retried.context,{stateVersion:8});if(mode==='retry-clock')retried.createdAt=at(6);
   if(mode==='retry-reason')Object.assign(retried.parameters,{reason:'different'});if(mode==='retry-key')Object.assign(retried.parameters,{idempotencyKey:''});
   if(mode==='retry-before-terminal'){changed.pop();changed.splice(4,0,retried);}changed.forEach((value,eventIndex)=>{value.eventIndex=eventIndex;});const before=structuredClone(changed);
   expect.soft(()=>check(run,[failedItem],changed),mode).toThrow('ACCEPTANCE_ASSIGNMENT_TRANSITIONS');expect(changed).toEqual(before);
  }
  expect({failedItem,failureEvents}).toEqual(retainedFailure);check(run,[failedItem],failureEvents);

  for(const status of ['failed','returned','cancelled','expired']){
   const terminalItem=structuredClone(item),history=structuredClone(events);terminalItem.status=status;row(terminalItem.assignmentAttempt).status=status==='returned'?'blocked':status;
   delete terminalItem.completedAt;if(status==='returned')terminalItem.returnedAt=at(4);else terminalItem.failedAt=at(4);
   history[4]!.eventType='assignment.'+status;history[4]!.context.status=status;
   const before=structuredClone({terminalItem,history});check(run,[terminalItem],history);expect({terminalItem,history}).toEqual(before);
   const omitted=history.slice(0,-1);expect(()=>check(run,[terminalItem],omitted),status+' missing terminal').toThrow('ACCEPTANCE_ASSIGNMENT_TRANSITIONS');
  }
  const pendingItem=structuredClone(item);pendingItem.status='pending';pendingItem.leaseState='unleased';pendingItem.stateVersion=1;pendingItem.claimedAt=null;pendingItem.metadata={};
  delete pendingItem.completedAt;delete pendingItem.assignmentResult;const unstarted=row(pendingItem.assignmentAttempt);unstarted.status='created';delete unstarted.startedAt;delete unstarted.finishedAt;
  check(run,[pendingItem],[events[0]!]);const cancelledItem=structuredClone(pendingItem);cancelledItem.status='cancelled';cancelledItem.stateVersion=2;cancelledItem.failedAt=at(4);row(cancelledItem.assignmentAttempt).status='cancelled';row(cancelledItem.assignmentAttempt).finishedAt=at(4);
  const cancelledEvent=structuredClone(events[4]!);cancelledEvent.id='assignment-terminal:'+item.id+':2';cancelledEvent.eventIndex=1;cancelledEvent.eventType='assignment.cancelled';Object.assign(cancelledEvent.context,{status:'cancelled',resultId:null});
  check(run,[cancelledItem],[events[0]!,cancelledEvent]);check(run,[],[]);
  // A later producer transition may commit after the held assignment list.
  // Its original event remains observed; this comparison certifies the held rows.
  const next={...structuredClone(events[0]!),id:'assignment-created:later-attempt',assignmentId:'later-attempt',eventIndex:5};check(run,[item],[...events,next]);
  expect({run,item,events}).toEqual(held);check(run,[item],events);
 });

	it('requires complete original normal node revisions and denies duplicate issuance or unexplained extra revisions without repairing failed records', () => {
		const check = (normalHistory as unknown as Record<string, (items: Row[], graph: Row, decisions: ReadonlyMap<string, Row>, run: Row) => void>).verifyNormalAttemptRevisions;
		expect(check, 'original normal history must be verified before terminal success').toBeTypeOf('function');
		const item=liveAssignmentRecord(), graph=liveAssignmentGraph(item); item.status='completed';
		row(item.assignmentAttempt).status='completed';
		const before=structuredClone({item,graph}); check!([item],graph,new Map(),liveRun(item));
		for(const mode of ['duplicate','gap','first-revision','foreign-node','failed','returned','expired']) {
			const supplied=structuredClone(item), items=[supplied];
			if(mode==='duplicate') {const duplicate=structuredClone(item); duplicate.id='duplicate-issued-attempt'; row(duplicate.assignmentAttempt).id=duplicate.id; items.push(duplicate);}
			if(mode==='gap') {const extra=structuredClone(item); extra.id='extra-revision'; row(extra.assignmentAttempt).id=extra.id; row(extra.assignmentAttempt).nodeRevision=3; items.push(extra);}
			if(mode==='first-revision') row(supplied.assignmentAttempt).nodeRevision=2;
			if(mode==='foreign-node') row(supplied.assignmentAttempt).nodeId='unowned-node';
			if(['failed','returned','expired'].includes(mode)) supplied.status=mode;
			const failed=structuredClone(items); expect(() => check!(items,graph,new Map(),liveRun(item)),mode).toThrow('ACCEPTANCE_NORMAL_REVISIONS'); expect(items).toEqual(failed);
		}
		expect({item,graph}).toEqual(before); check!([item],graph,new Map(),liveRun(item));
		const revised=reviewedRevisionFixture(), originalReview=revised.assignments[1]!, decision=reviewedDecision(revised);
		decision.disposition='request-changes'; const decisions=new Map([[originalReview.id,decision]]);
		const run=liveRun(revised.assignments[0]!); check!(revised.assignments,revised.graph,decisions,run);
		const revisedBefore=structuredClone(revised);
		for(const mutation of ['missing-decision','approved-instead','changed-candidate','missing-first','early-correction']) {
			const supplied=structuredClone(revised), suppliedDecisions=new Map([[originalReview.id,structuredClone(decision)]]);
			if(mutation==='missing-decision') suppliedDecisions.clear();
			if(mutation==='approved-instead') suppliedDecisions.get(originalReview.id)!.disposition='approved';
			if(mutation==='changed-candidate') suppliedDecisions.get(originalReview.id)!.subjectRef.commit='f'.repeat(40);
			if(mutation==='missing-first') supplied.assignments.shift();
			if(mutation==='early-correction') supplied.assignments[2]!.assignmentAttempt.createdAt='2026-09-13T12:00:02.000Z';
			const failed=structuredClone({supplied,suppliedDecisions}); expect(() => check!(supplied.assignments,supplied.graph,suppliedDecisions,run),mutation).toThrow();
			expect({supplied,suppliedDecisions}).toEqual(failed);
		}
		expect(revised).toEqual(revisedBefore); check!(revised.assignments,revised.graph,decisions,run);
		const terminalRun={...liveRun(item),status:'completed'}, retired=structuredClone(graph); row((retired.nodes as Row[])[0]).status='stale'; row((retired.nodes as Row[])[0]).nodeRevision=2;
		check!([item],retired,new Map(),terminalRun); const retirementBefore=structuredClone(retired);
		expect(() => check!([item],retired,new Map(),{...terminalRun,status:'running'})).toThrow('ACCEPTANCE_NORMAL_REVISIONS');
		row((retired.nodes as Row[])[0]).nodeRevision=3; expect(() => check!([item],retired,new Map(),terminalRun)).toThrow('ACCEPTANCE_NORMAL_REVISIONS');
		const cancelled=structuredClone(item); cancelled.status='cancelled'; row(cancelled.assignmentAttempt).status='cancelled'; row(row(cancelled.assignmentAttempt).effectiveProfile).activity='planning';
		const handoffRun=liveRun(cancelled), parameters=row(handoffRun.parameters), boundary=new Date(Date.parse(handoffRun.startedAt)+Number(parameters.durationSeconds)*Number(parameters.planningPercent)*10).toISOString();
		cancelled.lifecycleCode='planning_boundary_cancelled'; cancelled.failedAt=boundary; row(cancelled.capacityEnvelope).budget={time:{authorityDeadlineAt:boundary,executionDeadlineAt:boundary}};
		cancelled.lifecycleOutput={performance:{disposition:'cancelled'}}; const cancelledGraph=liveAssignmentGraph(cancelled), handoffBefore=structuredClone(cancelled);
		check!([cancelled],cancelledGraph,new Map(),handoffRun);
		for(const mode of ['early','wrong-authority','acting','wrong-disposition']) {
			const denied=structuredClone(cancelled);
			if(mode==='early') denied.failedAt=new Date(Date.parse(boundary)-1).toISOString();
			if(mode==='wrong-authority') denied.lifecycleCode='assignment_cancelled';
			if(mode==='acting') row(row(denied.assignmentAttempt).effectiveProfile).activity='acting';
			if(mode==='wrong-disposition') row(row(denied.lifecycleOutput).performance).disposition='deadline_exhausted';
			const failed=structuredClone(denied); expect(() => check!([denied],cancelledGraph,new Map(),handoffRun),mode).toThrow('ACCEPTANCE_NORMAL_REVISIONS'); expect(denied).toEqual(failed);
		}
		expect(cancelled).toEqual(handoffBefore); check!([item],retirementBefore,new Map(),terminalRun);


	});

	it('retains exact derived public mode labels across assignment usage result and settlement views while denying every contradictory original label', () => {
		for (const executionMode of ['simulation', 'production']) {
			const run = { executionMode };
			const records = ['assignment', 'graph', 'usage', 'result', 'settlement'].map(kind => ({ kind, executionMode, metadata: { example: { executionMode: 'production' } } }));
			const before = structuredClone({ run, records }); verifyDerivedWorkdayModes(run, records); verifyDerivedWorkdayModes(run, [{ id: 'no-independent-label' }]);
			for (const value of [undefined, null, '', executionMode === 'simulation' ? 'production' : 'simulation', false, 0, {}, []]) for (let index = 0; index < records.length; index++) {
				const changed: Row[] = structuredClone(records); changed[index]!.executionMode = value;
				const failed = structuredClone(changed); expect(() => verifyDerivedWorkdayModes(run, changed)).toThrow('ACCEPTANCE_DERIVED_MODE'); expect(changed).toEqual(failed);
			}
			expect({ run, records }).toEqual(before);
		}
		for (const executionMode of [undefined, null, '', 'simulation ', false, 0, {}, []]) expect(() => verifyDerivedWorkdayModes({ executionMode }, [])).toThrow('ACCEPTANCE_DERIVED_MODE');
	});

	it('denies contradictory derived assignment mode before inspection without treating matching public labels as another authority', () => {
		for (const executionMode of [undefined, null, '', 'production', 'simulation ', false, 0, {}, []]) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			item.executionMode = executionMode;
			const before = structuredClone({ item, run, retained });
			expect.soft(() => observeLiveAssignmentRecords(run, [item], retained, inspect)).toThrow('ACCEPTANCE_DERIVED_MODE');
			expect.soft(inspect).not.toHaveBeenCalled(); expect.soft(retained.size).toBe(0); expect({ item, run, retained }).toEqual(before);
		}
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(); item.executionMode = run.executionMode;
		const before = structuredClone({ item, run }); observeLiveAssignmentRecords(run, [item], retained, () => {});
		expect({ item, run }).toEqual(before); expect(retained.size).toBe(1);
	});
	it('denies every duplicate Workday parameter mode before inspecting assignments and retains original failed observations unchanged', () => {
		for (const executionMode of [undefined, null, '', 'simulation', 'production', 'simulation ', false, 0, {}, []]) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			row(run.parameters).executionMode = executionMode;
			const before = structuredClone({ item, run, retained });
			expect.soft(() => observeLiveAssignmentRecords(run, [item], retained, inspect)).toThrow('ACCEPTANCE_START_MODE');
			expect.soft(inspect).not.toHaveBeenCalled(); expect.soft(retained.size).toBe(0);
			expect({ item, run, retained }).toEqual(before);
		}
	});

	it('denies normalized applied workday identity without retaining observations or rewriting original public bytes', () => {
		for (const field of ['id', 'teamId', 'policyId']) {
			const item = liveAssignmentRecord(), run = liveRun(item), plan = row(row(run.parameters).appliedPlan);
			plan[field] = ` ${String(plan[field])} `;
			const before = structuredClone({ item, run }), retained = new Map<string, Row>(), inspect = vi.fn();
			expect.soft(() => observeLiveAssignmentRecords(run, [item], retained, inspect), field).toThrow('ACCEPTANCE_START_RAW');
			expect.soft(retained.size, field).toBe(0); expect.soft(inspect, field).not.toHaveBeenCalled();
			expect({ item, run }).toEqual(before);
		}
	});
	it('denies newly observed lifecycle clocks before creation or start without retaining a partly verified batch or changing failed observations', () => {
		for (const mode of ['start-before-creation', 'finish-before-creation', 'finish-before-start']) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			const attempt = row(item.assignmentAttempt), created = Date.parse(String(attempt.createdAt));
			item.id = attempt.id = `invalid-clock-${item.id}`;
			if (mode === 'start-before-creation') attempt.startedAt = new Date(created - 1).toISOString();
			if (mode === 'finish-before-creation') attempt.finishedAt = new Date(created - 1).toISOString();
			if (mode === 'finish-before-start') {
				attempt.startedAt = new Date(created + 2).toISOString(); attempt.finishedAt = new Date(created + 1).toISOString();
			}
			const before = structuredClone({ item, run, retained });
			expect(() => observeLiveAssignmentRecords(run, [liveAssignmentRecord(), item], retained, inspect), mode).toThrow('Original lifecycle clock order');
			expect(inspect, mode).not.toHaveBeenCalled(); expect({ item, run, retained }, mode).toEqual(before);
		}
	});
	it('accepts equal lifecycle boundaries and retains late failed closeout as original evidence without extending its deadline', () => {
		for (const mode of ['unstarted', 'equal', 'late-failure']) {
			const item = liveAssignmentRecord(), attempt = row(item.assignmentAttempt), run = liveRun(item), retained = new Map<string, Row>();
			if (mode === 'unstarted') attempt.finishedAt = attempt.createdAt;
			if (mode === 'equal') attempt.startedAt = attempt.finishedAt = attempt.createdAt;
			if (mode === 'late-failure') {
				attempt.startedAt = attempt.createdAt; attempt.finishedAt = new Date(Date.parse(String(attempt.deadline)) + 1).toISOString();
				attempt.status = item.status = 'failed'; item.leaseState = 'released'; item.failedAt = attempt.finishedAt;
			}
			const before = structuredClone({ item, run });
			observeLiveAssignmentRecords(run, [item], retained, () => {});
			expect(retained.get(String(item.id))).toEqual(attempt); expect({ item, run }).toEqual(before);
		}
		// The exact workday end is allowed; one millisecond beyond it is not.
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
		row(item.assignmentAttempt).deadline = new Date(Date.parse(String(row(row(run.parameters).appliedPlan).endsAt)) + 1).toISOString();
		const before = structuredClone({ item, run, retained });
		expect(() => observeLiveAssignmentRecords(run, [item], retained, inspect)).toThrow('Original workday deadline');
		expect(inspect).not.toHaveBeenCalled(); expect({ item, run, retained }).toEqual(before);
	});
	it('observes empty initial admission then every new canonical attempt once without changing input or repeating independent inspection', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), before = structuredClone({ item, run }), retained = new Map<string, Row>(), inspect = vi.fn();
		observeLiveAssignmentRecords(run, [], retained, inspect);
		for (let i = 0; i < 3; i++) observeLiveAssignmentRecords(run, [item], retained, inspect);
		expect(inspect).toHaveBeenCalledExactlyOnceWith(item); expect(retained.get(String(item.id))).toEqual(item.assignmentAttempt);
		expect({ item, run }).toEqual(before); expect(retained.get(String(item.id))).not.toBe(item.assignmentAttempt);
	});
	it('denies malformed foreign duplicated unselected or unauthorized canonical rows before any new inspection and preserves observations', () => {
		for (const mode of ['missing-plan', 'plan-id', 'plan-team', 'plan-mode', 'plan-start', 'plan-end', 'plan-policy', 'deadline-at']) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			const parameters = row(run.parameters), plan = row(parameters.appliedPlan);
			if (mode === 'missing-plan') delete parameters.appliedPlan;
			if (mode === 'plan-id') plan.id = 'foreign'; if (mode === 'plan-team') plan.teamId = 'foreign';
			if (mode === 'plan-mode') plan.executionMode = 'production';
			if (mode === 'plan-start') plan.startsAt = new Date(Date.parse(String(plan.startsAt)) - 1).toISOString();
			if (mode === 'plan-end') plan.endsAt = new Date(Date.parse(String(plan.endsAt)) + 1).toISOString();
			if (mode === 'plan-policy') parameters.durationSeconds = Number(parameters.durationSeconds) + 1;
			if (mode === 'deadline-at') parameters.deadlineAt = new Date(Date.parse(String(plan.endsAt)) + 1).toISOString();
			const before = structuredClone({ item, run, retained });
			expect(() => observeLiveAssignmentRecords(run, [item], retained, inspect), mode).toThrow();
			expect(inspect, mode).not.toHaveBeenCalled(); expect({ item, run, retained }, mode).toEqual(before);
		}
		for (const mode of ['attempt', 'retired', 'team', 'workday', 'project', 'duplicate', 'clock', 'deadline', 'grant', 'workspace', 'context', 'mode']) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			observeLiveAssignmentRecords(run, [item], retained, inspect); inspect.mockClear();
			const changed = structuredClone(item), attempt = row(changed.assignmentAttempt); const items = [changed];
			if (mode === 'attempt') attempt.id = 'foreign'; if (mode === 'retired') changed.decisionInput = {};
			if (mode === 'team') run.teamId = 'foreign'; if (mode === 'workday') run.id = 'foreign';
			if (mode === 'project') row(run.parameters).scheduledProjectIds = ['foreign']; if (mode === 'duplicate') items.push(changed);
			if (mode === 'clock') run.startedAt = '2099-09-14T00:00:00.000Z'; if (mode === 'deadline') attempt.deadline = attempt.createdAt;
			if (mode === 'grant') row(attempt.grant).tools = ['source.read', 'source.write', 'release'];
			if (mode === 'workspace') attempt.workspace = { mode: 'read-only' }; if (mode === 'context') attempt.contextRefs = [];
			if (mode === 'mode') run.executionMode = 'production';
			const before = structuredClone({ items, run, retained });
			expect(() => observeLiveAssignmentRecords(run, items, retained, inspect), mode).toThrow();
			expect(inspect, mode).not.toHaveBeenCalled(); expect({ items, run, retained }, mode).toEqual(before);
		}
	});
	it('denies every changed issued authority field and disappearance while allowing only API lifecycle advancement with stable original clocks', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
		observeLiveAssignmentRecords(run, [item], retained, inspect);
		for (const field of ['idempotencyKey', 'nodeId', 'nodeRevision', 'graphRevision', 'sourceRef', 'authorityRefs', 'effectiveProfile', 'requiredCapabilities',
			'grant', 'provider', 'contextRefs', 'predecessorResultIds', 'acceptanceCriteria', 'workspace', 'estimate', 'limits', 'deadline', 'leaseId', 'reservationId', 'attempt']) {
			const changed = structuredClone(item); row(changed.assignmentAttempt)[field] = null;
			const before = structuredClone(retained); expect(() => observeLiveAssignmentRecords(run, [changed], retained, inspect), field).toThrow(); expect(retained).toEqual(before);
		}
		const changed = structuredClone(item); row(row(changed.assignmentAttempt).provider).runtimeBuild = `sha256:${'f'.repeat(64)}`;
		expect(() => observeLiveAssignmentRecords(run, [changed], retained, inspect)).toThrow('Issued authority changed');
		expect(() => observeLiveAssignmentRecords(run, [], retained, inspect)).toThrow('disappeared');
		const running = structuredClone(item); row(running.assignmentAttempt).status = 'running'; row(running.assignmentAttempt).startedAt = running.createdAt;
		observeLiveAssignmentRecords(run, [running], retained, inspect);
		for (const value of [undefined, '2026-09-13T12:00:01.000Z']) {
			const moved = structuredClone(running); row(moved.assignmentAttempt).startedAt = value;
			expect(() => observeLiveAssignmentRecords(run, [moved], retained, inspect)).toThrow('Original lifecycle clock changed');
		}
		expect(inspect).toHaveBeenCalledOnce();
		const statuses = ['created', 'leased', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'expired'];
		for (const previous of statuses) for (const next of statuses) {
			const terminal = statuses.indexOf(previous) >= 3;
			const backwards = statuses.indexOf(next) < statuses.indexOf(previous) && !terminal;
			const original = liveAssignmentRecord(), prior = row(original.assignmentAttempt), held = new Map<string, Row>();
			prior.status = previous;
			observeLiveAssignmentRecords(run, [original], held, () => {});
			const moved = structuredClone(original); row(moved.assignmentAttempt).status = next;
			const before = structuredClone({ moved, held }), deniedInspection = vi.fn();
			if (!backwards && (!terminal || next === previous)) {
				observeLiveAssignmentRecords(run, [moved], held, deniedInspection);
				expect(held.get(String(moved.id))).toEqual(moved.assignmentAttempt);
				expect(moved).toEqual(before.moved); expect(deniedInspection).not.toHaveBeenCalled(); continue;
			}
			expect(() => observeLiveAssignmentRecords(run, [moved], held, deniedInspection), `${previous} -> ${next}`).toThrow('Lifecycle status regressed or changed terminal disposition');
			expect(deniedInspection).not.toHaveBeenCalled(); expect({ moved, held }).toEqual(before);
			observeLiveAssignmentRecords(run, [original], held, deniedInspection);
			expect(held).toEqual(before.held); expect(deniedInspection).not.toHaveBeenCalled();
		}
	});
	it('preserves the original independent inspection failure and prior batch through denial and exact retry', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), original = new Error('controlled_denial');
		const before = structuredClone({ item, run, retained });
		expect(() => observeLiveAssignmentRecords(run, [item], retained, () => { throw original; })).toThrow(original);
		expect({ item, run, retained }).toEqual(before);
		observeLiveAssignmentRecords(run, [item], retained, () => {}); expect(retained.size).toBe(1);
	});
});
