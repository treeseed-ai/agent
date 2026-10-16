import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {sandboxAssignmentSchema} from '@treeseed/sdk/capacity-provider';
import {capabilityAccountingLimitsSchema} from '@treeseed/sdk/agent-capacity';

const label='ACCEPTANCE_CAMPAIGN_MODELS';
const row=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),label+': Original public object required');return value as Record<string,unknown>;};

/** These are the prescribed local campaign installation inputs, not release
 * defaults or runtime role rules. The owning producer supports arbitrary IDs. */
export function verifySdkCampaignModels(input:unknown):ReadonlyMap<string,Record<string,unknown>>{
 const supply=row(input);assert.equal(supply.healthy,true,label+': Original healthy provider readback required');
 const sessions=supply.availability;assert.ok(Array.isArray(sessions)&&sessions.length>0,label+': Complete original availability required');
 let latest:Record<string,unknown>|undefined,at=-Infinity;
 for(const value of sessions){const session=row(value),time=Date.parse(String(session.refreshed_at));assert.ok(Number.isFinite(time),label+': Unreadable availability clock');if(time>at){latest=session;at=time;}}
 const providers=latest?.executionProviders;assert.ok(Array.isArray(providers),label+': Original execution-provider inventory required');
 const inventory:Record<string,unknown>[]=providers.map(row),ids=inventory.map(provider=>provider.id);
 assert.ok(ids.every(id=>typeof id==='string'&&id.length>0&&id.trim()===id)&&new Set(ids).size===ids.length,label+': Complete unique native execution-provider identities required');
 const selected=new Map<string,Record<string,unknown>>();
 for(const [id,cap]of [['codex-research',7200],['codex-implementation',28800]]as const){
  const matches:Record<string,unknown>[]=inventory.filter(provider=>provider.id===id);assert.equal(matches.length,1,label+': Exact unique '+id+' installation required');const provider=matches[0]!;
  assert.equal(provider.status,'active',label+': '+id+' is not active');
  const parsed=sandboxAssignmentSchema.shape.modelPolicy.safeParse(provider.modelPolicy);assert.ok(parsed.success,label+': '+id+' lacks original typed model policy');
  const policy=parsed.data;assert.deepEqual(policy,provider.modelPolicy,label+': Native model policy must already be canonical');
  assert.equal(policy.provider,'openai',label+': Local campaign uses the Codex harness');assert.match(policy.model,/^gpt-\d+(?:\.\d+)?-luna$/u,label+': '+id+' must use Luna');assert.equal(policy.reasoningEffort,'low',label+': '+id+' must use Low');
  assert.ok(policy.capabilities.length>0&&new Set(policy.capabilities).size===policy.capabilities.length,label+': Complete distinct offered capabilities required');
  const limits=capabilityAccountingLimitsSchema.safeParse(provider.nativeLimits);assert.ok(limits.success,label+': Original model and capability limits required');assert.deepEqual(limits.data,provider.nativeLimits,label+': Native accounting limits must already be canonical');
  assert.equal(limits.data.dailyActiveSecondsLimit,cap,label+': '+id+' normal daily cap changed');
  for(const capability of policy.capabilities){const bound=limits.data.capabilityLimits[capability];assert.ok(bound,label+': Missing original capability ceiling');assert.ok(bound.dailyActiveSecondsLimit<=cap,label+': Capability ceiling exceeds normal installation cap');}
  selected.set(id,provider);
 } return selected;
}

const modelView=(models:ReadonlyMap<string,Record<string,unknown>>)=>[...models].map(([id,value])=>({id,modelPolicy:value.modelPolicy,nativeLimits:value.nativeLimits}));

/** Shared comparison for initial inspection and the later preparation boundary. */
export function verifyFrozenCampaignModels(frozen:unknown,current:unknown){
 const original=row(frozen),observed=row(current),providerId=row(original.provider).providerId;
 assert.ok(typeof providerId==='string'&&providerId.length>0&&providerId.trim()===providerId,label+': Original provider owner required');
 assert.equal(row(observed.provider).providerId,providerId,label+': Foreign live provider');
 const before=modelView(verifySdkCampaignModels(original)),after=modelView(verifySdkCampaignModels(observed));
 assert.deepEqual(after,before,label+': Native model or capability configuration changed after freeze');return{before,after};
}

/** Compare the existing immutable operator providerSupply capture with current
 * public owning status. This creates neither a workday nor another authority. */
export async function readCampaignProviderModels(input:unknown,readStatus:(providerId:string)=>unknown|Promise<unknown>,readBytes:(path:string)=>Uint8Array=readFileSync){
 const original=row(input),manifest=row(original.manifest);assert.ok(typeof original.path==='string'&&isAbsolute(original.path)&&typeof original.bytes==='string',label+': Exact immutable operator bytes required');
 const path=original.path,bytes=Buffer.from(original.bytes);assert.deepEqual(Buffer.from(readBytes(path)),bytes,label+': Operator capture changed before model readback');assert.deepEqual(JSON.parse(original.bytes),manifest,label+': Operator object differs from original bytes');
 const supply=row(row(manifest.allocationInputsByRun).sdk).providerSupply;assert.ok(Array.isArray(supply)&&supply.length>0,label+': Original frozen supply inventory required');const frozen=supply.map(row),ids=frozen.map(value=>value.providerId);
 assert.ok(ids.every(id=>typeof id==='string'&&id.trim()===id&&id.length>0)&&new Set(ids).size===ids.length,label+': Unique original provider owners required');
 const held=new Map<string,Record<string,unknown>>();for(const value of frozen){const id=String(value.providerId);assert.equal(row(value.provider).providerId,id,label+': Foreign captured provider');verifySdkCampaignModels(value);held.set(id,structuredClone(value));}
 const readbacks=new Map<string,{before:ReturnType<typeof modelView>;after:ReturnType<typeof modelView>}>();let failed:unknown;
 try{for(const value of frozen){const id=String(value.providerId),observed=row(await readStatus(id));readbacks.set(id,verifyFrozenCampaignModels(held.get(id)!,observed));}return readbacks;}
 catch(error){failed=error;throw error;}finally{try{assert.deepEqual(Buffer.from(readBytes(path)),bytes,label+': Operator capture changed during model readback');}catch(error){if(failed)throw new AggregateError([failed,error],label+': Original readback and capture integrity both failed');throw error;}}
}
