import {describe,expect,it} from 'vitest';
import {requireFreshSdkSegment} from '../../../acceptance/campaign.ts';

describe('fresh SDK segment evidence',()=>{
 it('retains original fresh SDK intent and public workday without borrowing an earlier segment',()=>{
  const freeze={request:{body:{executionMode:'simulation',proposalIds:['original']}}},run={id:'workday-original',parameters:{proposalIds:['original']}},before=structuredClone({freeze,run});
  expect(()=>requireFreshSdkSegment(freeze)).not.toThrow();expect(()=>requireFreshSdkSegment(freeze,run)).not.toThrow();expect({freeze,run}).toEqual(before);
 });
 it('denies every present continuation field in frozen SDK intent or public workday without deleting or repairing failed evidence',()=>{
  for(const value of ['settled-parent','',null,undefined,0,false,{},[]])for(const boundary of ['intent','run']){
   const freeze={request:{body:{executionMode:'simulation',proposalIds:['original']}}},run={id:'workday-original',parameters:{proposalIds:['original']}};
   const owner=boundary==='intent'?freeze.request.body:run.parameters;
   Object.defineProperty(owner,'continueFromWorkdayId',{value,enumerable:false,configurable:false});
   const before=Object.getOwnPropertyDescriptors(owner);
   expect(()=>requireFreshSdkSegment(freeze,run)).toThrow('ACCEPTANCE_CAMPAIGN_FRESH_SEGMENT');
   expect(Object.getOwnPropertyDescriptors(owner)).toEqual(before);
  }
 });
});
