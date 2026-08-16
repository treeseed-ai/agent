import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAgentTool } from '../../../../src/agents/tools/agent-tool-runtime.ts';
import { callAgentToolWithTelemetry,deriveToolEvents } from '../../../../src/agents/tools/agent-tool-telemetry.ts';
import { treeDxContentReceipts } from '../../../../src/agents/adapters/codex/execution-codex-receipts.ts';
import { createAssignmentToolCatalog } from '../../../../src/provider/commerce/catalog/assignment-tool-catalog.ts';

const plan = `---
id: assignment-1
title: assignment plan for assignment-1
status: active
teamId: team-1
projectId: project-1
workdayId: workday-1
assignmentId: assignment-1
createdAt: 2026-08-15T00:00:00.000Z
updatedAt: 2026-08-15T00:00:00.000Z
revision: 1
objective: Answer the exact discussion message.
completed: []
remaining: []
risks: []
---
`;

const summary = `---
id: assignment-1
title: assignment summary for assignment-1
status: suspended
teamId: team-1
projectId: project-1
workdayId: workday-1
assignmentId: assignment-1
createdAt: 2026-08-15T00:00:00.000Z
updatedAt: 2026-08-15T00:00:00.000Z
summary: Waiting for a required human response.
lessons: []
blockers:
  - Waiting for a required discussion response.
performance:
  outcome: suspended
  metrics: {}
resumeState:
  checkpoint: pending-required-response-checkpoint
  nextAction: Resume after the governed response.
  contextRefs: []
artifactRefs: []
verificationRefs: []
---
`;

function status(stateVersion: number, phase: 'execution' | 'closeout') {
	return { ok: true, payload: {
		id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', workDayId: 'workday-1',
		stateVersion, status: 'leased', leaseState: 'leased', assignedAt: '2026-08-15T00:00:00.000Z',
		capacityEnvelope: { reservedSeconds: 900, budget: { time: { hardDeadlineAt: '2099-01-01T00:00:00.000Z' } } },
		decisionInput: { input: { activityType: 'chat' } },
		metadata: { workdayRunId: 'conversation-1', operationalState: phase === 'closeout' ? 'closeout' : 'executing' },
	} };
}

function telemetryPath(entries:Record<string,unknown>[]){
	const path=join(mkdtempSync(join(tmpdir(),'chat-response-')),'telemetry.jsonl');
	writeFileSync(path,entries.map((entry)=>JSON.stringify(entry)).join('\n')+'\n','utf8');
	return path;
}

function completedOperational(toolId:string,inputSummary:Record<string,unknown>){
	return {status:'completed',toolId,inputSummary};
}

describe('required-response communication closeout', () => {
	it('blocks a Chat workspace commit until terminal status and summary telemetry exist',async()=>{
		const catalog=createAssignmentToolCatalog({agentTools:['treeseed.content.commit'],projectId:'project-1',assignmentId:'assignment-1',workspaceMode:'workspace_write',contentRoot:'src/content',treedxProxyHandle:{id:'handle-1',teamId:'team-1',projectId:'project-1',assignmentId:'assignment-1',repositoryId:'repo-1',workspaceId:'workspace-1',status:'active',allowedOperations:['files:read','files:write','git:commit'],allowedPaths:['src/content/**'],allowedWritePaths:['src/content/**']},permissionProjection:{read:{models:['discussion_message'],actions:['read']},write:{models:['discussion_message'],actions:['create']},commit:{allowed:true}}});
		const fetchImpl=vi.fn();
		const result=await callAgentToolWithTelemetry({apiBaseUrl:'https://api.example.test',providerAccessToken:'provider-token',assignmentId:'assignment-1',descriptors:catalog.descriptors,fetchImpl,telemetryPath:join(mkdtempSync(join(tmpdir(),'chat-closeout-')),'telemetry.jsonl')},'treeseed.content.commit',{message:'Premature Chat checkpoint'});
		expect(result).toMatchObject({ok:false,code:'content_completion_required_before_commit',metadata:{missingReceipts:['assignment_terminal_status','assignment_summary']}});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('commits TreeDX operational state and sends the fresh assignment version before suspension', async () => {
		let stateVersion = 2;
		let responseBody: Record<string, unknown> = {};
		const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/closeout-start')) {
				stateVersion = 3;
				return new Response(JSON.stringify({ ok: true, payload: status(3, 'closeout').payload }));
			}
			if (url.endsWith('/discussions/responses')) {
				responseBody = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ ok: true, payload: {
					message: { id: 'message-agent', path: 'src/content/discussion-messages/discussion-1/message-agent.mdx' },
					changeset: { resultCommitSha: 'response-commit' }, suspended: true,
				} }), { status: 201 });
			}
			if (/\/v1\/provider\/assignments\/assignment-1$/u.test(url)) {
				return new Response(JSON.stringify(status(stateVersion, stateVersion === 3 ? 'closeout' : 'execution')));
			}
			if (url.includes('/files?path=')) {
				const content = decodeURIComponent(url).includes('/assignment-summaries/') ? summary : plan;
				return new Response(JSON.stringify({ ok: true, payload: { content } }));
			}
			if (url.endsWith('/changesets')) return new Response(JSON.stringify({ ok: true, payload: { status: 'applied', refs: [] } }));
			if (url.endsWith('/commit')) return new Response(JSON.stringify({ ok: true, payload: {
				status: 'committed', commitSha: 'operational-commit', branchName: 'refs/heads/assignment-1',
			} }));
			return new Response(JSON.stringify({ ok: true, payload: {} }));
		}) as unknown as typeof fetch;

		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.commit'], projectId: 'project-1', assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write', contentRoot: 'src/content',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', status: 'active',
				baseCommitSha: 'base-commit', baseRef: 'refs/heads/staging',
				allowedOperations: ['files:read', 'files:write', 'workspace:write', 'git:commit'],
				allowedPaths: ['src/content/**'], allowedReadPaths: ['src/content/**'], allowedWritePaths: ['src/content/**'],
			},
			permissionProjection: {
				read: { models: ['discussion_message'], actions: ['read'] },
				write: { models: ['discussion_message'], actions: ['create'] },
				commit: { allowed: true },
			},
		});
		const result = await callAgentTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-token',
			assignmentId: 'assignment-1', leaseToken: 'lease-1', descriptors: catalog.descriptors, fetchImpl,
			telemetryPath:telemetryPath([
				completedOperational('treeseed.discussion.read',{}),
				completedOperational('treeseed.discussion.follow',{}),
			]),
		}, 'treeseed.discussion.respond', {
			discussionId: 'discussion-1', replyTo: 'message-human', sourceMessageRefs: ['message-human'],
			message: 'Which exact Guide page should I review?', recipients: ['human-1'], requiredResponse: true,
			expectedStateVersion: 2, idempotencyKey: 'required-response-1',
		});

		expect(result, JSON.stringify(result)).toMatchObject({ ok: true, suspended: true });
		expect(responseBody).toMatchObject({
			expectedStateVersion: 3,
			checkpoint: { kind: 'treedx-content', commitSha: 'operational-commit', branchRef: 'refs/heads/assignment-1' },
		});
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
		const events=deriveToolEvents('treeseed.discussion.respond',catalog.descriptors.find((entry)=>entry.id==='treeseed.discussion.respond')!,{
			replyTo:'message-human',requiredResponse:true,
		},result);
		const receipts=treeDxContentReceipts([{ status:'completed',toolId:'treeseed.discussion.respond',derivedEvents:events }]);
		expect(receipts).toEqual(expect.arrayContaining([
			expect.objectContaining({ metadata:expect.objectContaining({ contentRef:expect.objectContaining({ model:'assignment_summary',commitSha:'operational-commit' }) }) }),
			expect.objectContaining({ metadata:expect.objectContaining({ contentRef:expect.objectContaining({ model:'discussion_message',commitSha:'response-commit' }) }) }),
		]));
	});

	it('checkpoints terminal operational evidence before retrying a normal final response',async()=>{
		let responseAttempts=0;let commitCalls=0;
		const fetchImpl=vi.fn(async(request:string|URL|Request)=>{
			const url=String(request);
			if(/\/v1\/provider\/assignments\/assignment-1$/u.test(url))return new Response(JSON.stringify(status(4,'closeout')));
			if(url.includes('/files?path='))return new Response(JSON.stringify({ok:true,payload:{content:url.includes('/assignment-summaries/')?summary:plan}}));
			if(url.endsWith('/commit')){commitCalls+=1;return new Response(JSON.stringify({ok:true,payload:{status:'committed',commitSha:'terminal-checkpoint',branchName:'refs/heads/assignment-1'}}));}
			if(url.endsWith('/discussions/responses')){
				responseAttempts+=1;
				if(responseAttempts===1)return new Response(JSON.stringify({ok:false,code:'assignment_discussion_checkpoint_required',error:'Commit operational evidence first.'}),{status:409});
				return new Response(JSON.stringify({ok:true,payload:{message:{id:'message-final',path:'src/content/discussion-messages/discussion-1/message-final.mdx'},commitSha:'response-commit',changeset:{resultCommitSha:'response-commit'}}}),{status:201});
			}
			return new Response(JSON.stringify({ok:true,payload:{}}));
		}) as unknown as typeof fetch;
		const catalog=createAssignmentToolCatalog({agentTools:['treeseed.content.commit'],projectId:'project-1',assignmentId:'assignment-1',workspaceMode:'workspace_write',contentRoot:'src/content',treedxProxyHandle:{id:'handle-1',teamId:'team-1',projectId:'project-1',assignmentId:'assignment-1',repositoryId:'repo-1',workspaceId:'workspace-1',status:'active',baseCommitSha:'base-commit',baseRef:'refs/heads/staging',allowedOperations:['files:read','files:write','workspace:write','git:commit'],allowedPaths:['src/content/**'],allowedReadPaths:['src/content/**'],allowedWritePaths:['src/content/**']},permissionProjection:{read:{models:['discussion_message'],actions:['read']},write:{models:['discussion_message'],actions:['create']},commit:{allowed:true}}});
		const closeoutTelemetry=telemetryPath([
			completedOperational('treeseed.discussion.read',{}),
			completedOperational('treeseed.discussion.follow',{}),
			completedOperational('treeseed.assignment_status_update',{status:'completed'}),
			completedOperational('treeseed.assignment_summary',{action:'write',status:'completed'}),
		]);
		const result=await callAgentTool({apiBaseUrl:'https://api.example.test',providerAccessToken:'provider-token',assignmentId:'assignment-1',leaseToken:'lease-1',descriptors:catalog.descriptors,fetchImpl,telemetryPath:closeoutTelemetry},'treeseed.discussion.respond',{discussionId:'discussion-1',replyTo:'message-human',sourceMessageRefs:['message-human'],message:'Final evidence-backed response.',recipients:['human-1'],requiredResponse:false,expectedStateVersion:4,idempotencyKey:'final-response-1'});
		expect(result).toMatchObject({ok:true,finalResponseCheckpoint:{commitSha:'terminal-checkpoint',branchRef:'refs/heads/assignment-1'}});
		expect(responseAttempts).toBe(2);expect(commitCalls).toBe(1);
		const events=deriveToolEvents('treeseed.discussion.respond',catalog.descriptors.find((entry)=>entry.id==='treeseed.discussion.respond')!,{replyTo:'message-human'},result);
		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({type:'content_committed',commitSha:'terminal-checkpoint'}),expect.objectContaining({type:'content_created',contentRef:expect.objectContaining({model:'discussion_message',commitSha:'response-commit'})})]));
	});

	it('refuses a final response before terminal status telemetry exists',async()=>{
		const fetchImpl=vi.fn(async(request:string|URL|Request)=>{
			const url=String(request);
			if(/\/v1\/provider\/assignments\/assignment-1$/u.test(url))return new Response(JSON.stringify(status(4,'closeout')));
			if(url.includes('/files?path='))return new Response(JSON.stringify({ok:true,payload:{content:summary}}));
			return new Response(JSON.stringify({ok:true,payload:{}}));
		}) as unknown as typeof fetch;
		const catalog=createAssignmentToolCatalog({agentTools:['treeseed.content.commit'],projectId:'project-1',assignmentId:'assignment-1',workspaceMode:'workspace_write',contentRoot:'src/content',treedxProxyHandle:{id:'handle-1',teamId:'team-1',projectId:'project-1',assignmentId:'assignment-1',repositoryId:'repo-1',workspaceId:'workspace-1',status:'active',allowedOperations:['files:read','files:write','workspace:write','git:commit'],allowedPaths:['src/content/**'],allowedReadPaths:['src/content/**'],allowedWritePaths:['src/content/**']},permissionProjection:{read:{models:['discussion_message'],actions:['read']},write:{models:['discussion_message'],actions:['create']},commit:{allowed:true}}});
		const closeoutTelemetry=telemetryPath([
			completedOperational('treeseed.discussion.read',{}),
			completedOperational('treeseed.discussion.follow',{}),
			completedOperational('treeseed.assignment_status_update',{status:'working'}),
			completedOperational('treeseed.assignment_summary',{action:'write',status:'completed'}),
		]);
		const result=await callAgentTool({apiBaseUrl:'https://api.example.test',providerAccessToken:'provider-token',assignmentId:'assignment-1',leaseToken:'lease-1',descriptors:catalog.descriptors,fetchImpl,telemetryPath:closeoutTelemetry},'treeseed.discussion.respond',{discussionId:'discussion-1',replyTo:'message-human',sourceMessageRefs:['message-human'],message:'Premature final response.',recipients:['human-1'],requiredResponse:false,expectedStateVersion:4,idempotencyKey:'final-response-premature'});
		expect(result).toMatchObject({ok:false,code:'assignment_final_closeout_required',metadata:{missingReceipts:['assignment_terminal_status']}});
		expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/discussions/responses'))).toBe(false);
		expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/commit'))).toBe(false);
	});

	it('refuses a response until both bounded Discussion reads are complete',async()=>{
		const fetchImpl=vi.fn(async(request:string|URL|Request)=>{
			if(/\/v1\/provider\/assignments\/assignment-1$/u.test(String(request)))return new Response(JSON.stringify(status(2,'execution')));
			return new Response(JSON.stringify({ok:true,payload:{}}));
		}) as unknown as typeof fetch;
		const catalog=createAssignmentToolCatalog({agentTools:['treeseed.content.commit'],projectId:'project-1',assignmentId:'assignment-1',workspaceMode:'workspace_write',contentRoot:'src/content',treedxProxyHandle:{id:'handle-1',teamId:'team-1',projectId:'project-1',assignmentId:'assignment-1',repositoryId:'repo-1',workspaceId:'workspace-1',status:'active',allowedOperations:['files:read','files:write','workspace:write','git:commit'],allowedPaths:['src/content/**'],allowedReadPaths:['src/content/**'],allowedWritePaths:['src/content/**']},permissionProjection:{read:{models:['discussion_message'],actions:['read']},write:{models:['discussion_message'],actions:['create']},commit:{allowed:true}}});
		const result=await callAgentTool({apiBaseUrl:'https://api.example.test',providerAccessToken:'provider-token',assignmentId:'assignment-1',leaseToken:'lease-1',descriptors:catalog.descriptors,fetchImpl,telemetryPath:telemetryPath([completedOperational('treeseed.discussion.read',{})])},'treeseed.discussion.respond',{discussionId:'discussion-1',replyTo:'message-human',sourceMessageRefs:['message-human'],message:'Response without follow.',recipients:['human-1'],requiredResponse:true,expectedStateVersion:2,idempotencyKey:'missing-follow'});
		expect(result).toMatchObject({ok:false,code:'assignment_discussion_context_required',metadata:{missingReceipts:['discussion_follow']}});
		expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/discussions/responses'))).toBe(false);
		expect(fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/commit'))).toBe(false);
	});
});
