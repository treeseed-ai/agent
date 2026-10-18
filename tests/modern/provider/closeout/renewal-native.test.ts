import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {expect,it} from 'vitest';
import {ProviderProtocolClient} from '@treeseed/sdk/capacity-provider';
import {runProviderAssignment} from '../../../../src/provider/operations/runner.ts';
import {assignment,runtimeBuild,timingAwareness,treeDx,responseReference,deferred} from './runner-fixture.ts';

async function awaitRenewal(gate:Promise<void>,reason:string){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([gate,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(reason)),1_000);})]);}finally{clearTimeout(timer);}
}

// Native HTTP, original SDK transport, Kernel and runner. Responses are controlled
// protocol inputs, not real model clocks, TreeDX products or PostgreSQL settlement.
it('native provider transport keeps the original lease alive through publication and terminal acknowledgment and closes on publication failure',async()=>{
 for(const failure of [false,true]){
  const calls:Array<{path:string;method:string;body:Record<string,unknown>;at:number}>=[];
  let renewals=0,publishing=false,completing=false;
  const publicationGate=deferred<void>(),terminalGate=deferred<void>();
  let publicationBaseline=0,terminalBaseline=0;
  const server=createServer((request,response)=>{let bytes='';request.setEncoding('utf8');request.on('data',chunk=>{bytes+=chunk;});request.on('end',()=>{void(async()=>{
   const path=request.url??'',method=request.method??'',body=bytes?JSON.parse(bytes):{};calls.push({path,method,body,at:performance.now()});
   if(request.headers.authorization!=='Bearer native-control-token'){response.writeHead(403).end('{}');return;}
   response.setHeader('content-type','application/json');
   if(path.endsWith('/renew')){renewals++;if(publishing&&renewals>publicationBaseline)publicationGate.resolve();if(completing&&renewals>terminalBaseline)terminalGate.resolve();response.end(JSON.stringify({data:{assignment:{leaseExpiresAt:new Date(Date.now()+60_000).toISOString()}}}));return;}
   if(path.endsWith('/discussion-response')){
    publishing=true;publicationBaseline=renewals;
    await awaitRenewal(publicationGate.promise,'Native publication lost its lease renewal');
    publishing=false;
    if(failure){response.writeHead(503).end(JSON.stringify({type:'about:blank',title:'Original native publication failure',status:503,code:'native_publication_failed'}));return;}
    response.end(JSON.stringify({data:{schemaVersion:'treeseed.provider-discussion-response-receipt/v1',assignmentId:'assignment-1',invocationId:'native-invocation',status:'responded',reference:responseReference,messageRef:responseReference.path,settledAt:new Date().toISOString()}}));return;
   }
   if(path.endsWith('/complete')){
    completing=true;terminalBaseline=renewals;
    await awaitRenewal(terminalGate.promise,'Native terminal acknowledgment lost its lease renewal');
    completing=false;response.end(JSON.stringify({data:{status:'completed'}}));return;
   }
   response.end(JSON.stringify({data:method==='GET'?{id:'assignment-1',stateVersion:7}:{ok:true}}));
  })().catch(error=>{response.writeHead(500).end(JSON.stringify({type:'about:blank',title:String(error),status:500}));});});});
  try{
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Native HTTP address required');
   const client=new ProviderProtocolClient({controlPlaneUrl:`http://127.0.0.1:${address.port}`,accessToken:'native-control-token',requestTimeoutMs:2_000});
   const input=assignment('conversation'),held=structuredClone(input),outputs:Record<string,unknown>[]=[];
   const run=runProviderAssignment({client,assignment:input,treeDx,leaseToken:'lease',runnerId:'runner',runtimeBuild,renewalIntervalMs:10,onCloseoutOutput:async output=>{outputs.push(structuredClone(output));},
    executor:{id:'codex',observe:async()=>({available:true}),execute:async request=>{await request.beginExecution?.();return{status:'responded',summary:'Native transport controlled reply.',responseMarkdown:'Native transport controlled reply.',outputs:{timingAwareness},usage:[{activeSeconds:2,elapsedSeconds:3}]};}}});
   if(failure){await expect(run).rejects.toThrow('Original native publication failure');expect(calls.some(call=>call.path.endsWith('/settle')||call.path.endsWith('/complete'))).toBe(false);}
   else{expect(await run).toMatchObject({status:'completed'});expect(calls.filter(call=>call.path.endsWith('/settle'))).toHaveLength(1);expect(calls.filter(call=>call.path.endsWith('/complete'))).toHaveLength(1);expect(outputs.at(-1)).toMatchObject({assignmentResult:{references:[responseReference]}});}
   expect(calls.filter(call=>call.path.endsWith('/discussion-response'))).toHaveLength(1);expect(renewals).toBeGreaterThanOrEqual(failure?1:2);
   for(const call of calls.filter(call=>call.path.endsWith('/renew')))expect(call.body).toEqual({leaseToken:'lease',runnerId:'runner',leaseSeconds:300});
   const count=calls.length;await delay(40);expect(calls).toHaveLength(count);expect(input).toEqual(held);
  }finally{publicationGate.resolve();terminalGate.resolve();server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
