import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { portableKernel } from '../../kernel/architecture/portable/portable-kernel-fixture.ts';
import { monitorCampaign } from '../../../acceptance/campaign.ts';
import { verifyMeasuredVerification } from '../../../acceptance/workday/support/assignment-authority.ts';
import { observeCampaign, verifyAssignmentTransitionHistory } from '../../../acceptance/workday/support/campaign-observation.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { liveAssignmentRecord } from './live-assignment-fixture.ts';

it('native Kernel Git and public SDK completed observations still fail original campaign verification on missing or malformed evidence before unchanged retry', async () => {
	const f = await portableKernel(); let server: ReturnType<typeof createServer> | undefined;
	try {
		const candidate = await f.candidate(), produced = await f.run(); expect(produced.status).toBe('completed');
		const original = assignmentResultSchema.parse(produced.outputs?.assignmentResult);
		const start = process.hrtime.bigint(), output = execFileSync('git', ['cat-file', '-t', candidate], { cwd: f.checkout, timeout: 30_000 });
		const durationSeconds = Math.ceil(Number(process.hrtime.bigint() - start) / 1e9);
		expect(output.toString('utf8')).toBe('commit\n');
		// This independent native command has measured bytes/time. Upstream HTTP
		// records are controlled, not authenticated admission or model usage proof.
		const result = assignmentResultSchema.parse({ ...original, verification: [...original.verification, {
			command: `git cat-file -t ${candidate}`, status: 'passed', exitCode: 0, durationSeconds,
			outputDigest: `sha256:${createHash('sha256').update(output).digest('hex')}` }] });
		const item: Row = { ...liveAssignmentRecord(f.attempt), status: 'completed', assignmentResult: result };
		const run = { id: f.attempt.workdayId, teamId: f.attempt.teamId, status: 'completed', executionMode: 'simulation' };
		const observation = { run, scheduling: { executionId: run.id, status: run.status, executionMode: run.executionMode,
			assignments: [{ status: 'completed', count: 1 }], nodes: [{ kind: 'acting', status: 'completed', count: 1 }] }, events: [],
			eventPage: { limit: 50, hasMore: false, nextCursor: null } };
		let presented = structuredClone(item); const requests: string[] = [], failures: Row[] = [];
		server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
			const path = request.url?.split('?')[0];
			if (request.method !== 'GET') { response.writeHead(500).end('{}'); return; }
			if (path === `/v1/teams/${run.teamId}/workday-runs/${run.id}`) response.end(JSON.stringify({ data: observation }));
			else if (path === `/v1/teams/${run.teamId}/capacity/assignments/${f.attempt.id}`) response.end(JSON.stringify({ data: presented }));
			else response.writeHead(500).end('{}');
		});
		await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Original native address required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-terminal-read' });
		const execute = async () => {
			const observed = row((await client.invoke(controlPlaneOperation('workdays.show'), { path: { teamId: run.teamId, runId: run.id }, query: {}, body: undefined })).data);
			const assignment = row((await client.invoke(controlPlaneOperation('assignments.show'), { path: { teamId: run.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined })).data);
			const held = structuredClone({ observed, assignment }), snapshot = observeCampaign(observed, run.id, new Map(), () => { throw new Error('Unexpected page'); });
			let later = false, stopped = false;
			try {
				await monitorCampaign({ admittedSimulation: true, read: () => ({ status: String(snapshot.run.status), mode: String(snapshot.run.executionMode), planningEndsAt: 0, endsAt: 1 }),
					now: () => 1, wait: async () => { throw new Error('Terminal work cannot wait or admit again'); }, collaboration: () => {},
					verify: () => { verifyMeasuredVerification(row(assignment.assignmentResult)); later = true; }, stop: () => { stopped = true; } });
			} finally { expect({ observed, assignment }).toEqual(held); expect(stopped).toBe(false); }
			return later;
		};
		expect(await execute()).toBe(true);
		for (const mode of ['result', 'verification', 'duration', 'digest', 'exit']) {
			presented = structuredClone(item); const proof = row(presented.assignmentResult), measured = (proof.verification as Row[]).at(-1)!;
			if (mode === 'result') delete presented.assignmentResult;
			if (mode === 'verification') delete proof.verification;
			if (mode === 'duration') delete measured.durationSeconds;
			if (mode === 'digest') measured.outputDigest = 'invalid';
			if (mode === 'exit') measured.exitCode = 'zero';
			const retained = structuredClone(presented);
			await expect(execute(), mode).rejects.toThrow('ACCEPTANCE_VERIFICATION_RECORD');
			failures.push(retained); expect(presented).toEqual(retained);
		}
		const retainedFailures = structuredClone(failures); presented = structuredClone(item);
		expect(await execute()).toBe(true); expect(failures).toEqual(retainedFailures);
		expect(requests).toHaveLength(14); expect(requests.every(value => value.startsWith('GET '))).toBe(true);
		expect(f.git('cat-file', '-t', candidate)).toBe('commit'); expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(original);
	} finally {
		if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
		await f.close();
	}
});

it('native Kernel candidate and public assignment histories reject omitted owning transitions before scoped stop and unchanged concurrent retry',async()=>{
 const f=await portableKernel();let server:ReturnType<typeof createServer>|undefined;
 try{
  const candidate=await f.candidate(),produced=await f.run();expect(produced.status).toBe('completed');const result=assignmentResultSchema.parse(produced.outputs?.assignmentResult);
  const item:Row={...liveAssignmentRecord(f.attempt),stateVersion:3,status:'completed',leaseState:'released',claimedAt:f.attempt.createdAt,completedAt:result.completedAt,updatedAt:result.completedAt,assignmentResult:result};
  Object.assign(row(item.assignmentAttempt),{status:'completed',finishedAt:result.completedAt});
  const run={id:f.attempt.workdayId,teamId:f.attempt.teamId,status:'running',executionMode:'simulation'},common={nodeId:f.attempt.nodeId,nodeRevision:f.attempt.nodeRevision,graphRevision:f.attempt.graphRevision,leaseId:f.attempt.leaseId,reservationId:f.attempt.reservationId,runnerId:null};
  const event=(id:string,eventType:string,status:string,createdAt:string,eventIndex:number):Row=>({id,runId:run.id,teamId:run.teamId,projectId:f.attempt.projectId,workdayId:run.id,assignmentId:item.id,eventType,eventIndex,status:'recorded',title:eventType,message:null,createdAt,context:{...common,status},parameters:{},metadata:{},refs:{}});
  const original=[event('assignment-created:'+item.id,'assignment.created','created',String(item.createdAt),0),event('assignment-lease:'+item.id+':2','assignment.leased','leased',String(item.claimedAt),1),event('assignment-terminal:'+item.id+':3','assignment.completed','completed',result.completedAt,2)];row(original[2]!.context).resultId=result.id;
  const held=structuredClone({item,original}),requests:Array<{method:string;path:string;body:unknown;key:string}>=[],failures:Row[]=[];let mode='exact';
  const stopRoute=controlPlaneOperation('workdays.stop').descriptor.rest;if(!stopRoute)throw new Error('Existing native stop route required');
  const showPath='/v1/teams/'+run.teamId+'/capacity/assignments/'+item.id,eventsPath='/v1/teams/'+run.teamId+'/workday-runs/'+run.id+'/events',stopPath=stopRoute.path.replace('{teamId}',run.teamId).replace('{runId}',run.id);
  server=createServer((request,response)=>{let body='';request.setEncoding('utf8');request.on('data',part=>{body+=String(part);});request.on('end',()=>{
   const url=new URL(request.url??'','http://127.0.0.1');requests.push({method:request.method??'',path:url.pathname,body:body?JSON.parse(body):null,key:String(request.headers['idempotency-key']??'')});response.setHeader('content-type','application/json');
   if(request.method==='POST'&&url.pathname===stopPath){response.end(JSON.stringify({data:{run:{id:run.id,status:'cancelled'}}}));return;}
   if(request.method==='GET'&&url.pathname===showPath){response.end(JSON.stringify({data:item}));return;}
   if(request.method!=='GET'||url.pathname!==eventsPath||url.searchParams.get('limit')!=='2'){response.writeHead(404).end('{}');return;}
   if(mode==='denied'){response.writeHead(403).end(JSON.stringify({status:403,title:'Retained original event denial',code:'original_history_denied'}));return;}
   if(mode==='malformed'){response.end('{');return;}if(mode==='interrupted'&&url.searchParams.has('cursor')){request.socket.destroy();return;}
   const values=structuredClone(original);if(mode==='missing-created')values.splice(0,1);if(mode==='missing-claim')values.splice(1,1);if(mode==='missing-terminal')values.pop();
   if(mode==='foreign')values[2]!.teamId='foreign';if(mode==='wrong-clock')values[2]!.createdAt=new Date(Date.parse(result.completedAt)+1).toISOString();
   if(mode==='wrong-node')row(values[2]!.context).nodeId='foreign';if(mode==='wrong-result')row(values[2]!.context).resultId='foreign';
   if(mode==='duplicate')values.push(structuredClone(values[2]!));values.forEach((value,eventIndex)=>{value.eventIndex=eventIndex;});
   const tail=url.searchParams.has('cursor'),items=tail?values.slice(2):values.slice(0,2),hasMore=!tail&&values.length>2;
   response.end(JSON.stringify({data:{items,page:{limit:2,hasMore,nextCursor:hasMore?encodeCapacityPageCursor({id:String(values[1]!.id),createdAt:String(values[1]!.createdAt)}):null}}}));
  });});
  await new Promise<void>((accept,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',accept);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native history listener required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-history-token'});
  const execute=async()=>{
   let later=false;const offset=requests.length,retained=new Map<string,Row>();
   try{await monitorCampaign({admittedSimulation:true,read:()=>({status:mode==='exact'?'completed':'running',mode:'simulation',planningEndsAt:0,endsAt:1}),now:()=>1,wait:async()=>{throw new Error('No later waiting permitted');},collaboration:()=>{},verify:()=>{later=true;},inspect:async()=>{
    const assignment=row((await client.invoke(controlPlaneOperation('assignments.show'),{path:{teamId:run.teamId,assignmentId:item.id},query:{},body:undefined})).data);
    const first=row((await client.invoke(controlPlaneOperation('workdays.events.list'),{path:{teamId:run.teamId,runId:run.id},query:{limit:2},body:undefined})).data),page=row(first.page);
    const tail=page.hasMore?row((await client.invoke(controlPlaneOperation('workdays.events.list'),{path:{teamId:run.teamId,runId:run.id},query:{limit:2,cursor:page.nextCursor},body:undefined})).data):undefined;
    const observation={run:{...run,status:mode==='exact'?'completed':'running'},scheduling:{executionId:run.id,executionMode:'simulation',status:mode==='exact'?'completed':'running',assignments:[],nodes:[]},events:first.items,eventPage:page};
    const snapshot=observeCampaign(observation,run.id,retained,()=>{if(!tail)throw new Error('Original public tail required');return tail;});verifyAssignmentTransitionHistory(run,[assignment],snapshot.events);
   },stop:async()=>{await client.invoke(controlPlaneOperation('workdays.stop'),{path:{teamId:run.teamId,runId:run.id},query:{},body:{reason:'Automated golden boundary failed'}},{idempotencyKey:'golden-stop:'+run.id});}});
   }finally{expect({item,original}).toEqual(held);if(mode!=='exact')expect(requests.slice(offset).filter(value=>value.method==='POST')).toEqual([{method:'POST',path:stopPath,body:{reason:'Automated golden boundary failed'},key:'golden-stop:'+run.id}]);}
   return later;
  };
  expect(await Promise.all([execute(),execute()])).toEqual([true,true]);
  for(mode of ['missing-created','missing-claim','missing-terminal','foreign','wrong-clock','wrong-node','wrong-result','duplicate','denied','malformed','interrupted']){
   let failure:unknown;try{await execute();}catch(error){failure=error;}expect(failure,mode).toBeInstanceOf(Error);failures.push({mode,failure:String(failure)});
  }
  const retained=structuredClone(failures);mode='exact';expect(await Promise.all([execute(),execute()])).toEqual([true,true]);expect(failures).toEqual(retained);expect(f.git('rev-parse','HEAD')).toBe(candidate);expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(result);
  console.log(JSON.stringify({nativeAssignmentHistoryDenials:failures}));
  // Real Kernel/Git/result and SDK/HTTP consumption. Upstream claim/history
  // inputs are controlled; API owns separate native transactional producer proof.
 }finally{if(server?.listening){server.closeAllConnections();await new Promise<void>((accept,reject)=>server!.close(error=>error?reject(error):accept()));}await f.close();}
 expect(server?.listening).toBe(false);
},30_000);

