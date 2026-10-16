import {expect,it} from 'vitest';
import * as evidence from '../../../acceptance/workday/support/planning/estimate-evidence.ts';
import {state} from '../../kernel/architecture/golden-readback-fixture.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

/** Controlled original public inventory inputs, never managed planning outcomes. */
function inputs(){
 const run=structuredClone(row(state.replies.get('workdays show')!.run)),all=state.replies.get('assignments list')!.items as Row[];
 const estimator=structuredClone(all.find(value=>row(row(value.assignmentAttempt).effectiveProfile).activity==='estimating')!);
 const attempt=row(estimator.assignmentAttempt),planning=structuredClone(all.find(value=>row(row(value.assignmentAttempt).effectiveProfile).activity==='planning'&&row(value.assignmentAttempt).agentClass===attempt.agentClass)!);
 const prior=row(planning.assignmentAttempt),result=row(planning.assignmentResult),createdAt=new Date(Date.parse(String(planning.completedAt))+1).toISOString(),completedAt=new Date(Date.parse(createdAt)+1000).toISOString();
 Object.assign(prior,{id:planning.id,teamId:run.teamId,workdayId:run.id,projectId:estimator.projectId,createdAt:planning.createdAt});
 row(prior.effectiveProfile).profileRef=structuredClone(row(attempt.effectiveProfile).profileRef);
 Object.assign(attempt,{createdAt,finishedAt:completedAt,predecessorResultIds:[result.id]});Object.assign(estimator,{createdAt,completedAt});row(estimator.assignmentResult).completedAt=completedAt;
 const values=[planning,estimator];return{run,values,planning,estimator};
}
const inspect=(values:Row[],run:Row)=>Reflect.apply(Reflect.get(evidence,'verifyEstimatingPlanningPredecessors'),undefined,[values,run]);

it('requires each actual estimator to consume its own exact earlier planning result for arbitrary configured identities without rewriting public inventory',()=>{
 const f=inputs(),held=structuredClone(f);expect(()=>inspect(f.values,f.run)).not.toThrow();
 for(const item of f.values){row(item.assignmentAttempt).agentClass='renamed-work-owner';row(row(item.assignmentAttempt).effectiveProfile).profileRef={...row(row(row(item.assignmentAttempt).effectiveProfile).profileRef),id:'configured/arbitrary-owner'};}
 const renamed=structuredClone(f);expect(()=>inspect(f.values,f.run)).not.toThrow();expect(f).toEqual(renamed);expect(held.values).toHaveLength(2);
});
it('denies missing duplicated foreign stale failed or future planning predecessors and retains each failed observation before exact unchanged retry',()=>{
 const f=inputs();expect(()=>inspect(f.values,f.run)).not.toThrow();
 const mutations:Array<(value:ReturnType<typeof inputs>)=>void>=[
  value=>{value.values.splice(0,1);},value=>{row(value.estimator.assignmentAttempt).predecessorResultIds=[];},
  value=>{row(value.estimator.assignmentAttempt).predecessorResultIds=['foreign-result'];},value=>{value.values.push(structuredClone(value.planning));},
  value=>{row(value.planning.assignmentAttempt).teamId='foreign-team';},value=>{row(value.planning.assignmentAttempt).workdayId='foreign-workday';},
  value=>{row(value.planning.assignmentAttempt).projectId='foreign-project';},value=>{row(value.planning.assignmentAttempt).agentClass='foreign-class';},
  value=>{row(row(value.planning.assignmentAttempt).effectiveProfile).profileRef={...row(row(row(value.planning.assignmentAttempt).effectiveProfile).profileRef),commit:'f'.repeat(40)};},
  value=>{row(value.planning.assignmentResult).assignmentId='foreign-assignment';},value=>{value.planning.status='failed';},
  value=>{row(value.planning.assignmentResult).status='failed';},value=>{value.planning.completedAt='invalid';},
  value=>{const future=new Date(Date.parse(String(value.estimator.createdAt))+1).toISOString();value.planning.completedAt=future;row(value.planning.assignmentResult).completedAt=future;},
  value=>{row(value.run.parameters).proposalIds=['foreign-proposal'];},value=>{delete row(value.run.parameters).proposalIds;},
 ];
 for(const mutate of mutations){const changed=inputs();mutate(changed);const held=structuredClone(changed);expect(()=>inspect(changed.values,changed.run)).toThrow('ACCEPTANCE_ESTIMATE_PLANNING');expect(changed).toEqual(held);expect(()=>inspect(f.values,f.run)).not.toThrow();}
});
it('retains autonomous planning without manufacturing subjectless estimating work or accepting a missing selected estimator inventory',()=>{
 const f=inputs(),planning=[f.planning];delete row(f.run.parameters).proposalIds;expect(()=>inspect(planning,f.run)).not.toThrow();
 expect(()=>inspect(f.values,f.run)).toThrow('ACCEPTANCE_ESTIMATE_PLANNING');row(f.run.parameters).proposalIds=['proposal'];expect(()=>inspect(planning,f.run)).toThrow('ACCEPTANCE_ESTIMATE_PLANNING');
});
