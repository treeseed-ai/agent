import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {monitorCampaign,requireFreshSdkSegment} from '../../../acceptance/campaign.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

it('native public SDK readback denies continued terminal and live segments before fresh golden advancement while retaining scoped stop and unchanged retry',async()=>{
 const freeze={request:{body:{executionMode:'simulation',proposalIds:['original']}}},original={id:'workday-native-fresh',teamId:'native-team',status:'completed',executionMode:'simulation',parameters:{proposalIds:['original']}},held=structuredClone({freeze,original});
 let presented:Row=structuredClone(original);const requests:Array<{method:string,path:string,body:unknown,key:string}>=[],failures:Row[]=[];
 const showPath='/v1/teams/'+original.teamId+'/workday-runs/'+original.id,route=controlPlaneOperation('workdays.stop').descriptor.rest;
 if(!route)throw new Error('Existing public scoped stop route required');
 const stopPath=route.path.replace('{teamId}',original.teamId).replace('{runId}',original.id);
 const server=createServer((request,response)=>{let body='';request.setEncoding('utf8');request.on('data',value=>{body+=String(value);});request.on('end',()=>{
  requests.push({method:String(request.method),path:String(request.url),body:body?JSON.parse(body):null,key:String(request.headers['idempotency-key']??'')});response.setHeader('content-type','application/json');
  if(request.method==='GET'&&request.url===showPath){response.end(JSON.stringify({data:{run:presented}}));return;}
  if(request.method==='POST'&&request.url===stopPath){response.end(JSON.stringify({data:{run:{id:original.id,status:'cancelled'}}}));return;}
  response.writeHead(404).end('{}');
 });});
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Original native listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-fresh-segment-token'});
  const execute=async()=>{
   requireFreshSdkSegment(freeze);
   const observed=row(row((await client.invoke(controlPlaneOperation('workdays.show'),{path:{teamId:original.teamId,runId:original.id},query:{},body:undefined})).data).run),before=structuredClone(observed);let later=false;
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:String(observed.status),mode:String(observed.executionMode),planningEndsAt:0,endsAt:1}),now:()=>1,wait:async()=>{throw new Error('No later segment or wait permitted');},collaboration:()=>{},inspect:()=>requireFreshSdkSegment(freeze,observed),verify:()=>{later=true;},stop:async()=>{await client.invoke(controlPlaneOperation('workdays.stop'),{path:{teamId:original.teamId,runId:original.id},query:{},body:{reason:'Automated golden boundary failed'}},{idempotencyKey:'golden-stop:'+original.id});}});}
   finally{expect(observed).toEqual(before);expect({freeze,original}).toEqual(held);}
   return later;
  };
  expect(await Promise.all([execute(),execute()])).toEqual([true,true]);
  for(const status of ['running','completed'])for(const parent of ['settled-parent',null,'']){
   presented={...structuredClone(original),status,parameters:{...original.parameters,continueFromWorkdayId:parent}};const before=structuredClone(presented),offset=requests.length;
   await expect(execute()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_FRESH_SEGMENT');expect(presented).toEqual(before);failures.push(before);
   expect(requests.slice(offset).filter(value=>value.method==='POST')).toEqual(status==='running'?[{method:'POST',path:stopPath,body:{reason:'Automated golden boundary failed'},key:'golden-stop:'+original.id}]:[]);
  }
  const retained=structuredClone(failures);presented=structuredClone(original);expect(await Promise.all([execute(),execute()])).toEqual([true,true]);expect(failures).toEqual(retained);
  expect(requests.filter(value=>value.method==='POST')).toHaveLength(3);
  // Real public SDK/HTTP/monitor guard; controlled original run DTOs are not
  // native continuation production, managed usage or a fresh golden receipt.
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));}
 expect(server.listening).toBe(false);
},30_000);
