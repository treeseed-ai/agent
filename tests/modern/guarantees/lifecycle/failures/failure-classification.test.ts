import assert from 'node:assert/strict';
import {expect,it} from 'vitest';
import {monitorCampaign,campaignPlanReviewRequired} from '../../../../acceptance/campaign.ts';

it('classifies every original campaign failure before stop without losing raw causes or permitting a later stage',async()=>{
 const report={project:'sdk',proposal:'original-proposal sha256:'+'a'.repeat(64),workday:'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'failed expectation':'Original fixed proposal authority failed.', 'observed evidence':'Original failure remains retained unchanged.',
  'why implementation repair is insufficient':'The frozen requirement itself requires reviewed correction.', 'smallest proposed plan correction':'Request review; no correction applied.'};
 const contract=new Error('Retained original contract defect'),type=new TypeError('Retained malformed observer'),environment=Object.assign(new Error('Retained unhealthy supply'),{code:'ECONNREFUSED'}),socket=Object.assign(new Error('Retained interrupted native transport'),{code:'UND_ERR_SOCKET'}),review=campaignPlanReviewRequired(report,contract);
 const assertion=(()=>{try{assert.fail('Retained exact invariant failure');}catch(error){return error;}})();
 const cycle=new Error('Retained circular cause');Object.defineProperty(cycle,'cause',{value:cycle});
 let getterReads=0;const accessor=Object.defineProperty(new Error('Retained unsupported classification accessor'),'classification',{get(){getterReads++;throw new Error('Getter must not be executed');}});
 const observations:Array<[unknown,string]>=[[contract,'IMPLEMENTATION_DEFECT'],[type,'IMPLEMENTATION_DEFECT'],[assertion,'IMPLEMENTATION_DEFECT'],[cycle,'IMPLEMENTATION_DEFECT'],[accessor,'IMPLEMENTATION_DEFECT'],[undefined,'IMPLEMENTATION_DEFECT'],[null,'IMPLEMENTATION_DEFECT'],['Retained non-Error throw','IMPLEMENTATION_DEFECT'],[0,'IMPLEMENTATION_DEFECT'],[environment,'ENVIRONMENT_DEFECT'],[new Error('Retained wrapped transport',{cause:socket}),'ENVIRONMENT_DEFECT'],[review,'PLAN_REVIEW_REQUIRED']];
 for(const field of['message','cause'])observations.push([Object.defineProperty(new Error('Original accessor '+field),field,{get(){getterReads++;throw new Error('Forbidden '+field+' accessor');}}),'IMPLEMENTATION_DEFECT']);
 for(const message of[undefined,null,42,{},[],()=>{}])observations.push([Object.defineProperty(new Error('Original malformed message'),'message',{value:message}),'IMPLEMENTATION_DEFECT']);
 const retained:unknown[]=[];
 for(const[original,classification]of observations)for(const boundary of['discussion','read','inspect','collaboration','wait','verify']){
  const descriptors=original instanceof Error?Object.getOwnPropertyDescriptors(original):undefined,beforeReads=getterReads;let stops=0,later=0,reports=0;let failure:unknown;
  const fail=(at:string)=>{if(boundary===at)throw original;};
  try{await monitorCampaign({admittedSimulation:true,admitDiscussion:()=>fail('discussion'),read:()=>{fail('read');return{status:boundary==='verify'?'completed':'running',mode:'simulation',planningEndsAt:1,endsAt:2};},inspect:()=>fail('inspect'),now:()=>1,wait:async()=>{fail('wait');later++;},collaboration:()=>{fail('collaboration');},verify:()=>{fail('verify');later++;},stop:()=>{stops++;},reportPlanReview:text=>{expect(text).toBe(review.message);reports++;}});}catch(error){failure=error;}
  const afterReads=getterReads;expect.soft(afterReads).toBe(beforeReads);expect.soft(failure).toBeInstanceOf(Error);expect.soft(Object.getOwnPropertyDescriptor(Object(failure),'classification')?.value).toBe(classification);
  if(classification==='PLAN_REVIEW_REQUIRED')expect.soft(failure).toBe(original);else expect.soft((failure as Error)?.cause).toBe(original);
  expect.soft(stops).toBe(boundary==='verify'?0:1);expect.soft(later).toBe(0);expect.soft(reports).toBe(classification==='PLAN_REVIEW_REQUIRED'?1:0);
  if(descriptors)expect.soft(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors);retained.push({boundary,classification,failure});
 }
 expect(retained).toHaveLength(observations.length*6);
 const original=new Error('Original observer failure'),stop=new Error('Original scoped stop failure');let failure:unknown;
 try{await monitorCampaign({admittedSimulation:true,read:()=>({status:'running',mode:'simulation',planningEndsAt:1,endsAt:2}),inspect:()=>{throw original;},now:()=>1,wait:async()=>{},collaboration:()=>{},verify:()=>{},stop:()=>{throw stop;}});}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(AggregateError);expect(Object.getOwnPropertyDescriptor(Object(failure),'classification')?.value).toBe('IMPLEMENTATION_DEFECT');expect((failure as AggregateError).errors).toContain(original);expect((failure as AggregateError).errors).toContain(stop);
});
