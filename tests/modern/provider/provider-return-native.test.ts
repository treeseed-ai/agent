import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import { runProviderAssignment } from '../../../src/provider/operations/runner.ts';
import { assignment, client, runtimeBuild, timingAwareness, treeDx } from './provider-runner-fixture.ts';

// Real owning runner, Kernel, handler and public SDK over native HTTP. The
// upstream reply is controlled input, not native PostgreSQL/accounting proof.
describe('provider return measurement transport', () => {
 it('native returned execution transmits the same measured settlement and return without inventing model usage or completing work', async () => {
  const received:Array<{path:string;body:Record<string,unknown>}> = [];
  const server=createServer((request,response)=>{
   let body='';request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk;});
   request.on('end',()=>{received.push({path:request.url??'',body:JSON.parse(body)});
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({data:request.url?.endsWith('/return')?{assignment:{id:'assignment-1',status:'returned'}}:{replayed:false}}));
   });
  });
  try{
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   const address=server.address();if(!address||typeof address==='string')throw new Error('Native transport address missing');
   const wire=new ProviderProtocolClient({controlPlaneUrl:`http://127.0.0.1:${address.port}`,accessToken:'isolated-provider-token'}),api=client();
   const usage=[{activeSeconds:2.25,elapsedSeconds:3.125,nativeUsage:{input_tokens:19},inputTokens:19}];
   const before=structuredClone(usage),value=assignment();
   const result=await runProviderAssignment({client:{...api,reportAssignmentUsage:wire.reportAssignmentUsage.bind(wire),
    settleAssignment:wire.settleAssignment.bind(wire),returnAssignment:wire.returnAssignment.bind(wire)},assignment:value,treeDx,
    leaseToken:'isolated-lease',runnerId:'isolated-runner',runtimeBuild,
    executor:{id:'codex',observe:async()=>({available:true}),execute:async request=>{
     await request.beginExecution?.();return {status:'returned',code:'sandbox_resource_exhausted',summary:'Original isolated resource failure.',
      retryable:true,usage,outputs:{teardown:{verified:true,completedAt:new Date().toISOString()},timingAwareness}};
    }}});
   expect(result).toEqual({assignment:{id:'assignment-1',status:'returned'}});
   expect(received.map(row=>row.path)).toEqual(['/v1/provider/assignments/assignment-1/usage','/v1/provider/assignments/assignment-1/settle','/v1/provider/assignments/assignment-1/return']);
   const settled=received[1]!.body,returned=received[2]!.body;
   expect(settled).toMatchObject({activeSeconds:3,elapsedSeconds:4,usageActual:{activeSeconds:2.25,elapsedSeconds:3.125,inputTokens:19,nativeUsage:{input_tokens:19}}});
   expect(returned).toMatchObject({code:'sandbox_resource_exhausted',reason:'Original isolated resource failure.',activeSeconds:3,elapsedSeconds:4,usage:settled.usageActual});
   expect(usage).toEqual(before);expect(api.completeAssignment).not.toHaveBeenCalled();expect(api.failAssignment).not.toHaveBeenCalled();
  }finally{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));expect(server.listening).toBe(false);}
 });
});
