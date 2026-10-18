import {expect,it,vi} from 'vitest';
import {runProviderAssignment} from '../../../../src/provider/operations/runner.ts';
import {assignment,client,runtimeBuild,timingAwareness,treeDx,responseReference} from './runner-fixture.ts';

it('renews the original lease through delayed response publication and terminal closeout then drains every renewal on success or failure',async()=>{
 for(const failure of [false,true]){
  vi.useFakeTimers();const api=client(),published=Promise.withResolvers<{status:string;reference:typeof responseReference}>(),entered=Promise.withResolvers<void>();
  api.respondToAssignmentDiscussion.mockImplementation(async()=>{entered.resolve();return published.promise;});
  const pending=runProviderAssignment({client:api,assignment:assignment('conversation'),treeDx,leaseToken:'lease',runnerId:'runner',runtimeBuild,renewalIntervalMs:10,
   executor:{id:'codex',observe:async()=>({available:true}),execute:async request=>{await request.beginExecution?.();return{status:'responded',summary:'Actual supplied reply.',responseMarkdown:'Actual supplied reply.',outputs:{timingAwareness},usage:[{activeSeconds:2,elapsedSeconds:3}]};}}});
  const observed=pending.then(value=>({value}),error=>({error}));
  try{
   await entered.promise;await vi.advanceTimersByTimeAsync(40);expect(api.renewAssignment.mock.calls.length).toBeGreaterThanOrEqual(1);
   if(failure)published.reject(new Error('Original publication failure'));else published.resolve({status:'responded',reference:responseReference});
   const result=await observed;if(failure){expect(result).toMatchObject({error:{message:'Original publication failure'}});expect(api.completeAssignment).not.toHaveBeenCalled();expect(api.settleAssignment).not.toHaveBeenCalled();}
   else{expect(result).toEqual({value:{status:'completed'}});expect(api.settleAssignment).toHaveBeenCalledOnce();expect(api.completeAssignment).toHaveBeenCalledOnce();}
   expect(vi.getTimerCount()).toBe(0);const calls=api.renewAssignment.mock.calls.length;await vi.advanceTimersByTimeAsync(100);expect(api.renewAssignment).toHaveBeenCalledTimes(calls);
  }finally{published.resolve({status:'responded',reference:responseReference});await observed;vi.useRealTimers();}
 }
});
