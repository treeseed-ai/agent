import {expect,it} from 'vitest';
import * as freeze from '../../../acceptance/freeze-integrity.ts';
import {createManagedProviderManifestV5} from '../../../../src/provider/configuration/managed-manifest.ts';
import {sandboxModelPolicy} from '../../../../src/provider/execution/microvm-executor.ts';

export function campaignModels(){
 const digest='sha256:'+'a'.repeat(64),manifest=createManagedProviderManifestV5({release:'model-cap-readback',guestImage:'isolated/guest',guestImageDigest:digest,baseImageDigest:digest,provenanceDigest:digest});
 const providers=manifest.adapters.map(adapter=>{adapter.model={model:'gpt-6-luna',reasoningEffort:'low'};const cap=adapter.id==='codex-research'?7200:28800,policy=sandboxModelPolicy(adapter,manifest,[...new Set(adapter.offers.flatMap(binding=>binding.offer.capabilities.map(value=>value.id)))]);
  return{id:adapter.id,status:'active',modelPolicy:policy,nativeLimits:{modelConfigurationId:'declared-configuration-'+adapter.id,dailyActiveSecondsLimit:cap,capabilityLimits:Object.fromEntries(policy.capabilities.map(id=>[id,{dailyActiveSecondsLimit:cap}]))}};});
 return{healthy:true,availability:[{refreshed_at:'2026-10-16T00:00:00.000Z',executionProviders:providers}]};
}

it('requires actual Luna Low model policy and separate normal campaign caps without substituting provider labels or hiding unrelated resources',()=>{
 const verify=Reflect.get(freeze,'verifySdkCampaignModels');expect(typeof verify).toBe('function');if(typeof verify!=='function')throw new Error('Normal campaign model/cap readback verification is missing');
 const exact=campaignModels(),held=structuredClone(exact);verify(exact);expect(exact).toEqual(held);
 for(const mode of ['unhealthy','empty','timestamp','missing-provider','duplicate-provider','unavailable','missing-policy','other-model','other-reasoning','research-cap','implementation-cap','capability-cap','missing-capability','model-scope','label-only']){
  const f=campaignModels(),providers=f.availability[0]!.executionProviders,implementation=providers.find(value=>value.id==='codex-implementation')!,research=providers.find(value=>value.id==='codex-research')!;
  if(mode==='unhealthy')f.healthy=false;if(mode==='empty')f.availability=[];if(mode==='timestamp')f.availability[0]!.refreshed_at='invalid';
  if(mode==='missing-provider')providers.pop();if(mode==='duplicate-provider')providers.push(structuredClone(research));if(mode==='unavailable')research.status='unavailable';
  if(mode==='missing-policy')Reflect.deleteProperty(research,'modelPolicy');if(mode==='other-model')research.modelPolicy.model='gpt-6-sol';if(mode==='other-reasoning')research.modelPolicy.reasoningEffort='high';
  if(mode==='research-cap')research.nativeLimits.dailyActiveSecondsLimit=7201;if(mode==='implementation-cap')implementation.nativeLimits.dailyActiveSecondsLimit=28801;
  if(mode==='capability-cap')Object.values(research.nativeLimits.capabilityLimits)[0]!.dailyActiveSecondsLimit=7201;if(mode==='missing-capability')delete research.nativeLimits.capabilityLimits[research.modelPolicy.capabilities[0]!];
  if(mode==='model-scope')research.nativeLimits.modelConfigurationId='';if(mode==='label-only'){research.nativeLimits.modelConfigurationId='codex:gpt-6-luna:low';Reflect.deleteProperty(research,'modelPolicy');}
  const before=structuredClone(f);expect(()=>verify(f),mode).toThrow('ACCEPTANCE_CAMPAIGN_MODELS');expect(f).toEqual(before);verify(exact);
 }
 const unrelated=campaignModels();unrelated.availability[0]!.executionProviders.push({...structuredClone(unrelated.availability[0]!.executionProviders[0]!),id:'unrelated-provider',modelPolicy:{...unrelated.availability[0]!.executionProviders[0]!.modelPolicy,model:'gpt-6-sol'}});const retained=structuredClone(unrelated);verify(unrelated);expect(unrelated).toEqual(retained);
});
