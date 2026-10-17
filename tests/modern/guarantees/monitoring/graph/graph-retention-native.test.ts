import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {row} from '../../../../acceptance/acceptance-cli.ts';
import {monitorCampaign} from '../../../../acceptance/campaign.ts';
import {observeLiveGraphRevisions} from '../../../../acceptance/workday/support/monitoring/live-graph-revisions.ts';
import {retainedGraph} from './graph-retention-fixture.ts';
const observe=observeLiveGraphRevisions;

it('native original SDK graph inventory detects a lost unrelated component before progression and retains scoped stop failed observations and unchanged concurrent retry',async()=>{
 const f=retainedGraph(),held=structuredClone(f),workdayId='workday-native-retention',requests:Array<{method:string;path:string}>=[],failures:unknown[]=[];let mode='exact';
 const route=(operation:string)=>{const descriptor=controlPlaneOperation(operation).descriptor.rest;if(!descriptor)throw new Error('Original public route required');return descriptor.path.replace('{teamId}',f.graph.teamId).replace('{runId}',workdayId);};
 const graphPath=route('execution.graph.show'),watchPath=route('execution.graph.watch'),stopPath=route('workdays.stop');
 const observedGraph=()=>{const graph=structuredClone(f.graph),history=structuredClone(f.history);
  if(mode==='operational-progress'||mode==='unrelated-edge'||mode==='unrelated-revision'){
   graph.revision=2;const record=structuredClone(history[0]!);record.revision=2;record.createdAt='2026-10-16T20:00:01.000Z';record.changes={added:[],changed:[],completed:[],blocked:[],stale:[],addedEdges:[],removedEdges:[]};
   if(mode==='operational-progress'){const node=graph.nodes.find(node=>node.id===f.outside.id)!;node.status='blocked';node.graphRevisionUpdated=2;record.changedSourceRefs=[node.sourceRef];record.changes.changed=[node.id];record.changes.blocked=[node.id];}
   else if(mode==='unrelated-revision'){const node=graph.nodes.find(node=>node.id===f.outside.id)!;node.nodeRevision++;node.graphRevisionUpdated=2;record.changedSourceRefs=[node.sourceRef];record.changes.changed=[node.id];}
   else{const edge={...graph.edges[0]!,id:'new-unrelated-cross-component-edge',fromNodeId:f.outside.id,graphRevisionCreated:2};graph.edges.push(edge);record.changes.addedEdges=[edge.id];}
   history.push(record);
  }
  return{graph,history};
 };
 const server=createServer((request,response)=>{const url=new URL(request.url!,'http://127.0.0.1');requests.push({method:String(request.method),path:url.pathname});response.setHeader('content-type','application/json');
  if(url.pathname===stopPath){response.end(JSON.stringify({data:{stopped:true}}));return;}
  if(mode==='interrupted'){request.socket.destroy();return;}if(mode==='denied'){response.writeHead(403).end('{}');return;}
  if(url.pathname===graphPath){const graph=observedGraph().graph;if(mode==='unrelated-change')graph.nodes.find(node=>node.id===f.outside.id)!.condition!.expectedState='foreign-content-authority';if(mode==='lost-node')graph.nodes.pop();if(mode==='lost-edge')graph.edges=[];if(mode==='unknown-node')graph.nodes.push({...structuredClone(f.outside),id:'unrecorded-node'});response.end(JSON.stringify({data:graph}));return;}
  if(url.pathname===watchPath){const cursor=url.searchParams.get('cursor')??'0',items=cursor==='0'?observedGraph().history:[];if(items[0]&&mode==='unknown-change')items[0].changes.changed.push('unknown-node');if(items[0]&&mode==='duplicate-change')items[0].changes.changed.push(f.graph.nodes[0]!.id,f.graph.nodes[0]!.id);response.end(JSON.stringify({data:{items,nextCursor:items.length?String(items.at(-1)!.revision):cursor}}));return;}
  response.writeHead(404).end('{}');
 });
 try {
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Original native listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-graph-retention-token'});
  const invoke=async(operation:string,query={})=>row((await client.invoke(controlPlaneOperation(operation),{path:{teamId:f.graph.teamId},query,body:undefined})).data);
  const execute=async()=>{let ended=false,progressed=0,stops=0;const snapshots:unknown[]=[],revisions=new Map();let failure:unknown;
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:ended?'completed':'running',mode:'simulation',planningEndsAt:1,endsAt:2}),inspect:()=>observe(f.graph.teamId,()=>invoke('execution.graph.show'),cursor=>invoke('execution.graph.watch',{cursor}),revisions,revision=>snapshots.push(structuredClone(revision)),{baseline:f.graph,baselineHistory:f.history,proposalId:f.graph.nodes[0]!.sourceRef.id,projectId:f.graph.nodes[0]!.projectId,workdayId:f.graph.nodes[0]!.workdayId!}),now:()=>1,wait:async()=>{ended=true;},collaboration:()=>{},verify:()=>{progressed++;},stop:async()=>{stops++;await client.invoke(controlPlaneOperation('workdays.stop'),{path:{teamId:f.graph.teamId,runId:workdayId},query:{},body:{reason:'Automated graph retention boundary failed'}},{idempotencyKey:'golden-stop:'+workdayId});}});}catch(error){failure=error;}
   if(mode==='exact'||mode==='operational-progress'){expect(failure).toBeUndefined();expect(progressed).toBe(1);expect(stops).toBe(0);expect(snapshots).toEqual(observedGraph().history);return;}
   expect(failure).toBeInstanceOf(Error);expect(progressed).toBe(0);expect(stops).toBe(1);expect(snapshots).toEqual([]);failures.push({mode,failure});
  };
  await Promise.all([execute(),execute()]);mode='operational-progress';await Promise.all([execute(),execute()]);for(mode of['unrelated-revision','unrelated-edge','unrelated-change','lost-node','lost-edge','unknown-node','unknown-change','duplicate-change','denied','interrupted'])await execute();
  const retained=[...failures];mode='exact';await Promise.all([execute(),execute()]);expect(failures).toEqual(retained);expect(f).toEqual(held);expect(requests.every(value=>[graphPath,watchPath,stopPath].includes(value.path))).toBe(true);
  // Real SDK/HTTP/original monitor and stop; graph/clock/admission DTOs are
  // controlled, not native SQL producer, model usage or managed golden proof.
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));}
 expect(server.listening).toBe(false);
},30_000);
