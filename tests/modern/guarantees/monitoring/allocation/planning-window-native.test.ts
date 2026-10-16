import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {assignmentResultSchema} from '@treeseed/sdk/agent-capacity';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {portableKernel} from '../../../kernel/architecture/portable/portable-kernel-fixture.ts';
import {monitorCampaign} from '../../../../acceptance/campaign.ts';
import {verifyAllocation,verifyPlanningWindow} from '../../../../acceptance/workday/support/monitoring/assignment-allocation.ts';
import {row,type Row} from '../../../../acceptance/acceptance-cli.ts';
import {liveAssignmentRecord} from '../live-assignment-fixture.ts';
import {planningWindowScope} from './planning-window-fixture.ts';

it('native Kernel Git and public SDK planning observations deny early issuance and changed phase before scoped stop while retaining exact failed evidence and unchanged retry',async()=>{
 const f=await portableKernel();let server:ReturnType<typeof createServer>|undefined;
 try{
  const candidate=await f.candidate(),produced=await f.run();expect(produced.status).toBe('completed');const result=assignmentResultSchema.parse(produced.outputs?.assignmentResult);
  const item:Row={...liveAssignmentRecord(f.attempt),status:'completed',leaseState:'released',completedAt:result.completedAt,assignmentResult:result};Object.assign(row(item.assignmentAttempt),{status:'completed',finishedAt:result.completedAt});
  const scope=planningWindowScope(item),run:Row={...scope.run,status:'completed'};row(row(row(item.explanation).metadata).allocation).opportunity=scope.opportunity;
  const held=structuredClone({item,run}),requests:Array<{method:string,path:string,body:unknown,key:string}>=[],failures:Row[]=[];let mode='exact';
  const showPath='/v1/teams/'+run.teamId+'/workday-runs/'+run.id,assignmentPath='/v1/teams/'+run.teamId+'/capacity/assignments/'+item.id,route=controlPlaneOperation('workdays.stop').descriptor.rest;if(!route)throw new Error('Original public scoped stop route required');const stopPath=route.path.replace('{teamId}',String(run.teamId)).replace('{runId}',String(run.id));
  server=createServer((request,response)=>{let body='';request.setEncoding('utf8');request.on('data',value=>{body+=String(value);});request.on('end',()=>{
   requests.push({method:String(request.method),path:String(request.url),body:body?JSON.parse(body):null,key:String(request.headers['idempotency-key']??'')});response.setHeader('content-type','application/json');
   if(request.method==='POST'&&request.url===stopPath){response.end(JSON.stringify({data:{run:{id:run.id,status:'cancelled'}}}));return;}
   if(request.method==='GET'&&request.url===showPath){response.end(JSON.stringify({data:{run:{...run,status:mode==='exact'?'completed':'running'}}}));return;}
   if(request.method!=='GET'||request.url!==assignmentPath){response.writeHead(404).end('{}');return;}
   if(mode==='denied'){response.writeHead(403).end(JSON.stringify({status:403,title:'Retained planning observation denial',code:'original_phase_read_denied'}));return;}if(mode==='interrupted'){request.socket.destroy();return;}
   const observed=structuredClone(item),attempt=row(observed.assignmentAttempt),opportunity=row(row(row(row(observed.explanation).metadata).allocation).opportunity);
   if(mode==='early'){attempt.createdAt=new Date(Date.parse(String(attempt.createdAt))-1).toISOString();observed.createdAt=attempt.createdAt;}if(mode==='phase')opportunity.phase='planning';if(mode==='missing-phase')delete opportunity.phase;
   if(mode==='workday')attempt.workdayId='foreign';if(mode==='team')attempt.teamId='foreign';if(mode==='clock')attempt.createdAt='invalid';response.end(JSON.stringify({data:observed}));
  });});
  await new Promise<void>((accept,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native original listener required');const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-planning-window-token'});
  const execute=async()=>{
   const observedRun=row(row((await client.invoke(controlPlaneOperation('workdays.show'),{path:{teamId:run.teamId,runId:run.id},query:{},body:undefined})).data).run);let later=false;const offset=requests.length;let observation:Row|undefined;
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:String(observedRun.status),mode:String(observedRun.executionMode),planningEndsAt:0,endsAt:1}),now:()=>1,wait:async()=>{throw new Error('No further work after original boundary');},collaboration:()=>{},inspect:async()=>{
    observation=row((await client.invoke(controlPlaneOperation('assignments.show'),{path:{teamId:run.teamId,assignmentId:item.id},query:{},body:undefined})).data);const before=structuredClone(observation);try{verifyPlanningWindow(observation,observedRun);verifyAllocation(observation,observedRun);}finally{expect(observation).toEqual(before);}
   },verify:()=>{later=true;},stop:async()=>{await client.invoke(controlPlaneOperation('workdays.stop'),{path:{teamId:run.teamId,runId:run.id},query:{},body:{reason:'Automated golden boundary failed'}},{idempotencyKey:'golden-stop:'+run.id});}});}
   catch(error){failures.push({mode,error:String(error),...(observation?{observation:structuredClone(observation)}:{})});throw error;}
   finally{expect({item,run}).toEqual(held);if(mode!=='exact')expect(requests.slice(offset).filter(value=>value.method==='POST')).toEqual([{method:'POST',path:stopPath,body:{reason:'Automated golden boundary failed'},key:'golden-stop:'+run.id}]);}
   return later;
  };
  expect(await Promise.all([execute(),execute()])).toEqual([true,true]);for(mode of ['early','phase','missing-phase','workday','team','clock','denied','interrupted'])await expect(execute(),mode).rejects.toBeInstanceOf(Error);
  const retained=structuredClone(failures);mode='exact';expect(await Promise.all([execute(),execute()])).toEqual([true,true]);expect(failures).toEqual(retained);expect(failures).toHaveLength(8);expect(f.git('rev-parse','HEAD')).toBe(candidate);expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(result);
  // Real owning Kernel/Git result and public SDK/HTTP consumer; original phase
  // records are controlled inputs, not PostgreSQL admission or model outcomes.
 }finally{if(server?.listening){server.closeAllConnections();await new Promise<void>((accept,reject)=>server!.close(error=>error?reject(error):accept()));}await f.close();}
 expect(server?.listening).toBe(false);
},30_000);
