import { describe,expect,it } from 'vitest';
import { findAgentToolDefinition } from '@treeseed/sdk/agent-tools';
import { callAgentTool } from '../../../../src/agents/tools/agent-tool-runtime.ts';
import type { ExecutionProviderToolDescriptor } from '../../../../src/agents/runtime/runtime-types.ts';

function descriptor(id:string,overrides:Partial<ExecutionProviderToolDescriptor>={}):ExecutionProviderToolDescriptor{
	const definition=findAgentToolDefinition(id)!;
	return { kind:'agent_tool',id,name:definition.title,description:definition.description,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,executionTarget:definition.executionTarget,mutability:definition.mutability,metadata:{ projectId:'project-a',contentRoot:'src/content' },...overrides };
}
function proxy():ExecutionProviderToolDescriptor{return { ...descriptor('treedx.read_workspace_file'),handleId:'handle-a',repositoryId:'repo-a',workspaceId:'workspace-a',allowedOperations:['files:read','files:write','git:commit'],allowedPaths:['src/content/**'],allowedReadPaths:['src/content/**'],allowedWritePaths:['src/content/**'],routes:{ buildContext:'POST /context',readRepositoryFiles:'POST /files/read',searchWorkspace:'POST /search',readWorkspaceFile:'GET /files?path=:path',applyWorkspaceChangeset:'POST /changesets',commitWorkspace:'POST /commit' },metadata:{ projectId:'project-a',contentRoot:'src/content',baseCommitSha:'abc123',baseRef:'refs/heads/main' } } as ExecutionProviderToolDescriptor;}
function status(stateVersion=3,phase='working') { return { ok:true,payload:{ id:'assignment-a',teamId:'team-a',projectId:'project-a',workdayId:'workday-a',stateVersion,status:'leased',leaseState:'leased',assignedAt:'2026-08-13T10:00:00.000Z',updatedAt:'2026-08-13T10:01:00.000Z',capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:phase==='closeout'?'2026-08-13T10:03:00.000Z':'2099-08-13T10:00:00.000Z',closeoutWarningSeconds:180 } } },metadata:{} } }; }
function runtime(fetchImpl:typeof fetch,descriptors:ExecutionProviderToolDescriptor[]){ return { apiBaseUrl:'https://api.example.test',providerAccessToken:'provider-token',assignmentId:'assignment-a',leaseToken:'lease-a',descriptors,fetchImpl }; }

describe('assignment operational safety',()=>{
	it('starts the full productive window only after initial plan read-back',async()=>{
		const calls:string[]=[]; let created=false; let executionBody:Record<string,unknown>={};
		const plan='---\ntitle: assignment plan for assignment-a\nid: assignment-a\nstatus: ready\nrevision: 1\nobjective: Do bounded work.\ncompleted: []\nremaining: []\nrisks: []\nteamId: team-a\nprojectId: project-a\nworkdayId: workday-a\nassignmentId: assignment-a\ncreatedAt: 2026-08-13T10:00:00.000Z\nupdatedAt: 2026-08-13T10:00:00.000Z\n---\n';
		const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{
			const url=String(input); calls.push(url);
			if(url.endsWith('/execution-start')) { executionBody=JSON.parse(String(init?.body)); return Response.json({ok:true,payload:{ id:'assignment-a',stateVersion:4,metadata:{ operationalState:'executing' } }}); }
			if(url.includes('/files?path=')) return created?Response.json({ok:true,payload:{content:plan}}):new Response('missing',{status:404});
			if(url.includes('/changesets')) { created=true; return Response.json({ok:true,payload:{changedPaths:['src/content/assignment-plans/assignment-a.mdx']}}); }
			return Response.json({ok:true,payload:{...status(3,'preparation').payload,capacityEnvelope:{reservedSeconds:600,budget:{time:{requestedSeconds:600,executionSeconds:600,preparationSeconds:180,closeoutSeconds:120,preparationDeadlineAt:'2099-08-13T10:03:00.000Z',executionStartedAt:null,executionDeadlineAt:null,closeoutDeadlineAt:'2099-08-13T10:05:00.000Z'}}}}});
		};
		const restrictedProxy={ ...proxy(),metadata:{ ...proxy().metadata,permissionSummary:{ readActions:['read'],readModels:['objective'],writeActions:['create'],writeModels:['note'],commitAllowed:true } } };
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.assignment_plan'),restrictedProxy]),'treeseed.assignment_plan',{ action:'write',expectedStateVersion:3,idempotencyKey:'initial-plan-a',objective:'Do bounded work.',status:'ready',completed:[],remaining:[],risks:[] });
		expect(result).toMatchObject({ok:true,assignmentStateVersion:4,executionTransition:{id:'assignment-a',stateVersion:4}});
		expect(calls.at(-1)).toContain('/execution-start');
		expect(executionBody).toMatchObject({leaseToken:'lease-a',expectedStateVersion:3,idempotencyKey:'initial-plan-a:execution-start',planRef:{id:'assignment-a',path:'src/content/assignment-plans/assignment-a.mdx',revision:1}});
	});

	it('starts protected closeout before writing the terminal summary',async()=>{
		const calls:string[]=[]; let created=false; let fileReads=0;
		const plan='---\ntitle: assignment plan for assignment-a\nid: assignment-a\nstatus: active\nrevision: 1\nobjective: Do bounded work.\ncompleted: []\nremaining: []\nrisks: []\nteamId: team-a\nprojectId: project-a\nworkdayId: workday-a\nassignmentId: assignment-a\ncreatedAt: 2026-08-13T10:00:00.000Z\nupdatedAt: 2026-08-13T10:00:00.000Z\n---\n';
		const summary='---\ntitle: assignment summary for assignment-a\nid: assignment-a\nstatus: completed\nsummary: Finished bounded work.\nartifactRefs: []\nverificationRefs: []\nlessons: []\nblockers: []\nperformance:\n  outcome: completed\nteamId: team-a\nprojectId: project-a\nworkdayId: workday-a\nassignmentId: assignment-a\ncreatedAt: 2026-08-13T10:00:00.000Z\nupdatedAt: 2026-08-13T10:00:00.000Z\n---\n';
		const fetchImpl=async(input:RequestInfo|URL)=>{
			const url=String(input); calls.push(url);
			if(url.endsWith('/closeout-start')) return Response.json({ok:true,payload:{id:'assignment-a',stateVersion:4,workDayId:'workday-a',metadata:{operationalState:'closeout'}}});
			if(url.includes('/files?path=')) { fileReads+=1; return fileReads===1?Response.json({ok:true,payload:{content:plan}}):created?Response.json({ok:true,payload:{content:summary}}):new Response('missing',{status:404}); }
			if(url.includes('/changesets')) { created=true; return Response.json({ok:true,payload:{changedPaths:['src/content/assignment-summaries/assignment-a.mdx']}}); }
			return Response.json(status(3));
		};
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.assignment_summary'),descriptor('treeseed.assignment_plan'),proxy()]),'treeseed.assignment_summary',{action:'write',expectedStateVersion:3,idempotencyKey:'summary-a',status:'completed',summary:'Finished bounded work.',artifactRefs:[],verificationRefs:[],lessons:[],blockers:[],performance:{outcome:'completed'}});
		expect(result).toMatchObject({ok:true,assignmentStateVersion:4,closeoutTransition:{id:'assignment-a',stateVersion:4}});
		expect(calls.findIndex((url)=>url.endsWith('/closeout-start'))).toBeLessThan(calls.findIndex((url)=>url.includes('/changesets')));
	});

	it('requires the initial TreeDX plan before any other mutation',async()=>{
		const fetchImpl=async(input:RequestInfo|URL)=>String(input).includes('/v1/provider/assignments/')&&!String(input).includes('/files')?Response.json(status()):new Response('missing',{ status:404 });
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.publish_signal'),descriptor('treeseed.assignment_plan'),proxy()]),'treeseed.publish_signal',{ contractId:'handoff',subjectKind:'objective',subjectId:'objective-a',message:'Durable handoff evidence.' });
		expect(result).toMatchObject({ ok:false,code:'assignment_initial_plan_required' });
	});

	it('rejects stale operational writes before TreeDX mutation',async()=>{
		const fetchImpl=async()=>Response.json(status(3));
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.assignment_status_update'),descriptor('treeseed.assignment_plan'),proxy()]),'treeseed.assignment_status_update',{ expectedStateVersion:2,sequence:0,phase:'implementation',status:'running',idempotencyKey:'status-update-a' });
		expect(result).toMatchObject({ ok:false,code:'assignment_status_stale',metadata:{ stateVersion:3 } });
	});

	it('requires exact append-only lineage after the initial status entry',async()=>{
		const result=await callAgentTool(runtime((async()=>{ throw new Error('no side effects expected'); }) as typeof fetch,[descriptor('treeseed.assignment_status_update')]),'treeseed.assignment_status_update',{ expectedStateVersion:3,sequence:1,phase:'implementation',status:'running',idempotencyKey:'status-update-b' });
		expect(result).toMatchObject({ ok:false,code:'invalid_tool_input' });
	});

	it('blocks exploration once authoritative closeout begins',async()=>{
		const now=Date.now();
		const fetchImpl=async()=>Response.json({ ...status(),payload:{ ...status().payload,capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:new Date(now+60_000).toISOString(),closeoutWarningSeconds:180 } } } } });
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.repository.search')]),'treeseed.repository.search',{ query:'new scope' });
		expect(result).toMatchObject({ ok:false,code:'assignment_closeout_tool_restricted',metadata:{ phase:'closeout' } });
	});

	it('keeps bounded discussion reads and follows available during protected closeout',async()=>{
		const now=Date.now();
		const fetchImpl=async(input:RequestInfo|URL)=>{
			if(String(input).includes('/discussions?')) return Response.json({ok:true,payload:{discussionId:'discussion-a',messages:[],events:[],cursor:'cursor-a'}});
			return Response.json({ ...status(),payload:{ ...status().payload,capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:new Date(now+60_000).toISOString(),closeoutWarningSeconds:180 } } } } });
		};
		for(const toolId of ['treeseed.discussion.read','treeseed.discussion.follow']){
			const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor(toolId)]),toolId,{discussionId:'discussion-a',limit:20});
			expect(result).toMatchObject({ok:true,payload:{discussionId:'discussion-a',cursor:'cursor-a'}});
		}
	});

	it('rejects every mutation after protected closeout expires',async()=>{
		const fetchImpl=async()=>Response.json({ ...status(),payload:{ ...status().payload,capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:new Date(Date.now()-1_000).toISOString(),closeoutWarningSeconds:180 } } } } });
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.assignment_status_update')]),'treeseed.assignment_status_update',{expectedStateVersion:3,sequence:0,phase:'closeout',status:'failed',idempotencyKey:'expired-status-a'});
		expect(result).toMatchObject({ok:false,code:'assignment_closeout_deadline_exhausted'});
	});

	it('allows a required signal publication during closeout after the initial plan exists',async()=>{
		const now=Date.now();
		const fetchImpl=async(input:RequestInfo|URL)=>{
			if(String(input).includes('/files?path=')) return Response.json({ ok:true,result:{ content:'---\nschemaVersion: treeseed.assignment-plan/v1\n---\n' } });
			return Response.json({ ...status(),payload:{ ...status().payload,capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:new Date(now+60_000).toISOString(),closeoutWarningSeconds:180 } } } } });
		};
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.publish_signal'),descriptor('treeseed.assignment_plan'),proxy()]),'treeseed.publish_signal',{ contractId:'evidence-ready',subjectKind:'objective',subjectId:'core',message:'Committed evidence dossier is ready for downstream review.' });
		expect(result).toMatchObject({ ok:true,payload:{ contractId:'evidence-ready',requested:true } });
	});

	it('allows the operational plan to be checkpointed during closeout',async()=>{
		const now=Date.now();
		const existingPlan='---\ntitle: assignment plan for assignment-a\nid: assignment-a\nstatus: active\nrevision: 1\nobjective: Finish safely.\ncompleted: []\nremaining: []\nrisks: []\nteamId: team-a\nprojectId: project-a\nworkdayId: workday-a\nassignmentId: assignment-a\ncreatedAt: 2026-08-13T10:00:00.000Z\nupdatedAt: 2026-08-13T10:00:00.000Z\n---\n';
		const fetchImpl=async(input:RequestInfo|URL)=>{
			if(String(input).includes('/files?path=')) return Response.json({ ok:true,payload:{ content:existingPlan } });
			if(String(input).includes('/changesets')) return Response.json({ ok:true,payload:{ changedPaths:['src/content/assignment-plans/assignment-a.mdx'] } });
			return Response.json({ ...status(),payload:{ ...status().payload,capacityEnvelope:{ budget:{ time:{ hardDeadlineAt:new Date(now+60_000).toISOString(),closeoutWarningSeconds:180 } } } } });
		};
		const result=await callAgentTool(runtime(fetchImpl as typeof fetch,[descriptor('treeseed.assignment_plan'),proxy()]),'treeseed.assignment_plan',{
			action:'write',expectedStateVersion:3,idempotencyKey:'closeout-plan-a',objective:'Finish safely.',status:'completed',
			completed:[{ id:'work',title:'Work',description:'The bounded work is complete.' }],remaining:[],risks:[],
		});
		expect(result).toMatchObject({ ok:true });
	});
});
