import {expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import * as freeze from '../../../../acceptance/freeze-integrity.ts';
import {campaignModels} from './campaign-models-fixture.ts';
import {campaignInputs} from '../campaign-freeze-fixture.ts';
import {portfolioRelations} from '../../../../acceptance/workday/support/portfolio-relations.ts';

it('native original SDK status and immutable operator bytes reject changed model caps foreign scope denial and interruption before unchanged concurrent retry',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-model-freeze-')),requests:string[]=[],failures:Array<{mode:string;observed:unknown;error:unknown}>=[];
 const original=campaignModels(),providerId=original.provider.providerId;let mode='exact';
 const server=createServer((request,response)=>{requests.push(String(request.method)+' '+String(request.url));response.setHeader('content-type','application/json');
  if(mode==='interrupted'){request.socket.destroy();return;}if(mode==='denied'||mode==='unavailable'){response.writeHead(mode==='denied'?403:503).end('{}');return;}if(mode==='json'){response.end('{');return;}
  const value=structuredClone(original);if(mode==='model')value.availability[0]!.executionProviders[0]!.modelPolicy.model='gpt-6-sol';if(mode==='cap')value.availability[0]!.executionProviders[0]!.nativeLimits.dailyActiveSecondsLimit++;
  if(mode==='foreign-duplicate')value.availability[0]!.executionProviders.push({...structuredClone(value.availability[0]!.executionProviders[0]!),id:'unrelated-provider'},{...structuredClone(value.availability[0]!.executionProviders[0]!),id:'unrelated-provider'});if(mode==='foreign-empty')value.availability[0]!.executionProviders.push({...structuredClone(value.availability[0]!.executionProviders[0]!),id:''});
  if(mode==='foreign')value.provider.providerId='foreign';response.end(JSON.stringify({data:value}));
 });
 const platform=process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;if(!platform)throw new Error('Original pinned Platform fixture authority required');
 const seed=readFileSync(join(platform,'seeds/treeseed.yaml'),'utf8'),relations=portfolioRelations(readFileSync(join(platform,'docs/agent-acceptance.md'),'utf8'),seed);
 const capture=(name:string,supply=original)=>{const directory=join(root,name);mkdirSync(directory);const path=join(directory,'operator.json'),manifest=campaignInputs(relations.projects.map(value=>value.slug),seed);
  for(const run of Object.values(manifest.allocationInputsByRun))run.providerSupply=[{...run.providerSupply[0]!,providerId,...structuredClone(supply)}];
  const bytes=JSON.stringify(manifest);writeFileSync(path,bytes,{flag:'wx',mode:0o600});vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH',path);vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH',platform);const checked=freeze.readPreRunCampaignFreeze();expect(checked.bytes).toBe(bytes);expect(checked.manifest).toEqual(manifest);return checked;};
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Original native listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-model-readback-token'}),input={path:{teamId:'native-team',providerId},query:{},body:undefined},heldInput=structuredClone(input);
  const verify=Reflect.get(freeze,'readCampaignProviderModels');expect(typeof verify).toBe('function');if(typeof verify!=='function')throw new Error('Original captured-model/public-status verification is missing');
  const frozen=capture('exact'),held=structuredClone(frozen),read=async(id:string)=>{expect(id).toBe(providerId);return(await client.invoke(controlPlaneOperation('providers.status'),input)).data;};
  const observe=async(value=frozen)=>{let observed:unknown;try{return await verify(value,async(id:string)=>{observed=await read(id);return observed;});}catch(error){failures.push({mode,observed,error});throw error;}};
  await Promise.all([observe(),observe()]);expect(frozen).toEqual(held);expect(readFileSync(frozen.path,'utf8')).toBe(frozen.bytes);
  for(const fault of ['foreign-duplicate','foreign-empty','model','cap','foreign','denied','unavailable','json','interrupted']){mode=fault;await expect(observe(),fault).rejects.toThrow();expect(frozen).toEqual(held);expect(input).toEqual(heldInput);expect(readFileSync(frozen.path,'utf8')).toBe(frozen.bytes);}
  mode='exact';const bad=campaignModels();bad.availability[0]!.executionProviders[0]!.modelPolicy.reasoningEffort='high';const wrong=capture('wrong-frozen-model',bad),offset=requests.length;
  await expect(observe(wrong)).rejects.toThrow('ACCEPTANCE_CAMPAIGN_MODELS');expect(requests).toHaveLength(offset);expect(readFileSync(wrong.path,'utf8')).toBe(wrong.bytes);
  const changed=capture('changed-during-read');await expect(verify(changed,async(id:string)=>{const value=await read(id);writeFileSync(changed.path,changed.bytes+' ');return value;})).rejects.toThrow('Operator capture changed during model readback');
  expect(readFileSync(changed.path,'utf8')).toBe(changed.bytes+' ');writeFileSync(changed.path,changed.bytes);
  const double=capture('interrupted-and-mutated'),interruption=new Error('original status interruption');let both:unknown;
  try{await verify(double,async(id:string)=>{await read(id);writeFileSync(double.path,double.bytes+' ');throw interruption;});}catch(error){both=error;}
  expect(both).toBeInstanceOf(AggregateError);if(!(both instanceof AggregateError))throw new Error('Both original failures must remain available');expect(both.errors).toHaveLength(2);expect(both.errors[0]).toBe(interruption);expect(String(both.errors[1])).toContain('Operator capture changed during model readback');expect(readFileSync(double.path,'utf8')).toBe(double.bytes+' ');writeFileSync(double.path,double.bytes);
  await verify(double,read);expect(both.errors[0]).toBe(interruption);expect(readFileSync(double.path,'utf8')).toBe(double.bytes);
  const retained=[...failures];await Promise.all([observe(),observe()]);expect(failures).toEqual(retained);expect(frozen).toEqual(held);expect(input).toEqual(heldInput);
  expect(requests.every(value=>value==='GET /v1/teams/native-team/capacity-providers/'+providerId+'/status')).toBe(true);
  // Real configured policy producer, public SDK/HTTP and original captured
  // operator bytes. API replies are controlled; no model, quota or Kata claim.
 }finally{vi.unstubAllEnvs();server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));rmSync(root,{recursive:true,force:true});}
 expect(server.listening).toBe(false);
},30_000);
