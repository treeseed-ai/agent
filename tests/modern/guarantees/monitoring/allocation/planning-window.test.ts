import {describe,expect,it} from 'vitest';
import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import {verifyPlanningWindow} from '../../../../acceptance/workday/support/monitoring/assignment-allocation.ts';
import {row,type Row} from '../../../../acceptance/acceptance-cli.ts';
import {request} from '../../../kernel/provider-kernel-fixture.ts';
import {liveAssignmentRecord} from '../live-assignment-fixture.ts';
import {planningWindowScope} from './planning-window-fixture.ts';

function fixture(activity='acting'){
 const original=assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
 const attempt=assignmentAttemptSchema.parse({...original,deadline:'2026-09-13T12:01:00.000Z',effectiveProfile:{...original.effectiveProfile,activity}});
 const item=liveAssignmentRecord(attempt),scope=planningWindowScope(item);row(row(row(item.explanation).metadata).allocation).opportunity=scope.opportunity;return {item,run:scope.run};
}
describe('live original planning-window authority',()=>{
 it('retains original acting review planning estimating chat and reporting phase receipts at the initial floor and during fluid planning',()=>{
  for(const activity of ['acting','reviewing','planning','estimating','chat','reporting']){
   const f=fixture(activity),held=structuredClone(f);expect(()=>verifyPlanningWindow(f.item,f.run)).not.toThrow();expect(f).toEqual(held);
  }
 });
 it('denies early acting review foreign or malformed original workday authority without changing the failed observation before exact retry',()=>{
  const original=fixture(),failures:Row[]=[];
  for(const mode of ['early-acting','early-review','workday','team','start','policy','clock','missing-attempt']){
   const f=structuredClone(original),attempt=row(f.item.assignmentAttempt);
   if(mode.startsWith('early-')){attempt.createdAt='2026-09-13T11:59:59.999Z';f.item.createdAt=attempt.createdAt;if(mode==='early-review')row(attempt.effectiveProfile).activity='reviewing';}
   if(mode==='workday')attempt.workdayId='foreign';if(mode==='team')attempt.teamId='foreign';if(mode==='start')f.run.startedAt='2026-09-13T00:00:00.000Z';
   if(mode==='policy')delete row(f.run.parameters).appliedPlan;if(mode==='clock')attempt.createdAt='invalid';if(mode==='missing-attempt')delete f.item.assignmentAttempt;
   const held=structuredClone(f);expect(()=>verifyPlanningWindow(f.item,f.run)).toThrow('ACCEPTANCE_PLANNING_WINDOW');expect(f).toEqual(held);failures.push(held);
  }
  const held=structuredClone(failures);expect(()=>verifyPlanningWindow(original.item,original.run)).not.toThrow();expect(failures).toEqual(held);
 });
 it('denies missing malformed and contradictory original allocator phases without treating planning percentage as a new spending ceiling',()=>{
  for(const activity of ['acting','reviewing','planning','estimating','chat','reporting']){
   for(const value of [undefined,null,'ended',{},[],activity==='acting'||activity==='reviewing'||activity==='reporting'?'planning':'acting']){
    const f=fixture(activity),opportunity=row(row(row(row(f.item.explanation).metadata).allocation).opportunity);
    if(activity==='chat'){row(f.item.assignmentAttempt).createdAt='2026-09-13T11:59:59.999Z';f.item.createdAt='2026-09-13T11:59:59.999Z';}
    if(value===undefined)delete opportunity.phase;else opportunity.phase=value;
    const held=structuredClone(f);expect(()=>verifyPlanningWindow(f.item,f.run)).toThrow('ACCEPTANCE_PLANNING_WINDOW');expect(f).toEqual(held);
   }
  }
 });
});
