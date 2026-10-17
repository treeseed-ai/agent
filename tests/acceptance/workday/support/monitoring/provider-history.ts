import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import {sandboxEventSchema} from '@treeseed/sdk/capacity-provider';
import {isDeepStrictEqual} from 'node:util';
import {collectCompleteEvidence} from '../evidence-pages.ts';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { read, row, type Row } from '../../../acceptance-cli.ts';

export function availabilityHistory(team: string, reader: typeof read = read) {
	const sessions = [], identities = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
	let previous: { id: string; time: number } | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
		const observed = reader(['capacity', 'status', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], team), page = row(observed.page);
		assert.ok(Array.isArray(observed.items) && observed.items.length <= 100 && page.limit === 100 && typeof page.hasMore === 'boolean',
			'ACCEPTANCE_AVAILABILITY_PAGE: Original complete page authority required');
		for (const value of observed.items) {
			const session = row(value), id = typeof session.id === 'string' ? session.id : '', time = Date.parse(String(session.openedAt));
			assert.ok(id && Number.isFinite(time) && !identities.has(id), 'ACCEPTANCE_AVAILABILITY_PAGE: Unique session identity and owning opening clock required');
			assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id), 'ACCEPTANCE_AVAILABILITY_PAGE: Original descending opening order required');
			identities.add(id); previous = { id, time }; sessions.push(session);
		}
		if (!page.hasMore) { assert.equal(page.nextCursor, null, 'ACCEPTANCE_AVAILABILITY_PAGE: Explicit terminal cursor required'); return sessions; }
		assert.ok(observed.items.length === 100 && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor),
			'ACCEPTANCE_AVAILABILITY_PAGE: Complete progressing inventory required');
		const next = decodeCapacityPageCursor(page.nextCursor), last = sessions.at(-1)!;
		// Original repository creation/opening clocks are the same publication input.
		assert.ok(next && next.id === last.id && next.createdAt === last.openedAt, 'ACCEPTANCE_AVAILABILITY_PAGE: Cursor must bind the actual last session');
		cursor = page.nextCursor; cursors.add(cursor);
	}
	assert.fail('ACCEPTANCE_AVAILABILITY_PAGE: Complete inventory exceeds the original forty-page acceptance bound');
}


/** Independently recompute the existing API audit digest from public supply bytes. */
function providerDigest(value:unknown):string{
 const canonical=(input:unknown):unknown=>Array.isArray(input)?input.map(canonical):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):input;
 return 'sha256:'+createHash('sha256').update(JSON.stringify(canonical(value))).digest('base64url');
}
const providerClock=(value:unknown)=>{assert.ok(typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value,'ACCEPTANCE_PROVIDER_HISTORY: Exact original lifecycle clock required');return Date.parse(value);};

/** The public session owns supply; its audit records own the observed history. */
function providerObservation(session:Row):Row{
 const snapshot=row(session.snapshot);assert.ok(Array.isArray(snapshot.adapters),'ACCEPTANCE_PROVIDER_HISTORY: Complete adapter inventory required');
 const healthy=(value:unknown)=>{assert.ok(value===undefined||value===null||typeof value==='boolean','ACCEPTANCE_PROVIDER_HISTORY: Original health must remain boolean or unknown');return value??null;};
 return{providerId:session.providerId,membershipId:session.membershipId,availabilitySessionId:session.id,sequence:session.sequence,status:session.status,
  openedAt:session.openedAt,refreshedAt:session.refreshedAt,expiresAt:session.expiresAt,closedAt:session.closedAt,
  pressure:snapshot.pressure,availableFrom:snapshot.availableFrom,availableUntil:snapshot.availableUntil,maxConcurrentWorkers:snapshot.maxConcurrentWorkers,
  availableWorkers:snapshot.availableWorkers,reservedWorkers:snapshot.reservedWorkers,borrowedWorkers:snapshot.borrowedWorkers,lanes:snapshot.lanes,constraintsDigest:providerDigest(snapshot.constraints),
  adapters:snapshot.adapters.map(value=>{const adapter=row(value),accounting=adapter.accountingObservation===undefined?{}:row(adapter.accountingObservation),model=accounting.modelUsage===undefined?{}:row(accounting.modelUsage),capabilities=accounting.capabilityUsage===undefined?{}:row(accounting.capabilityUsage),observations=adapter.observations===undefined?{}:row(adapter.observations);assert.ok(Array.isArray(adapter.capabilities),'ACCEPTANCE_PROVIDER_HISTORY: Original capabilities required');
   return{id:adapter.id,status:adapter.status,runtimeBuild:adapter.runtimeBuild??null,capabilities:adapter.capabilities,laneIds:adapter.laneIds,nativeLimitsDigest:providerDigest(adapter.nativeLimits),modelPolicyDigest:observations.modelPolicy===undefined?null:providerDigest(observations.modelPolicy),offers:Array.isArray(adapter.offers)?adapter.offers.map(v=>({offerId:row(v).offerId,offerDigest:row(v).offerDigest})):[],modelHealthy:healthy(model.healthy),capabilityHealth:Object.fromEntries(adapter.capabilities.map(id=>[String(id),healthy(capabilities[String(id)]===undefined?undefined:row(capabilities[String(id)]).healthy)]))};})};
}

/** Baseline rows are independently read before admission. Earlier closed sessions
 * stay visible and unchanged; no historical transition is invented for them. */
export function verifyProviderTransitionHistory(team:string,providers:readonly string[],baseline:readonly Row[],current:readonly Row[],events:readonly Row[],retained:Map<string,Row>):void{
 const code='ACCEPTANCE_PROVIDER_HISTORY';assert.ok(team&&providers.length&&providers.every(id=>typeof id==='string'&&id)&&new Set(providers).size===providers.length,code+': Exact frozen providers required');
 const scoped=(values:readonly Row[])=>{const selected=values.filter(value=>providers.includes(String(value.providerId)));assert.equal(new Set(selected.map(value=>value.id)).size,selected.length,code+': Ambiguous session identity');for(const value of selected)assert.equal(value.teamId,team,code+': Foreign session team');return new Map(selected.map(value=>[String(value.id),value]));};
 const bases=scoped(baseline),sessions=scoped(current);for(const provider of providers)assert.ok([...sessions.values()].some(value=>value.providerId===provider),code+': Frozen provider is absent from owning inventory');const selected=new Map<string,Row>(),bySession=new Map<string,Array<{event:Row;metadata:Row}>>();
 for(const[id,base]of bases){const value=sessions.get(id);assert.ok(value,code+': Original baseline session disappeared');if(base.status==='closed'||base.status==='expired')assert.deepEqual(value,base,code+': Historical unrelated session changed');}
 for(const event of events){if(event.action!=='provider.availability.updated')continue;const id=String(event.resource_id);if(!providers.includes(String(event.capacity_provider_id))&&!bases.has(id)&&!sessions.has(id))continue;
  const source=sessions.get(id);assert.ok(source,code+': Observed provider session omitted by owning inventory');const base=bases.get(id);if(base?.status==='closed'||base?.status==='expired')continue;
  assert.equal(event.team_id,team,code+': Foreign audit team');assert.equal(event.capacity_provider_id,source.providerId,code+': Foreign provider');assert.equal(event.membership_id,source.membershipId,code+': Foreign membership');assert.equal(event.actor_type,'system',code);assert.equal(event.actor_id,null,code);assert.equal(event.resource_type,'provider-availability-session',code);
  const metadata=row(JSON.parse(String(event.metadata_json)));assert.equal(metadata.providerId,source.providerId,code);assert.equal(metadata.membershipId,source.membershipId,code);assert.equal(metadata.availabilitySessionId,id,code);
  assert.ok(Number.isSafeInteger(metadata.sequence)&&Number(metadata.sequence)>=1,code+': Original monotonic sequence required');assert.ok(['open','draining','closed','expired'].includes(String(metadata.status)),code+': Original eligibility required');
  assert.equal(event.idempotency_key,metadata.sequence+':'+metadata.status,code);assert.equal(event.id,createHash('sha256').update('provider.availability.updated:'+id+':'+metadata.sequence+':'+metadata.status).digest('base64url'),code+': Changed original observation identity');assert.ok(!selected.has(String(event.id)),code+': Duplicate original observation');
  const opened=providerClock(metadata.openedAt),refreshed=providerClock(metadata.refreshedAt),expires=providerClock(metadata.expiresAt),observed=providerClock(event.created_at);assert.ok(opened<=refreshed&&expires>refreshed,code+': Invalid original validity window');providerClock(metadata.availableFrom);if(metadata.availableUntil!==null)providerClock(metadata.availableUntil);
  if(metadata.status==='closed'){assert.equal(event.created_at,metadata.closedAt,code);assert.ok(providerClock(metadata.closedAt)>=refreshed,code);}else{assert.equal(metadata.closedAt,null,code);assert.equal(observed,refreshed,code);}
  for(const field of['maxConcurrentWorkers','availableWorkers','reservedWorkers','borrowedWorkers'])assert.ok(Number.isSafeInteger(metadata[field])&&Number(metadata[field])>=0,code+': Original measured supply required');
  assert.ok(Array.isArray(metadata.lanes)&&Array.isArray(metadata.adapters),code+': Complete lane and adapter inventories required');assert.match(String(metadata.constraintsDigest),/^sha256:[A-Za-z0-9_-]{43}$/u,code);
  const adapters=metadata.adapters.map(row);assert.equal(new Set(adapters.map(value=>value.id)).size,adapters.length,code+': Duplicate adapter identity');for(const adapter of adapters){assert.ok(typeof adapter.id==='string'&&adapter.id&&typeof adapter.status==='string'&&Array.isArray(adapter.capabilities)&&Array.isArray(adapter.laneIds)&&Array.isArray(adapter.offers),code);assert.match(String(adapter.nativeLimitsDigest),/^sha256:[A-Za-z0-9_-]{43}$/u,code);if(adapter.modelPolicyDigest!==null)assert.match(String(adapter.modelPolicyDigest),/^sha256:[A-Za-z0-9_-]{43}$/u,code);assert.ok(adapter.modelHealthy===null||typeof adapter.modelHealthy==='boolean',code);const health=row(adapter.capabilityHealth);assert.deepEqual(Object.keys(health).sort(),[...adapter.capabilities].sort(),code);for(const value of Object.values(health))assert.ok(value===null||typeof value==='boolean',code);}
  const prior=retained.get(String(event.id));if(prior)assert.deepEqual(event,prior,code+': Original retained observation changed');selected.set(String(event.id),event);const history=bySession.get(id)??[];history.push({event,metadata});bySession.set(id,history);
 }
 for(const[id,session]of sessions){const base=bases.get(id);if(base?.status==='closed'||base?.status==='expired')continue;const history=(bySession.get(id)??[]).sort((a,b)=>Number(a.metadata.sequence)-Number(b.metadata.sequence)||providerClock(a.event.created_at)-providerClock(b.event.created_at)||(a.metadata.status==='open'?-1:1));
  const first=base?Number(base.sequence):1;let sequence=first-1,previous:Row|undefined;
  for(const item of history){const value=item.metadata;if(Number(value.sequence)<first)continue;
   if(Number(value.sequence)===sequence)assert.ok(previous?.status==='open'&&['draining','closed','expired'].includes(String(value.status)),code+': Duplicate or reversed eligibility transition');else{assert.equal(value.sequence,sequence+1,code+': Missing provider refresh');assert.equal(value.status,'open',code+': Original open publication required');if(previous)assert.equal(previous.status,'open',code+': Refresh after terminal closure');}
   if(previous){for(const key of['providerId','membershipId','availabilitySessionId','openedAt'])assert.deepEqual(value[key],previous[key],code+': Original provider authority changed');assert.ok(providerClock(item.event.created_at)>=providerClock(previous.status==='closed'?previous.closedAt:previous.refreshedAt),code+': Reversed original provider time');}
   if(base&&value.sequence===first&&value.status===base.status)assert.deepEqual(value,providerObservation(base),code+': Baseline differs from its original observation');sequence=Number(value.sequence);previous=value;
  }
  assert.ok(previous,code+': Complete original provider history missing');assert.deepEqual(previous,providerObservation(session),code+': Current health eligibility timing or source differs from the complete original history');
 }
 for(const[id,event]of retained)assert.deepEqual(selected.get(id),event,code+': Original retained transition disappeared');
 for(const[id,event]of selected)retained.set(id,structuredClone(event));
}

/** Hold independent public roots around complete audit paging; concurrent changes
 * require a fresh observation inside the caller's original inspection deadline. */
export function readProviderTransitionHistory(team:string,providers:readonly string[],deadline:number,reader:typeof read=read):{sessions:Row[];events:Row[]}{
 const selected=(values:Row[])=>values.filter(value=>providers.includes(String(value.providerId)));
 for(let round=0;round<40;round++){
  assert.ok(Number.isFinite(deadline)&&Date.now()<=deadline,'ACCEPTANCE_PROVIDER_HISTORY: Original inspection deadline elapsed');
  const before=availabilityHistory(team,reader),events=collectCompleteEvidence(cursor=>reader(['capacity','audit','--limit','100',...(cursor?['--cursor',cursor]:[])],team),100,'ACCEPTANCE_PROVIDER_AUDIT','descending','created_at'),after=availabilityHistory(team,reader);
  if(isDeepStrictEqual(selected(before),selected(after)))return{sessions:before,events};
 }
 assert.fail('ACCEPTANCE_PROVIDER_HISTORY: Complete concurrent provider inventory not reached within the original forty-round bound');
}

/** Replay the owning broker's original sequence, retained through existing
 * encrypted diagnostics. Public lifecycle and result rows must independently agree. */
export function verifySandboxTransitionHistory(run:Row,items:readonly Row[],events:readonly Row[]):void{
 const label='ACCEPTANCE_SANDBOX_HISTORY',owners=new Map<string,Row>();
 for(const item of items){const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt);assert.deepEqual(attempt,item.assignmentAttempt,label);assert.equal(attempt.id,item.id,label);assert.equal(attempt.workdayId,run.id,label);assert.equal(attempt.teamId,run.teamId,label);assert.ok(!owners.has(attempt.id),label);owners.set(attempt.id,item);}
 for(const event of events.filter(value=>String(value.eventType).startsWith('provider.sandbox.'))){const owner=owners.get(String(event.assignmentId));assert.ok(owner,label+': Sandbox observation lacks independent owning assignment');const attempt=assignmentAttemptSchema.parse(owner.assignmentAttempt);assert.equal(event.runId,run.id,label);assert.equal(event.workdayId,run.id,label);assert.equal(event.teamId,run.teamId,label);assert.equal(event.projectId,attempt.projectId,label);assert.ok(!Object.hasOwn(row(event.context),'sandboxEvents'),label+': Original broker diagnostics must remain protected');}
 for(const[id,item]of owners){
  const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt),output=item.lifecycleOutput===undefined?{}:row(item.lifecycleOutput),owned=events.filter(value=>value.assignmentId===id),created=owned.filter(value=>value.eventType==='provider.sandbox.created'),closed=owned.filter(value=>value.eventType==='provider.sandbox.destroyed');
  const model=owned.some(value=>String(value.eventType).startsWith('provider.execution.')&&(Object.hasOwn(row(value.context),'model')||row(value.context).isolation==='microvm'));
  if(!created.length&&!closed.length&&!Object.hasOwn(output,'sandboxId')&&!(item.status==='completed'&&model))continue;
  assert.equal(created.length,1,label+': Exact public sandbox creation required');assert.ok(closed.length<=1,label+': Duplicate sandbox destruction');
  const born=created[0]!,context=row(born.context),sandboxId=context.sandboxId;assert.ok(typeof sandboxId==='string'&&sandboxId,label);assert.equal(born.status,'recorded',label);const bornAt=providerClock(born.createdAt);assert.ok(bornAt>=providerClock(attempt.createdAt),label);
  if(Object.hasOwn(output,'sandboxId'))assert.equal(output.sandboxId,sandboxId,label+': Owning result changed sandbox identity');
  if(!closed.length){assert.ok(!['completed','failed','cancelled','returned','expired'].includes(String(item.status)),label+': Terminal assignment lacks original broker destruction');continue;}
  const end=closed[0]!,safe=row(end.context),teardown=row(safe.teardown);assert.equal(end.status,'recorded',label);assert.equal(safe.sandboxId,sandboxId,label);assert.ok(Number(born.eventIndex)<Number(end.eventIndex)&&providerClock(end.createdAt)>=bornAt,label);assert.equal(teardown.verified,true,label+': Original physical teardown is unverified');
  const teardownAt=providerClock(teardown.completedAt);assert.ok(teardownAt>=bornAt&&teardownAt<=providerClock(end.createdAt)&&teardownAt<=providerClock(attempt.deadline),label+': Teardown exceeded its original clock authority');
  if(Object.hasOwn(output,'teardown'))assert.deepEqual(safe.teardown,output.teardown,label+': Public and owning result teardown disagree');
  const raw=row(end.protectedPayload).sandboxEvents;assert.ok(Array.isArray(raw)&&raw.length>=5,label+': Complete original protected broker history required');
  const history=raw.map(value=>{const parsed=sandboxEventSchema.parse(value);assert.deepEqual(parsed,value,label+': Original native record cannot be repaired on read');return parsed;});
  let previous=providerClock(attempt.createdAt);const tools=new Set<string>(),seenTools=new Set<string>();
  for(const[index,event]of history.entries()){
   assert.equal(event.sequence,index,label+': Original broker sequence has a gap duplicate or reordered event');assert.equal(event.assignmentId,id,label);assert.equal(event.sandboxId,sandboxId,label);const at=providerClock(event.occurredAt);assert.ok(at>=previous&&at<=teardownAt,label+': Original broker lifecycle clock changed');previous=at;
   if(event.type==='tool.requested'){const request=event.payload.requestId;assert.ok(typeof request==='string'&&request&&!seenTools.has(request),label+': Original tool request identity required');seenTools.add(request);tools.add(request);}
   if(event.type==='tool.completed'){assert.ok(typeof event.payload.requestId==='string'&&tools.delete(event.payload.requestId),label+': Tool completion lacks its original request');assert.equal(typeof event.payload.ok,'boolean',label);}
  }
  assert.equal(history[0]!.type,'sandbox.created',label);assert.equal(history[1]!.type,'sandbox.ready',label);assert.ok(providerClock(history[0]!.occurredAt)<=bornAt,label+': Public creation predates owning broker');
  const starts=history.filter(value=>value.type==='execution.started'),complete=history.filter(value=>value.type==='execution.completed'),failed=history.filter(value=>value.type==='execution.failed'),vms=history.filter(value=>value.type==='execution.progress'&&value.payload.stage==='vm.assigned'),destroyed=history.filter(value=>value.type==='sandbox.destroyed');
  assert.equal(history.filter(value=>value.type==='sandbox.created').length,1,label);assert.equal(history.filter(value=>value.type==='sandbox.ready').length,1,label);assert.equal(starts.length,1,label);assert.equal(complete.length,1,label+': Normal SDK execution lacks original completion');assert.equal(failed.length,0,label+': Failed native execution cannot advance a normal SDK campaign');assert.equal(vms.length,1,label);assert.equal(destroyed.length,1,label);assert.equal(history.at(-1),destroyed[0],label);assert.equal(destroyed[0]!.payload.verified,true,label);assert.equal(tools.size,0,label+': Original tool history is incomplete');
  assert.ok(bornAt<=providerClock(starts[0]!.occurredAt),label+': Public creation cannot follow productive execution');for(const event of history.filter(value=>value.type==='tool.requested'||value.type==='tool.completed'))assert.ok(event.sequence>starts[0]!.sequence&&event.sequence<complete[0]!.sequence,label+': Tool activity escaped its original productive lifetime');
  assert.ok(starts[0]!.sequence<vms[0]!.sequence&&vms[0]!.sequence<complete[0]!.sequence&&complete[0]!.sequence<destroyed[0]!.sequence,label+': Original execution and VM lifecycle order changed');
  const vm=vms[0]!.payload.vmId;assert.ok(typeof vm==='string'&&/^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(vm),label);assert.equal(destroyed[0]!.payload.vmId,vm,label);assert.equal(safe.vmId,vm,label+': Acquired and publicly destroyed VM identities disagree');
 }
}
