import{afterEach,expect,it,vi}from'vitest';
type Row=Record<string,any>;
const state=vi.hoisted(()=>({run:undefined as (()=>void)|undefined,freeze:{} as Row,read:vi.fn(),integrity:vi.fn()}));
vi.mock('node:test',()=>({default:(_name:string,run:()=>void)=>{state.run=run;}}));
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return{...fs,readFileSync:(...args:Parameters<typeof fs.readFileSync>)=>args[0]==='/frozen-smoke'?JSON.stringify(state.freeze):Reflect.apply(fs.readFileSync,fs,args)};});
vi.mock('../../../../acceptance/freeze-integrity.ts',()=>({verifyFreezeIntegrity:state.integrity}));
vi.mock('../../../../acceptance/acceptance-cli.ts',async original=>({...await original<typeof import('../../../../acceptance/acceptance-cli.ts')>(),read:state.read}));
await import('../../../../acceptance/guest-model-smoke.test.ts');
afterEach(()=>vi.unstubAllEnvs());
it("requires immutable freeze and independent protected native image readback in the original measured guest smoke before allowing later work",()=>{
 vi.stubEnv('TREESEED_ACCEPTANCE_FREEZE_PATH','/frozen-smoke');vi.stubEnv('TREESEED_ACCEPTANCE_TEAM','controlled-team');
 for(const mode of ['exact','missing-pin','changed-host-image','changed-host-generation','changed-host-manifest','missing-full','missing-live','missing-native','changed-live','changed-native','foreign-live','foreign-native','duplicate-live','duplicate-native']){
  const digest='sha256:'+'a'.repeat(64),assignmentId='assignment_controlled_smoke',host:Row={status:'active',generationId:'controlled-generation',manifestDigest:'sha256:'+'b'.repeat(64),guestImageDigest:digest};state.freeze={host:structuredClone(host),guest:{digest}};
  const event:Row={schemaVersion:'treeseed.sandbox-event/v1',sandboxId:'controlled-smoke-sandbox',assignmentId,sequence:0,occurredAt:'2026-10-17T00:00:00.000Z',type:'sandbox.created',payload:{profile:'controlled-profile',guestImageDigest:digest}};
  const live:Row={type:'sandbox.observed',payload:{brokerSequence:0},protectedPayload:{sandboxEvent:structuredClone(event)}},closed:Row={type:'sandbox.destroyed',protectedPayload:{sandboxEvents:[structuredClone(event)]}},traces=[live,closed];
  const diagnostics:Row={fullPayload:{events:traces}},send:Row={status:'complete',targets:[{projectSlug:'sdk',agentSlug:'architect',status:'responded',capacity:{assignmentId},diagnostics}],responses:[{projectSlug:'sdk',agentSlug:'architect',markdown:'Controlled unit response input.'}]};
  if(mode==='missing-pin')delete state.freeze.guest.digest;if(mode==='changed-host-image')host.guestImageDigest='sha256:'+'c'.repeat(64);if(mode==='changed-host-generation')host.generationId='other';if(mode==='changed-host-manifest')host.manifestDigest='sha256:'+'c'.repeat(64);
  if(mode==='missing-full')delete diagnostics.fullPayload;if(mode==='missing-live')traces.shift();if(mode==='missing-native')traces.pop();if(mode==='duplicate-live')traces.unshift(structuredClone(live));if(mode==='duplicate-native')traces.push(structuredClone(closed));
  if(mode==='changed-live')live.protectedPayload.sandboxEvent.payload.guestImageDigest='sha256:'+'c'.repeat(64);if(mode==='changed-native')closed.protectedPayload.sandboxEvents[0].payload.guestImageDigest='sha256:'+'c'.repeat(64);
  if(mode==='foreign-live')live.protectedPayload.sandboxEvent.assignmentId='assignment_foreign';if(mode==='foreign-native')closed.protectedPayload.sandboxEvents[0].assignmentId='assignment_foreign';
  state.integrity.mockReset();state.read.mockReset().mockImplementation((args:string[])=>{if(args[0]==='dev')return host;if(args[0]==='send')return send;if(args[0]==='providers')return{items:[{status:'approved',providerId:'controlled-provider'}]};if(args[0]==='assignments')return{status:'completed',executionKind:'conversation',capacityProviderId:'controlled-provider',assignmentResult:{usage:{native:{activeSeconds:1},modelOutputTokens:1}}};throw Error('Unexpected unit boundary');});
  const held=structuredClone({freeze:state.freeze,host,send});expect(state.run).toBeTypeOf('function');if(mode==='exact')expect(()=>state.run!()).not.toThrow();else expect(()=>state.run!(),mode).toThrow('ACCEPTANCE_SANDBOX_IMAGE');
  expect(state.integrity).toHaveBeenCalledExactlyOnceWith(state.freeze,expect.any(Function));if(mode.startsWith('changed-host')||mode==='missing-pin')expect(state.read.mock.calls.some(([args])=>args[0]==='send')).toBe(false);else expect(state.read.mock.calls.find(([args])=>args[0]==='send')?.[0]).toEqual(expect.arrayContaining(['--diagnostics','full']));expect({freeze:state.freeze,host,send}).toEqual(held);
 }
});
