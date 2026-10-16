import assert from 'node:assert/strict';
import {sandboxAssignmentSchema} from '@treeseed/sdk/capacity-provider';
import {capabilityAccountingLimitsSchema} from '@treeseed/sdk/agent-capacity';

const label='ACCEPTANCE_CAMPAIGN_MODELS';
const row=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),label+': Original public object required');return value as Record<string,unknown>;};

/** These are the prescribed local campaign installation inputs, not release
 * defaults or runtime role rules. The owning producer supports arbitrary IDs. */
export function verifySdkCampaignModels(input:unknown):void{
 const supply=row(input);assert.equal(supply.healthy,true,label+': Original healthy provider readback required');
 const sessions=supply.availability;assert.ok(Array.isArray(sessions)&&sessions.length>0,label+': Complete original availability required');
 let latest:Record<string,unknown>|undefined,at=-Infinity;
 for(const value of sessions){const session=row(value),time=Date.parse(String(session.refreshed_at));assert.ok(Number.isFinite(time),label+': Unreadable availability clock');if(time>at){latest=session;at=time;}}
 const providers=latest?.executionProviders;assert.ok(Array.isArray(providers),label+': Original execution-provider inventory required');
 for(const [id,cap]of [['codex-research',7200],['codex-implementation',28800]]as const){
  const matches=providers.map(row).filter(provider=>provider.id===id);assert.equal(matches.length,1,label+': Exact unique '+id+' installation required');const provider=matches[0]!;
  assert.equal(provider.status,'active',label+': '+id+' is not active');
  const parsed=sandboxAssignmentSchema.shape.modelPolicy.safeParse(provider.modelPolicy);assert.ok(parsed.success,label+': '+id+' lacks original typed model policy');
  const policy=parsed.data;assert.deepEqual(policy,provider.modelPolicy,label+': Native model policy must already be canonical');
  assert.equal(policy.provider,'openai',label+': Local campaign uses the Codex harness');assert.match(policy.model,/^gpt-\d+(?:\.\d+)?-luna$/u,label+': '+id+' must use Luna');assert.equal(policy.reasoningEffort,'low',label+': '+id+' must use Low');
  assert.ok(policy.capabilities.length>0&&new Set(policy.capabilities).size===policy.capabilities.length,label+': Complete distinct offered capabilities required');
  const limits=capabilityAccountingLimitsSchema.safeParse(provider.nativeLimits);assert.ok(limits.success,label+': Original model and capability limits required');assert.deepEqual(limits.data,provider.nativeLimits,label+': Native accounting limits must already be canonical');
  assert.equal(limits.data.dailyActiveSecondsLimit,cap,label+': '+id+' normal daily cap changed');
  for(const capability of policy.capabilities){const bound=limits.data.capabilityLimits[capability];assert.ok(bound,label+': Missing original capability ceiling');assert.ok(bound.dailyActiveSecondsLimit<=cap,label+': Capability ceiling exceeds normal installation cap');}
 }
}
