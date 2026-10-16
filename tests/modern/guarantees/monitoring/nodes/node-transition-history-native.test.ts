import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {assignmentResultSchema} from '@treeseed/sdk/agent-capacity';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {portableKernel} from '../../../kernel/architecture/portable/portable-kernel-fixture.ts';
import {monitorCampaign} from '../../../../acceptance/campaign.ts';
import * as observation from '../../../../acceptance/workday/support/campaign-observation.ts';
import {row,type Row} from '../../../../acceptance/acceptance-cli.ts';
import {liveAssignmentRecord,liveAssignmentGraph} from '../live-assignment-fixture.ts';

it('native Kernel Git and public SDK node histories deny omitted changed or interrupted transitions before scoped stop and preserve exact retry',async()=>{
 const f=await portableKernel();let server:ReturnType<typeof createServer>|undefined;
 try{
  const candidate=await f.candidate(),produced=await f.run();expect(produced.status).toBe('completed');const result=assignmentResultSchema.parse(produced.outputs?.assignmentResult);
  const item=liveAssignmentRecord(f.attempt),graph=liveAssignmentGraph(item),node=(graph.nodes as Row[])[0]!,run={id:f.attempt.workdayId,teamId:f.attempt.teamId,status:'running',executionMode:'simulation',startedAt:f.attempt.createdAt};
  node.status='completed';const statuses=['ready','assigned','running','completed'];
  const events:Row[]=statuses.map((status,index)=>({id:'native-node-state-'+index,eventType:'execution.node.state',eventIndex:index,runId:run.id,workdayId:run.id,teamId:run.teamId,projectId:node.projectId,assignmentId:null,status:'recorded',createdAt:index===3?result.completedAt:f.attempt.createdAt,context:{nodeId:node.id,nodeRevision:node.nodeRevision,graphRevision:node.graphRevisionUpdated,status,previousStatus:index?statuses[index-1]:null},parameters:{},metadata:{},refs:{}}));
  const held=structuredClone({graph,events,result}),requests:Array<{method:string;path:string;key:string;body:unknown}>=[],failures:Row[]=[];let mode='exact';
  const route=(operation:string)=>{const rest=controlPlaneOperation(operation).descriptor.rest;if(!rest)throw new Error('Original public route required');return rest.path.replace('{teamId}',run.teamId).replace('{runId}',run.id);};
  const graphPath=route('execution.graph.show'),eventPath=route('workdays.events.list'),stopPath=route('workdays.stop');
  server=createServer((request,response)=>{let body='';request.setEncoding('utf8');request.on('data',part=>{body+=String(part);});request.on('end',()=>{
   const url=new URL(request.url??'','http://127.0.0.1');requests.push({method:request.method??'',path:url.pathname,key:String(request.headers['idempotency-key']??''),body:body?JSON.parse(body):null});response.setHeader('content-type','application/json');
   if(request.method==='POST'&&url.pathname===stopPath){response.end(JSON.stringify({data:{run:{id:run.id,status:'cancelled'}}}));return;}
   if(request.method==='GET'&&url.pathname===graphPath){response.end(JSON.stringify({data:graph}));return;}
   if(request.method!=='GET'||url.pathname!==eventPath){response.writeHead(404).end('{}');return;}
   if(mode==='denied'){response.writeHead(403).end(JSON.stringify({status:403,title:'Retained node history denial',code:'native_node_history_denied'}));return;}
   if(mode==='malformed'){response.end('{');return;}if(mode==='interrupted'){request.socket.destroy();return;}
   const values=structuredClone(events);if(mode.startsWith('missing-'))values.splice(Number(mode.slice(8)),1);
   if(mode==='wrong-prior')row(values[2]!.context).previousStatus='completed';if(mode==='wrong-node')row(values[2]!.context).nodeId='foreign';if(mode==='wrong-terminal')row(values[3]!.context).status='failed';if(mode==='wrong-revision')row(values[3]!.context).nodeRevision=2;
   if(mode==='before-workday')values[0]!.createdAt=new Date(Date.parse(f.attempt.createdAt)-1).toISOString();
   if(mode==='duplicate')values.push(structuredClone(values[2]!));values.forEach((value,eventIndex)=>{value.eventIndex=eventIndex;});
   response.end(JSON.stringify({data:{items:values,page:{limit:100,hasMore:false,nextCursor:null}}}));
  });});
  await new Promise<void>((accept,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native node history address required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-node-history-token'});
  const execute=async()=>{
   let later=false,collaborated=false;const offset=requests.length,retained=new Map<string,Row>(),captured:Row[]=[];
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:mode==='exact'?'completed':'running',mode:'simulation',planningEndsAt:0,endsAt:1}),now:()=>1,wait:async()=>{throw new Error('No later waiting permitted');},collaboration:()=>{collaborated=true;},verify:()=>{later=true;},inspect:async()=>{
    const current=row((await client.invoke(controlPlaneOperation('execution.graph.show'),{path:{teamId:run.teamId},query:{},body:undefined})).data),page=row((await client.invoke(controlPlaneOperation('workdays.events.list'),{path:{teamId:run.teamId,runId:run.id},query:{limit:100},body:undefined})).data);
    const values=observation.retainCampaignEventHistory(page.items as Row[],run,retained,event=>{captured.push(event);});
    const check=Reflect.get(observation,'verifyNodeTransitionHistory') as (run:Row,graph:Row,events:readonly Row[])=>void;check(run,current,values);if(mode==='exact'){expect(captured).toEqual(events);const metadataOnly=structuredClone(current);metadataOnly.revision=Number(current.revision)+1;(metadataOnly.nodes as Row[])[0]!.graphRevisionUpdated=metadataOnly.revision;check(run,metadataOnly,values);}
   },stop:async()=>{await client.invoke(controlPlaneOperation('workdays.stop'),{path:{teamId:run.teamId,runId:run.id},query:{},body:{reason:'Automated golden boundary failed'}},{idempotencyKey:'golden-stop:'+run.id});}});
   }finally{expect({graph,events,result}).toEqual(held);if(mode!=='exact'){expect(later).toBe(false);expect(collaborated).toBe(false);expect(requests.slice(offset).filter(value=>value.method==='POST')).toEqual([{method:'POST',path:stopPath,key:'golden-stop:'+run.id,body:{reason:'Automated golden boundary failed'}}]);}}
   return later;
  };
  expect(await Promise.all([execute(),execute()])).toEqual([true,true]);
  for(mode of ['missing-0','missing-1','missing-2','missing-3','wrong-prior','wrong-node','wrong-terminal','wrong-revision','before-workday','duplicate','denied','malformed','interrupted']){let failure:unknown;try{await execute();}catch(error){failure=error;}expect(failure,mode).toBeInstanceOf(Error);failures.push({mode,error:String(failure)});}
  const retained=structuredClone(failures);mode='exact';expect(await Promise.all([execute(),execute()])).toEqual([true,true]);expect(failures).toEqual(retained);expect(f.git('rev-parse','HEAD')).toBe(candidate);expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(result);
  console.log(JSON.stringify({nativeNodeHistoryDenials:failures}));
  // Native Kernel/Git and original SDK/HTTP boundaries; upstream graph/events
  // are controlled. API owns separate independent PostgreSQL producer proof.
 }finally{if(server?.listening){server.closeAllConnections();await new Promise<void>((accept,reject)=>server!.close(error=>error?reject(error):accept()));}await f.close();}
 expect(server?.listening).toBe(false);
},30_000);
