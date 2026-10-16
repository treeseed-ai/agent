import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import * as freeze from '../../../../acceptance/freeze-integrity.ts';
import {campaignModels} from './campaign-models-fixture.ts';

it('native original SDK status and immutable operator bytes reject changed model caps foreign scope denial and interruption before unchanged concurrent retry',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-model-freeze-')),requests:string[]=[],failures:Array<{mode:string;observed:unknown;error:unknown}>=[];
 const original=campaignModels(),providerId=original.provider.providerId;let mode='exact';
 const server=createServer((request,response)=>{requests.push(String(request.method)+' '+String(request.url));response.setHeader('content-type','application/json');
  if(mode==='interrupted'){request.socket.destroy();return;}if(mode==='denied'||mode==='unavailable'){response.writeHead(mode==='denied'?403:503).end('{}');return;}if(mode==='json'){response.end('{');return;}
  const value=structuredClone(original);if(mode==='model')value.availability[0]!.executionProviders[0]!.modelPolicy.model='gpt-6-sol';if(mode==='cap')value.availability[0]!.executionProviders[0]!.nativeLimits.dailyActiveSecondsLimit++;
  if(mode==='foreign')value.provider.providerId='foreign';response.end(JSON.stringify({data:value}));
 });
 const capture=(name:string,supply=original)=>{const directory=join(root,name);mkdirSync(directory);const path=join(directory,'operator.json'),manifest={allocationInputsByRun:{sdk:{providerSupply:[{providerId,...structuredClone(supply)}]}}},bytes=JSON.stringify(manifest);writeFileSync(path,bytes,{flag:'wx',mode:0o600});return{path,bytes,manifest};};
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Original native listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-model-readback-token'}),input={path:{teamId:'native-team',providerId},query:{},body:undefined},heldInput=structuredClone(input);
  const verify=Reflect.get(freeze,'readCampaignProviderModels');expect(typeof verify).toBe('function');if(typeof verify!=='function')throw new Error('Original captured-model/public-status verification is missing');
  const frozen=capture('exact'),held=structuredClone(frozen),read=async(id:string)=>{expect(id).toBe(providerId);return(await client.invoke(controlPlaneOperation('providers.status'),input)).data;};
  const observe=async(value=frozen)=>{let observed:unknown;try{return await verify(value,async(id:string)=>{observed=await read(id);return observed;});}catch(error){failures.push({mode,observed,error});throw error;}};
  await Promise.all([observe(),observe()]);expect(frozen).toEqual(held);expect(readFileSync(frozen.path,'utf8')).toBe(frozen.bytes);
  for(const fault of ['model','cap','foreign','denied','unavailable','json','interrupted']){mode=fault;await expect(observe(),fault).rejects.toThrow();expect(frozen).toEqual(held);expect(input).toEqual(heldInput);expect(readFileSync(frozen.path,'utf8')).toBe(frozen.bytes);}
  mode='exact';const bad=campaignModels();bad.availability[0]!.executionProviders[0]!.modelPolicy.reasoningEffort='high';const wrong=capture('wrong-frozen-model',bad),offset=requests.length;
  await expect(observe(wrong)).rejects.toThrow('ACCEPTANCE_CAMPAIGN_MODELS');expect(requests).toHaveLength(offset);expect(readFileSync(wrong.path,'utf8')).toBe(wrong.bytes);
  const retained=[...failures];await Promise.all([observe(),observe()]);expect(failures).toEqual(retained);expect(frozen).toEqual(held);expect(input).toEqual(heldInput);
  expect(requests.every(value=>value==='GET /v1/teams/native-team/capacity-providers/'+providerId+'/status')).toBe(true);
  // Real configured policy producer, public SDK/HTTP and original captured
  // operator bytes. API replies are controlled; no model, quota or Kata claim.
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));rmSync(root,{recursive:true,force:true});}
 expect(server.listening).toBe(false);
},30_000);
