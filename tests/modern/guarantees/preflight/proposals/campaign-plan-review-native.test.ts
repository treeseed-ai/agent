import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {monitorCampaign,campaignPlanReviewRequired,retainCampaignPlanReview,retainCampaignWorkdayStart} from '../../../../acceptance/campaign.ts';
import {row} from '../../../../acceptance/acceptance-cli.ts';
afterEach(()=>vi.unstubAllEnvs());

it('native public scoped stop retains the exact original plan-review report and frozen bytes through report collision denial and terminal race without later stages',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-plan-review-stop-')),teamId='native-team',workdayId='workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const show=controlPlaneOperation('workdays.show'),stop=controlPlaneOperation('workdays.stop'),showRoute=show.descriptor.rest,stopRoute=stop.descriptor.rest;
 if(!showRoute||!stopRoute)throw new Error('Existing public Workday routes required');
 const path=(value:string)=>value.replace('{teamId}',teamId).replace('{runId}',workdayId);
 const history:Array<{method:string;path:string;key:string;body:unknown}>=[];let mode='exact',status='running';
 const server=createServer((request,response)=>{let bytes='';request.setEncoding('utf8');request.on('data',part=>{bytes+=String(part);});request.on('end',()=>{
  history.push({method:request.method??'',path:request.url??'',key:String(request.headers['idempotency-key']??''),body:bytes?JSON.parse(bytes):null});response.setHeader('content-type','application/json');
  if(request.method===showRoute.method&&request.url===path(showRoute.path)){response.end(JSON.stringify({data:{run:{id:workdayId,teamId,status,executionMode:'simulation'}}}));return;}
  if(request.method===stopRoute.method&&request.url===path(stopRoute.path)){
   if(mode==='stop-race')status='cancelled';if(mode==='stop-denied'||mode==='stop-race'){response.statusCode=503;response.end(JSON.stringify({error:{code:'controlled_stop_interruption',message:'Retained native stop interruption'}}));return;}
   status='cancelled';response.end(JSON.stringify({data:{run:{id:workdayId,status}}}));return;
  }response.statusCode=404;response.end(JSON.stringify({error:{code:'wrong_scope',message:'Wrong native Workday scope'}}));
 });});
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native loopback listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-native-token'});
  const failures:unknown[]=[];
  for(mode of ['exact','report-collision','missing-report','stop-denied','stop-race']){
   status='running';vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID','');const freezePath=join(root,mode+'.json'),freeze={proposal:{id:'original-proposal',digest:'sha256:'+'a'.repeat(64)},preflight:{id:'original-preflight',teamId,preflightDigest:'sha256:'+'a'.repeat(43)},request:{body:{executionMode:'simulation'}}},bytes=JSON.stringify(freeze);writeFileSync(freezePath,bytes);
   retainCampaignWorkdayStart({schemaVersion:'treeseed.workday-start-receipt/v1',workdayId,preflightId:freeze.preflight.id,preflightDigest:freeze.preflight.preflightDigest,startedAt:'2026-10-15T00:00:00.000Z',acceptedExecutionNodeIds:[],assignmentIds:[],reservationIds:[],providerReceiptRefs:[],transactionReceiptId:'workday-start:'+'b'.repeat(43)},freezePath,freeze);
   const receipt=readFileSync(freezePath+'.workday-start.json'),details={project:'sdk',proposal:freeze.proposal.id+' '+freeze.proposal.digest,workday:workdayId,'failed expectation':'Original frozen plan requires review.','observed evidence':'Retained native observation requires plan review.','why implementation repair is insufficient':'The original plan itself needs reviewed correction.','smallest proposed plan correction':'Request review; no change applied.'};
   const original=campaignPlanReviewRequired(details,Object.assign(new Error('Retained original transport cause'),{code:'ECONNREFUSED'})),held=Object.getOwnPropertyDescriptors(original),offset=history.length;let later=0,retained=0;
   const reportPath=freezePath+'.plan-review.txt';if(mode==='report-collision')writeFileSync(reportPath,'Original conflicting report retained');
   let current=row(row((await client.invoke(show,{path:{teamId,runId:workdayId},query:{},body:undefined})).data).run);
   const stopInput={path:{teamId,runId:workdayId},query:{},body:{reason:'Automated golden boundary failed'}},stopHeld=structuredClone(stopInput);
   let failure:unknown;try{await monitorCampaign({admittedSimulation:true,read:()=>({status:String(current.status),mode:String(current.executionMode),planningEndsAt:1,endsAt:2}),inspect:()=>{throw original;},now:()=>1,wait:async()=>{later++;},collaboration:()=>{later++;},verify:()=>{later++;},reportPlanReview:mode==='missing-report'?undefined:report=>{retained++;retainCampaignPlanReview(report,freezePath,freeze);},stop:async()=>{
    try{await client.invoke(stop,stopInput,{idempotencyKey:'golden-stop:'+workdayId});}
    catch(error){current=row(row((await client.invoke(show,{path:{teamId,runId:workdayId},query:{},body:undefined})).data).run);throw error;}
   }});}catch(error){failure=error;}
   if(mode==='exact'||mode==='stop-race')expect(failure).toBe(original);else{expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors).toContain(original);}
   expect(later).toBe(0);expect(retained).toBe(mode==='missing-report'?0:1);const stops=history.slice(offset).filter(item=>item.method===stopRoute.method&&item.path===path(stopRoute.path));expect(stops).toEqual([{method:stopRoute.method,path:path(stopRoute.path),key:'golden-stop:'+workdayId,body:stopInput.body}]);
   expect(readFileSync(freezePath,'utf8')).toBe(bytes);expect(readFileSync(freezePath+'.workday-start.json')).toEqual(receipt);expect(stopInput).toEqual(stopHeld);expect(Object.getOwnPropertyDescriptors(original)).toEqual(held);
   if(mode==='missing-report')expect(existsSync(reportPath)).toBe(false);else expect(readFileSync(reportPath,'utf8')).toBe(mode==='report-collision'?'Original conflicting report retained':original.message);
   failures.push({mode,message:failure instanceof Error?failure.message:String(failure),stops:stops.length});
  }
  expect(failures).toHaveLength(5);console.log(JSON.stringify({nativePlanReviewStopFailures:failures}));
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));rmSync(root,{recursive:true,force:true});}
 expect(server.listening).toBe(false);expect(existsSync(root)).toBe(false);
 // Controlled public responses prove transport and original report custody;
 // no real governed launch, provider usage or physical teardown is claimed.
},30_000);
