import {createServer} from 'node:http';
import {it,expect} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {verifyReportWorkdayAuthority} from '../../../acceptance/workday/support/campaign-observation.ts';

it('native public SDK readback retains the sole applied-plan report and rejects contradictions interrupted reads and altered authority before unchanged retry',async()=>{
 const startsAt='2026-10-16T00:00:00.000Z',workdayId='workday-native-report-authority',teamId='native-report-team';
 const compiled=compileWorkday({id:workdayId,teamId,policyId:'default',policyRevision:1,executionMode:'simulation',startsAt,agentIds:[],policy:DEFAULT_WORKDAY_POLICY});
 const reference={kind:'treedx' as const,projectId:'native-project',repository:'native-library',commit:'a'.repeat(40),path:'notes/native-report.mdx'};
 const endedAt=new Date(Date.parse(compiled.endsAt)+2_000).toISOString();
 const run={id:workdayId,teamId,status:'completed',executionMode:'simulation',startedAt:startsAt,completedAt:endedAt,reportRefs:{},
  parameters:{...compiled.policySnapshot,deadlineAt:compiled.endsAt,appliedPlan:{...compiled,state:'ended',closingAt:compiled.endsAt,endedAt,reportRef:reference}}};
 const baseline=structuredClone(run),requests:Array<{method:string;url:string;body:string}>=[],failed:Array<{mode:string;failure:string;observation:unknown}>=[];
 let mode='exact';
 const server=createServer((request,response)=>{
  let body='';request.setEncoding('utf8');request.on('data',bytes=>body+=String(bytes));request.on('end',()=>{
   requests.push({method:request.method??'',url:request.url??'',body});
   if(mode==='interrupted'){request.socket.destroy();return;}response.setHeader('content-type','application/json');
   if(mode==='403'){response.writeHead(403).end(JSON.stringify({status:403,code:'controlled_report_denied',title:'Retained report read denial'}));return;}
   if(mode==='json'){response.end('{');return;}
   const visible:Record<string,unknown>=structuredClone(run),parameters=visible.parameters as Record<string,unknown>,plan=parameters.appliedPlan as Record<string,unknown>;
   if(mode==='top-level')visible.reportRef=reference;if(mode==='plural')visible.reportRefs={native:reference};
   if(mode==='foreign-team')plan.teamId='foreign';if(mode==='foreign-run')plan.id='foreign';
   if(mode==='mode')plan.executionMode='production';if(mode==='unended')plan.state='closing';
   if(mode==='clock')visible.completedAt=new Date(Date.parse(endedAt)+1).toISOString();
   response.end(JSON.stringify({data:{run:visible}}));
  });
 });
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('Native allocated read server required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:`http://127.0.0.1:${address.port}`}),accessToken:'controlled-report-read-input'});
  const read=async()=>{
   const input={path:{teamId,runId:workdayId},query:{},body:undefined},held=structuredClone(input);
   const result=await client.invoke(controlPlaneOperation('workdays.show'),input);expect(input).toEqual(held);
   const data=result.data as {run:Record<string,unknown>};const original=structuredClone(data);
   const plan=verifyReportWorkdayAuthority(data.run);expect(plan.reportRef).toEqual(reference);expect(data).toEqual(original);return data;
  };
  expect(await read()).toEqual({run});
  for(mode of ['top-level','plural','foreign-team','foreign-run','mode','unended','clock','403','json','interrupted']){
   let observation:unknown,failure:unknown;
   try{observation=await read();}catch(error){failure=error;}
   expect(failure,mode).toBeDefined();failed.push({mode,failure:String(failure),observation});expect(run).toEqual(baseline);
  }
  const held=structuredClone(failed);mode='exact';for(const result of await Promise.all([read(),read()]))expect(result).toEqual({run});
  expect(failed).toEqual(held);expect(run).toEqual(baseline);
  for(const request of requests)expect(request).toEqual({method:'GET',url:`/v1/teams/${teamId}/workday-runs/${workdayId}`,body:''});
  // Controlled HTTP records prove public transport and verifier semantics, not real governance, native PostgreSQL completeness or managed reporting.
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 expect(server.listening).toBe(false);
},30_000);
