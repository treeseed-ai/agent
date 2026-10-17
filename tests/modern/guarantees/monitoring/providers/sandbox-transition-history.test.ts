import{expect,it}from'vitest';import*as history from'../../../../acceptance/workday/support/monitoring/provider-history.ts';import{sandboxHistoryFixture}from'./sandbox-history-fixture.ts';
type Row=Record<string,unknown>;
it('requires the original complete broker lifecycle and tool sequence in protected public history with exact assignment clocks and independently matching public teardown',()=>{
 const f=sandboxHistoryFixture(),held=structuredClone({item:f.item,events:f.events}),check=Reflect.get(history,'verifySandboxTransitionHistory') as(run:Row,items:readonly Row[],events:readonly Row[])=>void;expect(check).toBeTypeOf('function');check(f.run,[f.item],f.events);check(f.run,[f.item],f.events);
 const active={...f.item,status:'leased',completedAt:null,lifecycleOutput:{}};check(f.run,[active],f.events.slice(0,1));
 for(const mode of['missing-public-create','missing-public-destroy','missing-raw','missing-created','missing-ready','missing-start','missing-vm','missing-tool-complete','missing-execution-complete','missing-destroy','gap','duplicate','foreign-owner','foreign-team','foreign-vm','wrong-clock','after-teardown','changed-public-teardown','private-public-leak']){
  const item=structuredClone(f.item),events:Row[]=structuredClone(f.events),closed=events[1]!,raw=(closed.protectedPayload as Row).sandboxEvents as Row[];
  if(mode==='missing-public-create')events.shift();if(mode==='missing-public-destroy')events.pop();if(mode==='missing-raw')Reflect.deleteProperty(closed,'protectedPayload');
  const omit:Record<string,number>={'missing-created':0,'missing-ready':1,'missing-start':2,'missing-vm':3,'missing-tool-complete':5,'missing-execution-complete':6,'missing-destroy':7};if(mode in omit){raw.splice(omit[mode]!,1);raw.forEach((value,index)=>{value.sequence=index;});}
  if(mode==='gap')raw[3]!.sequence=9;if(mode==='duplicate')raw.splice(4,0,structuredClone(raw[3]!));if(mode==='foreign-owner')raw[2]!.assignmentId='foreign';if(mode==='foreign-team')events[0]!.teamId='foreign';if(mode==='foreign-vm')(raw[3]!.payload as Row).vmId='foreign';if(mode==='wrong-clock')raw[4]!.occurredAt=f.time(0);if(mode==='after-teardown')raw[7]!.occurredAt=f.time(20);if(mode==='changed-public-teardown')(closed.context as Row).teardown={verified:false,completedAt:f.time(9)};if(mode==='private-public-leak')(closed.context as Row).sandboxEvents=raw;
  const before=structuredClone({item,events});expect(()=>check(f.run,[item],events),mode).toThrow();expect({item,events}).toEqual(before);
 }
 expect({item:f.item,events:f.events}).toEqual(held);
});
