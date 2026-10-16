import {compileWorkday} from '@treeseed/sdk/agent-capacity';
import{expect,it}from'vitest';
import{createHash}from'node:crypto';
import{canonicalStandardsJson}from'@treeseed/sdk/standards';
import*as observation from'../../../../acceptance/workday/support/campaign-observation.ts';
import{lifecycleHistoryFixture}from'./lifecycle-history-fixture.ts';
type Row=Record<string,unknown>;
it('requires every original Workday plan and Reporter transition before continuing and retains exact failed observations without changing derived receipt authority',()=>{
 const f=lifecycleHistoryFixture(),held=structuredClone(f),check=Reflect.get(observation,'verifyWorkdayLifecycleTransitionHistory') as (run:Row,events:readonly Row[])=>void;expect(check).toBeTypeOf('function');
 const base=f.snapshots[0]!,initial={...compileWorkday({id:base.id,teamId:base.teamId,executionMode:base.executionMode,policyId:base.policyId,policyRevision:base.policyRevision,policy:base.policySnapshot,startsAt:base.startsAt,agentIds:['renamed-native-planner']}),state:'active' as const,activatedAt:base.startsAt};
 const born=structuredClone(f.events[0]!);(born.context as Row).plan=initial;born.id='workday-lifecycle:'+base.id+':'+createHash('sha256').update(canonicalStandardsJson(born.context)).digest('hex');
 check({...f.run,status:'running',completedAt:null,parameters:{...f.run.parameters,appliedPlan:initial}},[born]);
 for(const mode of ['completed-initial-round','later-initial-round','foreign-initial-turn','initial-turn-clock','initial-activation-clock','initial-closing-product','missing-initial-creation','duplicate-initial-creation']){
  const bad=structuredClone(born),context=bad.context as Row,plan=context.plan as Row,round=(plan.planningRounds as Row[])[0]!;
  if(mode==='completed-initial-round')round.state='complete';if(mode==='later-initial-round')round.round=2;if(mode==='foreign-initial-turn')round.assignmentIds=['foreign-turn'];if(mode==='initial-turn-clock')round.startedAt=base.startsAt;
  if(mode==='initial-activation-clock')plan.activatedAt='2026-10-16T12:00:01.000Z';if(mode==='initial-closing-product')plan.closingAt=base.startsAt;if(mode==='missing-initial-creation')context.previousPlan=base;
  bad.id='workday-lifecycle:'+base.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex');const events=mode==='duplicate-initial-creation'?[bad,{...structuredClone(bad),eventIndex:1}]:[bad],heldInitial=structuredClone(events);
  expect(()=>check({...f.run,status:'running',completedAt:null,parameters:{...f.run.parameters,appliedPlan:initial}},events),mode).toThrow();expect(events).toEqual(heldInitial);
 }

 check(f.run,f.events);check(f.run,f.events);const inFlight={...f.run,status:'running',completedAt:null,parameters:{...f.run.parameters,appliedPlan:f.snapshots[1]!}};check(inFlight,f.events);check(inFlight,f.events.slice(0,1));const derived=structuredClone(f.run);derived.parameters.appliedPlan.admittedSecondsByProject={later:9};check(derived,f.events);
 const resign=(event:Row)=>{event.id='workday-lifecycle:'+f.run.id+':'+createHash('sha256').update(canonicalStandardsJson(event.context)).digest('hex');};
 for(const mode of ['missing-0','missing-1','missing-2','missing-3','duplicate','foreign-team','foreign-run','wrong-id','broken-chain','regressed-state','lost-round','changed-policy','changed-deadline','wrong-terminal','wrong-clock','malformed-context']){
  const bad=structuredClone(f.events);if(mode.startsWith('missing-'))bad.splice(Number(mode.slice(8)),1);if(mode==='duplicate')bad.push(structuredClone(bad[1]!));
  const event=bad[1]!,context=event.context as Row;if(mode==='foreign-team')event.teamId='foreign';if(mode==='foreign-run')event.runId='foreign';if(mode==='wrong-id')event.id='foreign';
  if(mode==='broken-chain')(context.previousPlan as Row).state='planned';if(mode==='regressed-state')(context.plan as Row).state='planned';if(mode==='lost-round')(bad[2]!.context as Row).previousPlan={...(context.plan as Row),planningRounds:[]};
  if(mode==='changed-policy')(context.plan as Row).policyRevision=2;if(mode==='changed-deadline')(context.plan as Row).endsAt='2026-10-16T15:00:00.000Z';if(mode==='wrong-terminal')(bad[3]!.context as Row).status='running';if(mode==='wrong-clock')event.createdAt='2026-10-16T11:00:00.000Z';if(mode==='malformed-context')event.context={};
  if(mode!=='wrong-id')for(const value of bad)resign(value);bad.forEach((value,index)=>{value.eventIndex=index;});
  const before=structuredClone(bad);expect(()=>check(f.run,bad),mode).toThrow();expect(bad).toEqual(before);expect(f).toEqual(held);
 }
 check(f.run,f.events);expect(f).toEqual(held);
});
