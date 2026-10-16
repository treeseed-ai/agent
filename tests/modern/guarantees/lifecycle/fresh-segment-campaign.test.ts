import {describe,expect,it} from 'vitest';
import {state,observed,transport} from '../campaign-cli-fixture.ts';

describe('fresh SDK campaign composition with controlled public inputs',()=>{
 it('denies continuation-bearing frozen intent before any normal SDK start or approval without rewriting the operator freeze',async()=>{
  transport(()=>observed('completed'));state.freeze.request.body.continueFromWorkdayId='settled-parent';const held=structuredClone(state.freeze);
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_FRESH_SEGMENT');expect(state.read).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);
 });
 it('denies a continued terminal workday before normal SDK inspection and final gates then accepts only an unchanged fresh retry',async()=>{
  const continued=observed('completed');Object.assign(continued.run.parameters,{continueFromWorkdayId:'settled-parent'});const held=structuredClone(continued);
  transport(()=>continued);await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_FRESH_SEGMENT');expect(state.verify).not.toHaveBeenCalled();expect(state.graphInspect).not.toHaveBeenCalled();expect(state.inspect).not.toHaveBeenCalled();expect(continued).toEqual(held);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([]);
  transport(()=>observed('completed'));await state.run!();expect(state.verify).toHaveBeenCalled();expect(continued).toEqual(held);
 });

});
