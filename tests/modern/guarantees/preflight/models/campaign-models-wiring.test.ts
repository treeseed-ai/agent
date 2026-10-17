import {expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {campaignModels} from './campaign-models-fixture.ts';

const state=vi.hoisted(()=>({cases:new Map<string,()=>Promise<void>>(),capture:undefined as undefined|{path:string;bytes:string;manifest:Record<string,unknown>},read:vi.fn(),libraries:vi.fn()}));
vi.mock('node:test',()=>({default:(name:string,run:()=>Promise<void>)=>{state.cases.set(name,run);}}));
vi.mock('../../../../acceptance/freeze-integrity.ts',async original=>({
 ...await original<typeof import('../../../../acceptance/freeze-integrity.ts')>(),
 readPreRunCampaignFreeze:()=>{if(!state.capture)throw new Error('Controlled capture required');return state.capture;},
 readCampaignProjectLibraries:state.libraries,
}));
vi.mock('../../../../acceptance/acceptance-cli.ts',async original=>({
 ...await original<typeof import('../../../../acceptance/acceptance-cli.ts')>(),read:state.read,
}));

it('original first SDK preflight rejects frozen and current model contradictions before library reads or any metered work',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-model-wiring-')),path=join(root,'operator.json'),original=campaignModels();
 const capture=(status:ReturnType<typeof campaignModels>)=>{const manifest={allocationInputsByRun:{sdk:{providerSupply:[{providerId:status.provider.providerId,...status}]}}},bytes=JSON.stringify(manifest);writeFileSync(path,bytes);state.capture={path,bytes,manifest};};
 const libraryBoundary=new Error('controlled next library boundary');
 try {
  await import('../../../../acceptance/freeze-integrity.test.ts');
  const run=state.cases.get('Golden pre-run campaign freeze retains every schema-valid expanded input and original manifest bytes before SDK execution');expect(run).toBeTypeOf('function');if(!run)throw new Error('Original first SDK preflight is missing');
  vi.stubEnv('TREESEED_ACCEPTANCE_TEAM','controlled-model-team');
  state.libraries.mockImplementation(()=>{throw libraryBoundary;});
  const invalid=structuredClone(original);invalid.availability[0]!.executionProviders[0]!.modelPolicy.reasoningEffort='high';capture(invalid);
  await expect(run()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_MODELS');expect(state.read).not.toHaveBeenCalled();expect(state.libraries).not.toHaveBeenCalled();expect(readFileSync(path,'utf8')).toBe(state.capture!.bytes);
  capture(original);const denial=new Error('controlled public status denied');state.read.mockImplementation(()=>{throw denial;});
  await expect(run()).rejects.toBe(denial);expect(state.read).toHaveBeenCalledExactlyOnceWith(['providers','status',original.provider.providerId],'controlled-model-team');expect(state.libraries).not.toHaveBeenCalled();
  state.read.mockReset().mockReturnValue(invalid);await expect(run()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_MODELS');expect(state.read).toHaveBeenCalledOnce();expect(state.libraries).not.toHaveBeenCalled();
  state.read.mockReset().mockReturnValue(original);await expect(run()).rejects.toBe(libraryBoundary);expect(state.read).toHaveBeenCalledExactlyOnceWith(['providers','status',original.provider.providerId],'controlled-model-team');expect(state.libraries).toHaveBeenCalledOnce();expect(readFileSync(path,'utf8')).toBe(state.capture!.bytes);
  // Unit composition only. Real SDK/HTTP/capture and signed configured model
  // execution remain separately proved by their original native cases.
 } finally {vi.unstubAllEnvs();state.capture=undefined;state.read.mockReset();state.libraries.mockReset();rmSync(root,{recursive:true,force:true});}
});
