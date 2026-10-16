import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {monitorCampaign,campaignPlanReviewRequired} from '../../../../acceptance/campaign.ts';

it('native public campaign failures retain exact typed classification raw transport causes and scoped stop through denial interruption and unchanged concurrent retry',async()=>{
 const teamId='native-team',workdayId='workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',show=controlPlaneOperation('workdays.show'),stop=controlPlaneOperation('workdays.stop');
 if(!show.descriptor.rest||!stop.descriptor.rest)throw new Error('Original public routes required');
 const route=(path:string)=>path.replace('{teamId}',teamId).replace('{runId}',workdayId),history:Array<{method:string;path:string;key:string;body:unknown}>=[],failures:unknown[]=[];let mode='exact';
 const server=createServer((request,response)=>{let bytes='';request.setEncoding('utf8');request.on('data',part=>{bytes+=String(part);});request.on('end',()=>{
  history.push({method:request.method??'',path:request.url??'',key:String(request.headers['idempotency-key']??''),body:bytes?JSON.parse(bytes):null});response.setHeader('content-type','application/json');
  if(request.method===show.descriptor.rest!.method&&request.url===route(show.descriptor.rest!.path)){
   if(mode==='interrupted'){request.socket.destroy();return;}if(mode==='json'||mode==='stop-denied'){response.end('{');return;}
   if(mode==='denied'){response.statusCode=403;response.end(JSON.stringify({error:{code:'controlled_native_denial',message:'Original denied observer'}}));return;}
   response.end(JSON.stringify({data:{run:{id:workdayId,teamId,status:'completed',executionMode:'simulation'}}}));return;
  }
  if(request.method===stop.descriptor.rest!.method&&request.url===route(stop.descriptor.rest!.path)){
   if(mode==='stop-denied'){response.statusCode=503;response.end(JSON.stringify({error:{code:'controlled_stop_failure',message:'Original interrupted scoped stop'}}));return;}
   response.end(JSON.stringify({data:{run:{id:workdayId,status:'cancelled'}}}));return;
  }response.statusCode=404;response.end('{}');
 });});
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-native-token'}),input={path:{teamId,runId:workdayId},query:{},body:undefined},held=structuredClone(input);
  const details={project:'sdk',proposal:'original-proposal sha256:'+'a'.repeat(64),workday:workdayId,'failed expectation':'Original frozen plan requires review.','observed evidence':'Retained native public read requires reviewed correction.','why implementation repair is insufficient':'Original authority requires reviewed correction.','smallest proposed plan correction':'Request review; no correction applied.'};
  const observe=async()=>{let original:unknown,failure:unknown,later=0,reports=0;const offset=history.length;
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:mode==='exact'?'completed':'running',mode:'simulation',planningEndsAt:1,endsAt:2}),inspect:async()=>{
    try{await client.invoke(show,input,{signal:AbortSignal.timeout(5_000)});if(mode==='review')throw campaignPlanReviewRequired(details,new Error('Original native authority observation'));}catch(error){original=error;throw error;}
   },now:()=>1,wait:async()=>{later++;},collaboration:()=>{},verify:()=>{later++;},reportPlanReview:report=>{expect(report).toBe((original as Error).message);reports++;},stop:async()=>{await client.invoke(stop,{...input,body:{reason:'Automated golden boundary failed'}},{idempotencyKey:'golden-stop:'+workdayId,signal:AbortSignal.timeout(5_000)});}});}catch(error){failure=error;}
   expect(input).toEqual(held);const stops=history.slice(offset).filter(row=>row.method===stop.descriptor.rest!.method);
   if(mode==='exact'){expect(failure).toBeUndefined();expect(later).toBe(1);expect(stops).toHaveLength(0);return;}
   const classification=mode==='review'?'PLAN_REVIEW_REQUIRED':mode==='interrupted'?'ENVIRONMENT_DEFECT':'IMPLEMENTATION_DEFECT';
   expect.soft(failure).toBeInstanceOf(Error);expect.soft(Object.getOwnPropertyDescriptor(Object(failure),'classification')?.value).toBe(classification);expect.soft(later).toBe(0);expect.soft(stops).toHaveLength(1);expect.soft(stops[0]?.key).toBe('golden-stop:'+workdayId);expect.soft(reports).toBe(mode==='review'?1:0);
   if(mode==='review')expect.soft(failure).toBe(original);else if(mode==='stop-denied'){expect.soft(failure).toBeInstanceOf(AggregateError);expect.soft((failure as AggregateError).errors).toContain(original);}else expect.soft((failure as Error)?.cause).toBe(original);
   failures.push({mode,original,failure});
  };
  await Promise.all([observe(),observe()]);for(mode of['json','denied','interrupted','review','stop-denied'])await observe();
  const retained=[...failures];mode='exact';await Promise.all([observe(),observe()]);expect(failures).toEqual(retained);expect(failures).toHaveLength(5);expect(history.every(row=>[route(show.descriptor.rest!.path),route(stop.descriptor.rest!.path)].includes(row.path))).toBe(true);
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));}
 expect(server.listening).toBe(false);
 // The native SDK/HTTP transport, monitor and scoped-stop request are real.
 // API responses and workday admission are controlled; no model, usage or physical closure is claimed.
},30_000);
