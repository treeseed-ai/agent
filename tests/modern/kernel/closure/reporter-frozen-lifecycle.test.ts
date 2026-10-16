import{expect,it}from'vitest';
import*as observation from'../../../acceptance/workday/support/campaign-observation.ts';
import{lifecycleHistoryFixture}from'../../guarantees/monitoring/lifecycle/lifecycle-history-fixture.ts';
type Row=Record<string,unknown>;
it('requires the exact original closing event and all ended planning rounds in frozen Reporter input before accepting its ordinary report',()=>{
 const f=lifecycleHistoryFixture(),value:Row={teamId:f.run.teamId,workdayId:f.run.id,appliedPlan:f.snapshots[3],closingEvent:f.events[2]},reporter={id:'controlled-reporter',createdAt:f.run.parameters.appliedPlan.closingAt},held=structuredClone({f,value,reporter});
 const check=Reflect.get(observation,'verifyFrozenReporterLifecycle') as(value:Row,run:Row,reporter:Row,events:readonly Row[])=>void;expect(check).toBeTypeOf('function');check(value,f.run,reporter,f.events);check(value,f.run,reporter,f.events);
 for(const mode of ['missing-plan','missing-event','unfinished-round','lost-round','foreign-workday','foreign-event','changed-event','wrong-closing-time','changed-policy']){
  const bad=structuredClone(value),plan=bad.appliedPlan as Row,event=bad.closingEvent as Row;
  if(mode==='missing-plan')delete bad.appliedPlan;if(mode==='missing-event')delete bad.closingEvent;
  if(mode==='unfinished-round')(plan.planningRounds as Row[])[0]!.state='active';if(mode==='lost-round')plan.planningRounds=[];
  if(mode==='foreign-workday')plan.id='foreign';if(mode==='foreign-event')event.runId='foreign';if(mode==='changed-event')event.id='foreign';if(mode==='wrong-closing-time')plan.closingAt='2026-10-16T12:02:01.000Z';if(mode==='changed-policy')plan.policyRevision=2;
  const before=structuredClone(bad);expect(()=>check(bad,f.run,reporter,f.events),mode).toThrow();expect(bad).toEqual(before);expect({f,value,reporter}).toEqual(held);
 }
 const missing=structuredClone(f.events);missing.splice(2,1);missing.forEach((event,index)=>{event.eventIndex=index;});expect(()=>check(value,f.run,reporter,missing)).toThrow();
 expect(()=>check(value,f.run,{...reporter,createdAt:'2026-10-16T12:01:59.999Z'},f.events)).toThrow();
 check(value,f.run,reporter,f.events);expect({f,value,reporter}).toEqual(held);
});
