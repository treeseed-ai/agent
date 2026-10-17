import {createHash} from 'node:crypto';
import {allocateWorkdayCapacity,compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {liveAssignmentRecord} from './monitoring/live-assignment-fixture.ts';
import {campaignCliFixture} from './lifecycle/campaign-cli-fixture.ts';
import {campaignPlanReviewRequired} from '../../acceptance/campaign.ts';
import { describe, expect, it, vi } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';


const {state,workdayId,observed,event,transport}=campaignCliFixture();
describe('campaign CLI composition units (mocked transport, not native or live acceptance)', () => {
 it('passes the original captured campaign namespace into every new assignment inspection despite contradictory public metadata',async()=>{
  const item=liveAssignmentRecord(),attempt=item.assignmentAttempt as Record<string,unknown>;attempt.workdayId=workdayId;attempt.teamId='team-fixture';
  const plan=compileWorkday({id:workdayId,teamId:'team-fixture',executionMode:'simulation',policyId:'default',policyRevision:1,agentIds:[],startsAt:new Date(Date.parse(String(attempt.createdAt))-21*60_000).toISOString(),policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3}});plan.state='active';
  const seconds=Number((attempt.limits as Record<string,unknown>).maximumSeconds);(item.explanation as {metadata:{allocation:{opportunity:unknown}}}).metadata.allocation.opportunity=allocateWorkdayCapacity({remainingSeconds:seconds,now:String(attempt.createdAt),workdays:[{plan,committedSeconds:0,planningCommittedSeconds:0,maximumAdditionalSeconds:seconds,actingReady:true}]})[plan.id];
  const returned=observed('completed');returned.run.startedAt=plan.startsAt;Object.assign(returned.run.parameters,{...plan.policySnapshot,appliedPlan:plan,acceptanceCampaignId:'foreign-public-campaign'});
  state.campaign={campaignId:'frozen-operator-campaign'};state.freeze.receipts['/operator-campaign.json']='sha256:'+createHash('sha256').update(JSON.stringify(state.campaign)).digest('hex');state.freeze.sourceHeads={sdk:'a'.repeat(40)};
  const held=structuredClone(state.freeze);state.inspect.mockImplementation((_run,_items,_retained,inspect)=>inspect(item));transport(()=>returned);await state.run!();
  expect(state.profileInspect).toHaveBeenCalledExactlyOnceWith(item,'treeseed',[],{'treeseed-ai/sdk':'a'.repeat(40)},'frozen-operator-campaign');expect(state.freeze).toEqual(held);expect(returned.run.parameters).toMatchObject({acceptanceCampaignId:'foreign-public-campaign'});
 });

 it('stops the exact live simulation on missing original protected sandbox history before assignment inspection or later gates',async()=>{
  vi.useFakeTimers();let polls=0;transport(()=>observed(++polls===1?'running':'completed'));const original=new Error('ACCEPTANCE_SANDBOX_HISTORY: Original lifecycle missing'),held=structuredClone(state.freeze);state.sandboxTransitions.mockImplementation(()=>{throw original;});const pending=state.run!().catch((classified:Error&{classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;});await vi.runAllTimersAsync();await expect(pending).resolves.toBe(original);expect(state.sandboxTransitions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:workdayId}),[],[],state.freeze.guest.digest);expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
 });

 it('requires original frozen provider history before metered admission and retains a denied baseline without starting or stopping unrelated work',async()=>{
  transport(()=>observed('completed'));const original=new Error('ACCEPTANCE_PROVIDER_HISTORY: Missing baseline publication'),held=structuredClone(state.freeze);state.providerTransitions.mockImplementation(()=>{throw original;});
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_PROVIDER_HISTORY');expect(state.providerRead).toHaveBeenCalledExactlyOnceWith('treeseed',['configured-provider'],expect.any(Number));expect(state.providerTransitions).toHaveBeenCalledOnce();expect(state.freeze).toEqual(held);expect(state.read.mock.calls.filter(call=>call[0][1]==='start'||call[0][1]==='stop')).toEqual([]);expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();
 });
 it('stops the exact admitted simulation on incomplete original provider history before assignment inspection collaboration approval and later gates',async()=>{
  vi.useFakeTimers();let polls=0;transport(()=>observed(++polls===1?'running':'completed'));const original=new Error('ACCEPTANCE_PROVIDER_HISTORY: Missing intermediate health transition'),held=structuredClone(state.freeze);state.providerTransitions.mockImplementationOnce(()=>{}).mockImplementation(()=>{throw original;});
  const pending=state.run!().catch((classified:Error&{classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;});await vi.runAllTimersAsync();await expect(pending).resolves.toBe(original);expect(state.providerRead).toHaveBeenCalledTimes(2);expect(state.providerTransitions).toHaveBeenCalledTimes(2);expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
 });

 it('stops the exact admitted simulation on an incomplete original Workday lifecycle chain before accounting collaboration or later gates',async()=>{
  transport(()=>observed('running'));const original=new Error('ACCEPTANCE_WORKDAY_TRANSITIONS: Original closing observation missing'),held=structuredClone(state.freeze);
  state.lifecycleTransitions.mockImplementation(()=>{throw original;});
  await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);
  expect(state.lifecycleTransitions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:workdayId}),[]);expect(state.accountingTransitions).not.toHaveBeenCalled();expect(state.nodeTransitions).not.toHaveBeenCalled();expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);
  expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
 });

 it('rereads concurrent accounting changes within the original inspection bound before validating stable public usage ledger and history',async()=>{
  transport(()=>observed('completed'));let reads=0;
  state.evidence.mockImplementation((args:string[])=>args[0]==='capacity'&&args[1]==='usage'?[{id:++reads===1?'first-in-flight':'stable-current'}]:[]);
  await state.run!();expect(reads).toBe(4);expect(state.accountingTransitions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:workdayId}),[],[{id:'stable-current'}],[],[]);
  expect(state.nodeTransitions).toHaveBeenCalledOnce();expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([]);
 });
 it('stops continuously mutating accounting inventory without validating a stale snapshot or advancing beyond the original forty-round inspection bound',async()=>{
  transport(()=>observed('running'));let reads=0;
  state.evidence.mockImplementation((args:string[])=>args[0]==='capacity'&&args[1]==='usage'?[{id:'changing-'+(++reads)}]:[]);
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_LIVE_ASSIGNMENT: Complete concurrent transition inventory not reached');expect(reads).toBe(80);
  expect(state.accountingTransitions).not.toHaveBeenCalled();expect(state.nodeTransitions).not.toHaveBeenCalled();expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();
  expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toHaveLength(1);
 });
 it('stops the exact admitted simulation on incomplete public accounting history before later gates while retaining the failed owning inventory',async()=>{
  transport(()=>observed('running'));state.nodeTransitions.mockImplementation(()=>{throw new Error('Later node boundary must not run after accounting denial');});
  const failed=[{id:'retained-unmatched-usage',assignmentId:'omitted-original-attempt',workDayId:workdayId,projectId:'8cbfb810-6da5-4da2-9ae9-cad53101253f'}],held=structuredClone(failed);
  state.evidence.mockImplementation((args:string[])=>args[0]==='capacity'&&args[1]==='usage'?failed:[]);
  state.accountingTransitions.mockImplementation((_run,_assignments,usage)=>{expect(usage).toEqual(held);throw new Error('ACCEPTANCE_ACCOUNTING_TRANSITIONS: Complete original owning history required');});
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_ACCOUNTING_TRANSITIONS');
  expect(state.accountingTransitions).toHaveBeenCalledOnce();expect(state.nodeTransitions).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.inspect).not.toHaveBeenCalled();
  expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toHaveLength(1);expect(failed).toEqual(held);
 });
 it('rereads concurrent graph changes within the original inspection bound before certifying the final node inventory',async()=>{
  transport(()=>observed('completed'));const implementation=state.read.getMockImplementation()!;let graphReads=0;
  state.read.mockImplementation((args:string[],...rest:unknown[])=>args[0]==='execution'&&args[1]==='graph'&&state.retain.mock.calls.length>0?{teamId:'team-fixture',revision:++graphReads===1?1:2,nodes:[]}:Reflect.apply(implementation,undefined,[args,...rest]));
  await state.run!();expect(graphReads).toBe(4);expect(state.nodeTransitions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:workdayId}),{teamId:'team-fixture',revision:2,nodes:[]},[]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([]);
 });
 it('stops continuously mutating public graph inventory without advancing beyond the original forty-round inspection bound',async()=>{
  transport(()=>observed('running'));const implementation=state.read.getMockImplementation()!;let graphReads=0;
  state.read.mockImplementation((args:string[],...rest:unknown[])=>args[0]==='execution'&&args[1]==='graph'&&state.retain.mock.calls.length>0?{teamId:'team-fixture',revision:++graphReads,nodes:[]}:Reflect.apply(implementation,undefined,[args,...rest]));
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_LIVE_ASSIGNMENT: Complete concurrent transition inventory not reached');expect(graphReads).toBe(80);expect(state.nodeTransitions).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toHaveLength(1);
 });

 it('denies missing owning node transitions before collaboration approval and later gates with the original scoped stop',async()=>{
  transport(()=>observed('running'));const original=new Error('ACCEPTANCE_NODE_TRANSITIONS: Missing ready transition'),held=structuredClone(state.freeze);
  state.nodeTransitions.mockImplementation(()=>{throw original;});
  await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);
  expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
 });

 it('stops continuously changing concurrent assignment observations within the original inspection bound before campaign progress',async()=>{
  transport(()=>observed('running'));const implementation=state.read.getMockImplementation()!;let sequence=0;
  state.evidence.mockImplementation((args:string[])=>args[0]==='assignments'?[]:[{...event(sequence++),assignmentId:'late-'+sequence,eventType:'assignment.leased'}]);
  state.read.mockImplementation((args:string[],...rest:unknown[])=>args[0]==='assignments'&&args[1]==='show'?{id:args[2]}:Reflect.apply(implementation,undefined,[args,...rest]));
  state.inspect.mockImplementation(()=>{throw new Error('Continuously changing history advanced to another stage');});
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_LIVE_ASSIGNMENT: Complete concurrent transition inventory not reached');expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();
  expect(state.evidence.mock.calls.filter(call=>call[0][0]==='workdays')).toHaveLength(40);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toHaveLength(1);
 });

 it('revalidates assignments discovered in later public events before collaboration or approval instead of waiting for another poll',async()=>{
  transport(()=>observed('running'));const implementation=state.read.getMockImplementation()!,late={id:'late-original-assignment'},original=new Error('ACCEPTANCE_ASSIGNMENT_TRANSITIONS: Missing concurrent original creation');
  state.evidence.mockImplementation((args:string[])=>args[0]==='assignments'?[]:[{...event(),assignmentId:late.id,eventType:'assignment.leased'}]);
  state.read.mockImplementation((args:string[],...rest:unknown[])=>args[0]==='assignments'&&args[1]==='show'?structuredClone(late):Reflect.apply(implementation,undefined,[args,...rest]));
  state.transitions.mockImplementation((_run:unknown,records:Array<{id:string}>)=>{if(records.some(record=>record.id===late.id))throw original;});
  state.inspect.mockImplementation(()=>{throw new Error('Concurrent assignment advanced without checking its original transition history');});
  await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();
  expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
 });

 it('denies omitted owning assignment transitions before collaboration approval or later gates and retains the exact scoped stop',async()=>{
  transport(()=>observed('running'));const original=new Error('ACCEPTANCE_ASSIGNMENT_TRANSITIONS: Missing original claim'),held=structuredClone(state.freeze);
  state.transitions.mockImplementation(()=>{throw original;});await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);
  expect(state.eventHistory).toHaveBeenCalledOnce();expect(state.eventHistory.mock.calls[0]![3]).toBeTypeOf('function');expect(state.transitions).toHaveBeenCalledOnce();expect(state.inspect).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();
  expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);expect(state.freeze).toEqual(held);
 });

 it('retains the original late plan-review report and stops the exact admitted simulation without approval or later gates',async()=>{
  transport(()=>observed('running'));state.freeze.proposal.digest='sha256:'+'a'.repeat(64);const details={project:'sdk',proposal:state.freeze.proposal.id+' '+state.freeze.proposal.digest,workday:workdayId,'failed expectation':'Original plan requires review.','observed evidence':'Retained original observation.','why implementation repair is insufficient':'The original plan requires reviewed correction.','smallest proposed plan correction':'Request review; no change applied.'};
  const original=campaignPlanReviewRequired(details,Object.assign(new Error('Original transport cause'),{code:'ECONNREFUSED'})),held=structuredClone(state.freeze),stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
  state.inspect.mockImplementation(()=>{throw original;});try{await expect(state.run!()).rejects.toBe(original);expect(state.retainReview).toHaveBeenCalledExactlyOnceWith(original.message,'/freeze',state.freeze);expect(stderr).toHaveBeenCalledExactlyOnceWith(original.message);
   expect(state.read.mock.calls.filter(call=>call[0][1]==='stop')).toEqual([[['workdays','stop',workdayId,'--yes','--reason','Automated golden boundary failed','--idempotency-key','golden-stop:'+workdayId],'treeseed']]);
   expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate')).toEqual([]);expect(state.verify).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);
  }finally{stderr.mockRestore();}
 });

 it('denies missing changed denied or interrupted external inventories before admission and retains the original frozen input before exact retry', async () => {
  const failures: Error[]=[];
  for(const boundary of ['missing','changed','denied','interrupted']) {
   state.read.mockReset();state.verify.mockReset();state.inspect.mockReset();state.retain.mockClear();state.external.mockReset();transport(()=>observed());
   const failure=new Error('Original external inventory '+boundary);failures.push(failure);const held=structuredClone(state.freeze);
   state.external.mockImplementation(()=>{throw failure;});await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(failure);
   expect(state.external).toHaveBeenCalledExactlyOnceWith(state.freeze);expect(state.read).not.toHaveBeenCalled();expect(state.retain).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.inspect).not.toHaveBeenCalled();expect(state.freeze).toEqual(held);
  }
  const retained=[...failures];state.external.mockReset();state.read.mockReset();transport(()=>observed());await state.run!();
  expect(state.external).toHaveBeenCalledTimes(2);expect(state.external.mock.invocationCallOrder[0]).toBeLessThan(state.read.mock.invocationCallOrder[0]!);expect(state.external.mock.invocationCallOrder[1]).toBeGreaterThan(state.verify.mock.invocationCallOrder.at(-1)!);expect(failures).toEqual(retained);
 });

	it('reports an unsafe frozen request before admission and classifies contradictory runtime as an implementation defect without unsafe mutation', async () => {
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			state.freeze.proposal.digest = 'sha256:' + 'a'.repeat(64);
			state.freeze.request.body.executionMode = 'production';
			for (const reportFails of [false, true]) {
				state.read.mockReset(); state.verify.mockReset(); state.inspect.mockReset(); state.retainReview.mockClear(); stderr.mockClear();
				const held = structuredClone(state.freeze), reportFailure = new Error('Original report destination interrupted');
				stderr.mockImplementation(() => { if (reportFails) throw reportFailure; }); transport(() => observed());
				const failure = await state.run!().then(() => undefined, (error: unknown) => error);
				expect(stderr).toHaveBeenCalledOnce(); const report = stderr.mock.calls[0]![0] as string;
				expect(state.retainReview).toHaveBeenCalledExactlyOnceWith(report, '/freeze', state.freeze);
				expect(report.split('\n')).toEqual(['PLAN_REVIEW_REQUIRED', 'project: sdk', 'proposal: fresh ' + state.freeze.proposal.digest,
					'workday: not-started', 'failed expectation: Agent execution acceptance / Non-negotiable rules / ACCEPTANCE_CAMPAIGN_MODE',
					'observed evidence: /freeze: request.body.executionMode="production"',
					'why implementation repair is insufficient: Frozen operator intent lacks permitted simulation authority; an implementation repair cannot supply or change operator intent.',
					'smallest proposed plan correction: Propose executionMode: simulation for this frozen request; apply only after plan review.']);
				if (reportFails) { expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors[1]).toBe(reportFailure);
					expect((failure as AggregateError).errors[0]).toBeInstanceOf(Error); }
				else expect(failure).toMatchObject({ classification: 'PLAN_REVIEW_REQUIRED', message: report, cause: expect.any(Error) });
				expect(state.read).not.toHaveBeenCalled(); expect(state.verify).not.toHaveBeenCalled(); expect(state.inspect).not.toHaveBeenCalled(); expect(state.freeze).toEqual(held);
			}
			state.freeze.request.body.executionMode = 'simulation'; stderr.mockClear(); stderr.mockImplementation(() => {});
			for (const status of ['running', 'completed']) {
				state.read.mockReset(); state.retainReview.mockClear();
				const shown = observed(status); shown.run.executionMode = 'production'; shown.scheduling.executionMode = 'production'; const held = structuredClone({ shown, freeze: state.freeze }); transport(() => shown);
				await expect(state.run!()).rejects.toMatchObject({ classification: 'IMPLEMENTATION_DEFECT', cause: expect.any(Error) });
				expect(stderr).not.toHaveBeenCalled(); expect(state.retainReview).not.toHaveBeenCalled(); expect(state.verify).not.toHaveBeenCalled();
				expect(state.read.mock.calls.filter(call => call[0][1] === 'stop' || call[0][1] === 'evaluate')).toEqual([]); expect({ shown, freeze: state.freeze }).toEqual(held);
			}
		} finally { stderr.mockRestore(); }
	});
	it('denies a completed workday at each required final evidence gate without later gates or another admission and retains the original failure before exact retry', async () => {
		const gates = ['collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter'];
		for (const [index, gate] of gates.entries()) {
			transport(() => observed()); state.verify.mockReset();
			const original = new Error(`Original missing ${gate} evidence`), held = structuredClone(state.freeze);
			state.verify.mockImplementation((value: string) => { if (value === gate) throw original; });
			await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);
			expect(state.verify.mock.calls.map(call => call[0])).toEqual(gates.slice(0, index + 1));
			expect(state.read.mock.calls.filter(call => call[0][1] === 'start')).toHaveLength(1);
			expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toEqual([]);
			expect(state.freeze).toEqual(held);
			state.read.mockReset(); transport(() => observed()); state.verify.mockReset();
			await state.run!(); expect(state.verify.mock.calls.map(call => call[0])).toEqual(gates);
			expect(state.freeze).toEqual(held); state.read.mockReset();
		}
	});
	it('stops the exact admitted simulation on receipt capture denial before discussion approval or later verification', async () => {
		transport(() => observed('running')); const original = new Error('controlled-receipt-capture-denial');
		state.retain.mockImplementation(() => { throw original; });
		await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);
		expect(state.retain).toHaveBeenCalledExactlyOnceWith({ workdayId }, '/freeze', state.freeze);
		expect(state.read.mock.calls.filter(call => call[0][0] === 'send' || call[0][1] === 'evaluate')).toEqual([]);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop').map(call => call[0][2])).toEqual([workdayId]);
		expect(state.verify).not.toHaveBeenCalled(); expect(state.inspect).not.toHaveBeenCalled();
	});
	it('stops the exact admitted simulation on every addressed probe send failure before approval or later progress', async () => {
		for (let denied = 0; denied < 9; denied++) {
			state.read.mockReset(); state.verify.mockReset(); transport(() => observed('running'));
			const original = state.read.getMockImplementation()!;
			const failure = new Error(`controlled-send-${denied}`); let sends = 0;
			state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
				if (args[0] === 'send' && sends++ === denied) throw failure;
				return original(args);
			});
			await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(failure);
			expect(sends).toBe(denied + 1); expect(state.verify).not.toHaveBeenCalled();
			expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(0);
			expect(state.read.mock.calls.filter(call => call[0][1] === 'stop').map(call => call[0][2])).toEqual([workdayId]);
		}
	});
	it('denies live assignment inspection before collaboration approval and verification while stopping only the exact admitted simulation', async () => {
		const original = new Error('ACCEPTANCE_LIVE_ASSIGNMENT: Controlled immutable authority failure');
		state.graphInspect.mockImplementation((teamId: string) => { expect(teamId).toBe('team-fixture'); });
		state.inspect.mockImplementation(() => { throw original; }); transport(() => observed('running'));
		await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(original);
		expect(state.inspect).toHaveBeenCalledOnce(); expect(state.verify).not.toHaveBeenCalled();
		expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(0);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop').map(call => call[0][2])).toEqual([workdayId]);
		state.inspect.mockReset(); state.read.mockReset(); transport(() => observed('running'));
		const missing = new Error('ACCEPTANCE_LIVE_GRAPH: Original graph inventory missing'); state.graphInspect.mockRejectedValue(missing);
		await expect(state.run!().catch((classified:Error & {classification?:string})=>{expect(classified.classification).toBe('IMPLEMENTATION_DEFECT');return classified.cause;})).resolves.toBe(missing); expect(state.inspect).not.toHaveBeenCalled();
		expect(state.verify).not.toHaveBeenCalled(); expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(0);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop').map(call => call[0][2])).toEqual([workdayId]);
	});
	it('consumes every original public event page before terminal campaign verification and retains exact immutable event history', async () => {
		vi.useFakeTimers(); let polls = 0;
		const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
		const cursor = encodeCapacityPageCursor(events[49]!);
		const first = { events: events.slice(0, 50), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
		const tail = { items: events.slice(50), page: { limit: 50, hasMore: false, nextCursor: null } };
		const held = structuredClone({ first, tail });
		state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
			if (args[0] === 'workdays' && args[1] === 'show') return { ...observed(++polls === 1 ? 'running' : 'completed'), ...first };
			if (args.slice(0, 3).join(' ') === 'workdays events list') {
				expect(args).toEqual(['workdays', 'events', 'list', workdayId, '--limit', '50', '--cursor', cursor]); return tail;
			}
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
			if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
			return {};
		});
		const result = expect(state.run!()).resolves.toBeUndefined(); await vi.runAllTimersAsync(); await result;
		expect(state.read.mock.calls.filter(call => call[0].slice(0, 3).join(' ') === 'workdays events list')).toHaveLength(2);
		expect(state.verify.mock.calls.map(call => call[0])).toEqual(['collaboration', 'collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter']);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(0);
		expect({ first, tail }).toEqual(held);
	});
	it('denies missing malformed repeated foreign or failed later event pages and stops the exact simulation before further work', async () => {
		const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
		const cursor = encodeCapacityPageCursor(events[49]!);
		for (const mode of ['absent', 'items', 'limit', 'has-more', 'terminal-cursor', 'empty-more', 'wrong-cursor',
			'duplicate-id', 'duplicate-index', 'missing-index', 'foreign-run', 'foreign-team', 'clock', 'refs', 'failed', 'error',
			'403', '503', 'reset', 'json']) {
			state.read.mockReset(); state.verify.mockReset();
			const first = { ...observed(), events: structuredClone(events.slice(0, 50)), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
			const items = structuredClone(events.slice(50)), page: Record<string, unknown> = { limit: 50, hasMore: false, nextCursor: null };
			const tail: Record<string, unknown> = { items, page };
			if (mode === 'items') tail.items = {};
			if (mode === 'limit') page.limit = '50';
			if (mode === 'has-more') page.hasMore = 'false';
			if (mode === 'terminal-cursor') page.nextCursor = cursor;
			if (mode === 'empty-more') { tail.items = []; page.hasMore = true; page.nextCursor = cursor; }
			if (mode === 'wrong-cursor') { page.hasMore = true; page.nextCursor = encodeCapacityPageCursor(events[0]!); }
			if (mode === 'duplicate-id') items[0]!.id = events[0]!.id;
			if (mode === 'duplicate-index') items[0]!.eventIndex = 0;
			if (mode === 'missing-index') items.shift();
			if (mode === 'foreign-run') items[0]!.runId = 'foreign';
			if (mode === 'foreign-team') items[0]!.teamId = 'foreign';
			if (mode === 'clock') items[0]!.createdAt = 'malformed';
			if (mode === 'refs') Object.assign(items[0]!, { refs: null });
			if (mode === 'failed' || mode === 'error') items[0]!.status = mode;
			const held = structuredClone({ first, tail }); let laterReads = 0;
			state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
				if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
				if (args[0] === 'workdays' && args[1] === 'show') return first;
				if (args.slice(0, 3).join(' ') === 'workdays events list') {
					laterReads++; if (['403', '503', 'reset', 'json'].includes(mode)) throw new Error(`ACCEPTANCE_CLI_COMMAND: controlled_${mode}`);
					return mode === 'absent' ? undefined : tail;
				}
				return {};
			});
			await expect.soft(state.run!(), mode).rejects.toThrow(/ACCEPTANCE_OBSERVATION|ACCEPTANCE_CLI_COMMAND/u);
			expect.soft(laterReads, mode).toBe(1); expect.soft(state.verify, mode).not.toHaveBeenCalled();
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop'), mode).toHaveLength(1);
			expect.soft({ first, tail }, mode).toEqual(held);
		}
	});
	it('denies changed or disappearing retained later-page events without repairing earlier complete history', async () => {
		vi.useFakeTimers();
		for (const mode of ['changed', 'disappeared']) {
			state.read.mockReset(); state.verify.mockReset(); let polls = 0;
			const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
			const cursor = encodeCapacityPageCursor(events[49]!), changed = structuredClone(events.slice(50));
			if (mode === 'changed') Object.assign(changed[0]!.refs, { changed: true }); else changed.splice(0);
			const held = structuredClone({ events, changed });
			state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
				if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
				if (args[0] === 'workdays' && args[1] === 'show') return { ...observed(++polls === 1 ? 'running' : 'completed'),
					events: events.slice(0, 50), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
				if (args.slice(0, 3).join(' ') === 'workdays events list') return { items: polls === 1 ? events.slice(50) : changed,
					page: { limit: 50, hasMore: false, nextCursor: null } };
				if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
				if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
				return {};
			});
			const failure = expect.soft(state.run!(), mode).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			await vi.runAllTimersAsync(); await failure;
			expect.soft(state.verify.mock.calls.map(call => call[0]), mode).toEqual(['collaboration']);
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop'), mode).toHaveLength(1);
			expect.soft({ events, changed }, mode).toEqual(held);
		}
	});
	it('continuously observes collaboration while issuing external approval only once for the exact workday', async () => {
		vi.useFakeTimers();
		let polls = 0, version = 8;
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		const start = new Date(Date.now() - 21 * 60_000).toISOString(), endsAt = new Date(Date.now() + 39 * 60_000).toISOString();
		state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId: id };
			if (args[0] === 'workdays' && args[1] === 'show') return { run: { id, status: ++polls < 3 ? 'running' : 'completed',
				executionMode: 'simulation', startedAt: start, parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt } } },
				scheduling: { executionId: id, status: polls < 3 ? 'running' : 'completed', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: version };
			if (args[0] === 'proposals' && args[1] === 'evaluate') { version++; return { status: 'accepted', decisionId: 'decision-1' }; }
			return {};
		});
		const finished = expect(state.run!()).resolves.toBeUndefined();
		await vi.runAllTimersAsync(); await finished;
		expect(state.verify.mock.calls.filter(call => call[0] === 'collaboration')).toHaveLength(3);
		const approvals = state.read.mock.calls.filter(call => call[0][0] === 'proposals' && call[0][1] === 'evaluate');
		expect(approvals).toHaveLength(1);
		expect(approvals[0]![0]).toEqual(expect.arrayContaining(['--if-match', '8', '--idempotency-key', `golden-approval:${id}`]));
		expect(state.read.mock.calls.filter(call => call[0][0] === 'proposals' && call[0][1] === 'show')).toHaveLength(1);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(0);
	});
	it('uses the canonical workdayId receipt and every existing terminal gate', async () => {
		// A cached admission remains replayable after the preflight expires.
		state.freeze.preflight.expiresAt = '2000-01-01T00:00:00Z';
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		state.read.mockImplementation((args: string[]) => args[0]==='execution'&&args[1]==='graph'?{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]}:args[1] === 'start' ? { workdayId: id }
			: args[0] === 'send' ? { receiptId: 'send' }
				: args[0] === 'proposals' && args[1] === 'show' ? { activeVersion: 8 }
					: args[0] === 'proposals' && args[1] === 'evaluate' ? { status: 'accepted', decisionId: 'decision-1' }
						: { run: { id, status: 'completed', executionMode: 'simulation', startedAt: new Date().toISOString(),
				parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt: new Date().toISOString() } } },
				scheduling: { executionId: id, status: 'completed', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } });
		await state.run!();
		const admissions=state.read.mock.calls.filter(call=>call[0][0]==='workdays'&&call[0][1]==='start');expect(admissions).toHaveLength(1);expect(admissions[0]![0]).toContain('exact');
		expect(state.read.mock.calls[0]![0]).toEqual(['execution','graph','show']);
		const send = state.read.mock.calls.find(call => call[0][0] === 'send');
		expect(send?.[3]).toBe(240_000);
		expect(send?.[0]).toContain('--no-wait');
		expect(send?.[0]).toContain(`golden-discussion:${id}`);
		const sends = state.read.mock.calls.filter(call => call[0][0] === 'send');
		expect(sends).toHaveLength(9);
		const roles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
		for (const [index, role] of roles.entries()) {
			const args = sends[index + 1]![0] as string[];
			expect(args[2]).toMatch(new RegExp(`^@sdk/${role} `));
			expect(args[2].match(/@sdk\/[a-z-]+/gu)).toEqual([`@sdk/${role}`]);
			expect(args).toEqual(expect.arrayContaining(['--proposal', 'fresh', '--workday', id,
				'--no-wait', '--idempotency-key', `golden-chat:${id}:${role}`]));
			expect(sends[index + 1]![3]).toBe(240_000);
		}

		expect(state.verify.mock.calls.map(call => call[0])).toEqual(['collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter']);
		expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe(id);
	});
	it('delegates stale admission to the API and rejects infeasible input or malformed receipts before chat', async () => {
		state.freeze.preflight.expiresAt = '2000-01-01T00:00:00Z';
		state.read.mockImplementation((args:string[]) => {if(args[0]==='execution')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};throw new Error('API_PREFLIGHT_EXPIRED');});
		await expect(state.run!()).rejects.toThrow('API_PREFLIGHT_EXPIRED');
		expect(state.read).toHaveBeenCalledTimes(2);expect(state.read.mock.calls.filter(call=>call[0][0]==='workdays'&&call[0][1]==='start')).toHaveLength(1);
		state.read.mockReset();
		state.freeze.preflight.expiresAt = new Date(Date.now() + 600000).toISOString();
		state.freeze.request.body.durationSeconds = 7200;
		await expect(state.run!()).rejects.toThrow('3600'); expect(state.read).not.toHaveBeenCalled();
		state.freeze.request.body.durationSeconds = 3600; state.read.mockImplementation((args:string[])=>args[0]==='execution'?{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]}:{id:'invented-shape'});
		await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_ID'); expect(state.read).toHaveBeenCalledTimes(2);expect(state.read.mock.calls.filter(call=>call[0][0]==='workdays'&&call[0][1]==='start')).toHaveLength(1);
	});
	it('reads proposal governance with project and server, never a team option', async () => {
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		state.read.mockImplementation((args: string[]) => {
			if(args[0]==='execution'&&args[1]==='graph')return{teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId: id };
			if (args[0] === 'workdays' && args[1] === 'show') return { run: { id, status: 'running', executionMode: 'simulation',
				startedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
				parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt: new Date(Date.now() + 60_000).toISOString() } } },
				scheduling: { executionId: id, status: 'running', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
			if (args[0] === 'proposals' && args[1] === 'evaluate') throw new Error('GOVERNANCE_APPROVAL_REACHED');
			return {};
		});
		await expect(state.run!()).rejects.toThrow('GOVERNANCE_APPROVAL_REACHED');
		expect(state.read).toHaveBeenCalledWith(
			['proposals', 'show', 'fresh', '--server', 'local', '--project', '8cbfb810-6da5-4da2-9ae9-cad53101253f'],
			'treeseed', true);
		expect(state.read).toHaveBeenCalledWith(
			expect.arrayContaining(['proposals', 'evaluate', 'fresh', '--if-match', '8', '--input']),
			'treeseed', true);
	});
	it('denies missing unavailable or malformed scheduling instead of inferring observed empty work', async () => {
		for (const scheduling of [undefined, null, {}, { status: 'unavailable' }, { assignments: [], nodes: null },
			{ assignments: {}, nodes: [] }, { ...observed().scheduling, assignments: [null] }]) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling }));
			await expect.soft(state.run!(), JSON.stringify(scheduling)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(1);
		}
	});
	it('denies changed scheduling identity mode status and malformed or duplicated count rows', async () => {
		for (const change of [{ executionId: 'other' }, { executionMode: 'production' }, { status: 'running' },
			...[-1, 0.5, '1', NaN, Infinity].map(count => ({ assignments: [{ status: 'failed', count }] })),
			{ assignments: [{ status: '', count: 1 }] }, { nodes: [{ status: 'ready', count: 1 }] },
			{ assignments: [{ status: 'completed', count: 1 }, { status: 'completed', count: 1 }] }]) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling: { ...observed().scheduling, ...change } }));
			await expect.soft(state.run!(), JSON.stringify(change)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies missing malformed and incomplete event pagination before terminal golden verification', async () => {
		for (const change of [{ events: undefined }, { events: {} }, { eventPage: undefined },
			{ eventPage: { limit: 50, hasMore: 'false', nextCursor: null } },
			{ eventPage: { limit: 0, hasMore: false, nextCursor: null } },
			{ eventPage: { limit: 50, hasMore: false, nextCursor: 'unconsumed' } },
			{ eventPage: { limit: 50, hasMore: true, nextCursor: 'unconsumed' } }]) {
			state.read.mockReset(); state.verify.mockReset(); transport(() => ({ ...observed(), ...change }));
			await expect.soft(state.run!(), JSON.stringify(change)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies malformed foreign duplicate and missing-index event authority without mutating observations', async () => {
		for (const events of [[null], [event(), event()], [event(), { ...event(1), id: 'event-0' }],
			[event(1)], [event(), event(2)], [{ ...event(), runId: 'other' }], [{ ...event(), teamId: 'other' }],
			[{ ...event(), eventIndex: '0' }], [{ ...event(), createdAt: 'not-a-clock' }],
			[{ ...event(), refs: null }], [{ ...event(), eventType: '' }]]) {
			state.read.mockReset(); state.verify.mockReset(); const input = { ...observed(), events }, before = structuredClone(input);
			transport(() => input);
			await expect.soft(state.run!(), JSON.stringify(events)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(input).toEqual(before); expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('stops on historical failed event evidence even when current scheduling contains no failures', async () => {
		for (const status of ['failed', 'error']) {
			state.read.mockReset(); state.verify.mockReset(); transport(() => ({ ...observed(), events: [{ ...event(), status }] }));
			await expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies failed returned or expired scheduling counts even on a completed workday', async () => {
		for (const status of ['failed', 'returned', 'expired']) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling: { ...observed().scheduling, assignments: [{ status, count: 1 }] } }));
			await expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies mutated or disappearing previously observed event records on later terminal readback', async () => {
		vi.useFakeTimers();
		for (const events of [[], [{ ...event(), refs: { changed: true } }]]) {
			state.read.mockReset(); state.verify.mockReset(); let polls = 0;
			transport(() => ({ ...observed(++polls === 1 ? 'running' : 'completed'), events: polls === 1 ? [event()] : events }));
			const result = expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			await vi.runAllTimersAsync(); await result;
			expect.soft(state.verify.mock.calls.filter(call => call[0] === 'lifecycle')).toHaveLength(0);
		}
	});
	it('accepts observed empty pre-admission counts and immutable complete event replays without repeated approval', async () => {
		vi.useFakeTimers(); let polls = 0;
		const inputs: unknown[] = [];
		transport(() => { const input = { ...observed(++polls === 1 ? 'running' : 'completed'), events: [event()] }; inputs.push(structuredClone(input)); return input; });
		const result = expect(state.run!()).resolves.toBeUndefined(); await vi.runAllTimersAsync(); await result;
		expect(inputs).toHaveLength(2);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(1);
		expect(state.verify.mock.calls.filter(call => call[0] === 'collaboration')).toHaveLength(2);
	});
	it('stops when a later scheduling readback becomes unavailable after complete collaboration', async () => {
		vi.useFakeTimers(); let polls = 0;
		transport(() => ++polls === 1 ? observed('running') : { ...observed('completed'), scheduling: { status: 'unavailable' } });
		const result = expect(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION'); await vi.runAllTimersAsync(); await result;
		expect(state.verify.mock.calls.filter(call => call[0] === 'lifecycle')).toHaveLength(0);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(1);
	});
});
