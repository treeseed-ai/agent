import {createManagedProviderManifestV5} from '../../../../../src/provider/configuration/managed-manifest.ts';
import {sandboxModelPolicy} from '../../../../../src/provider/execution/microvm-executor.ts';

export function campaignModels(){
 const digest='sha256:'+'a'.repeat(64),manifest=createManagedProviderManifestV5({release:'model-cap-readback',guestImage:'isolated/guest',guestImageDigest:digest,baseImageDigest:digest,provenanceDigest:digest});
 const providers=manifest.adapters.map(adapter=>{adapter.model={model:'gpt-6-luna',reasoningEffort:'low'};const cap=adapter.id==='codex-research'?7200:28800,policy=sandboxModelPolicy(adapter,manifest,[...new Set(adapter.offers.flatMap(binding=>binding.offer.capabilities.map(value=>value.id)))]);
  return{id:adapter.id,status:'active',modelPolicy:policy,nativeLimits:{modelConfigurationId:'declared-configuration-'+adapter.id,dailyActiveSecondsLimit:cap,capabilityLimits:Object.fromEntries(policy.capabilities.map(id=>[id,{dailyActiveSecondsLimit:cap}]))}};});
 return{provider:{providerId:'supplied-provider'},healthy:true,availability:[{refreshed_at:'2026-10-16T00:00:00.000Z',executionProviders:providers}]};
}
