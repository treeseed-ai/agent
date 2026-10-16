import {describe,expect,it} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {state,gate,workdayId} from '../architecture/golden-readback-fixture.ts';

describe('Reporter reads original public applied-plan authority',()=>{
 it('accepts the original API Workday shape without requiring a second report or lifecycle authority',()=>{
  const run=state.replies.get('workdays show')!.run,report=structuredClone(run.parameters.appliedPlan.reportRef);
  const plan=compileWorkday({id:workdayId,teamId:run.teamId,policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:run.startedAt,agentIds:[],
   policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:run.parameters.durationSeconds,planningPercent:run.parameters.planningPercent,maximumConcurrency:5,communicationConcurrency:5}});
  Object.assign(run.parameters,plan.policySnapshot,{deadlineAt:plan.endsAt});
  run.parameters.appliedPlan={...plan,state:'ended',activatedAt:run.startedAt,closingAt:'2026-09-27T00:00:09Z',endedAt:run.completedAt,reportRef:report};
  run.reportRefs={};delete run.reportRef;delete run.state;delete run.endedAt;
  const held=structuredClone({run,assignments:state.replies.get('assignments list'),note:state.replies.get('library read')});
  expect(()=>gate('reporter')).not.toThrow();
  expect({run,assignments:state.replies.get('assignments list'),note:state.replies.get('library read')}).toEqual(held);
 });
});
