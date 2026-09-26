import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { assertObjectiveContentModel, discussionMessageSourcePaths, readDiscussionSourceMessage, readFocusedTreeDxContext, readIdentityContext } from '../../../src/provider/execution/codex-chat-executor.ts';
import { executeAssignmentTreeDxTool } from '../../../src/provider/execution/microvm-executor.ts';

const coreObjective = { schemaVersion: 'treeseed.objective/v1', id: 'sdk-core', projectId: 'project-1',
	title: 'Core objective', outcome: 'Maintain the SDK contract.', status: 'active' };

describe('Codex governed context', () => {
	it('accepts root and nested TreeDX discussion-message references', () => {
		expect(discussionMessageSourcePaths({ sourceMessageRefs: [
			'discussion-messages/topic/message.mdx',
			'./discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
			'knowledge/topic/message.mdx',
		] })).toEqual([
			'discussion-messages/topic/message.mdx',
			'discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
		]);
	});
	it('loads only files selected by verified context queries and never enumerates the repository', async () => {
		const operations:string[]=[]; const context=await readFocusedTreeDxContext({assignment:{metadata:{contentRoot:'.',contextQueryRefs:[
			{kind:'query',id:'architecture',revision:1,layer:'agent'},{kind:'query',id:'chat',revision:1,layer:'activity'},
		],contextQueryChecks:[
			{definition:{kind:'query',id:'architecture',revision:1},stats:{paths:['knowledge/sdk.mdx']}},
			{definition:{kind:'query',id:'chat',revision:1},stats:{paths:['notes/chat.mdx']}},
		]}},assignmentId:'a',leaseToken:'l',runnerId:'r',treeDx:{projectId:'p',handleId:'handle-1',repositoryId:'repo',workspaceId:'w',baseRef:'commit',invoke:async(operation,input:any)=>{operations.push(operation);return {data:{result:{files:input.body.paths.map((path:string)=>({path,content:`content:${path}`}))}}};}}});
		expect(operations).toEqual(['treedx.repositories.files.read']);
		expect(context.sources.map((source)=>[source.layer,source.path])).toEqual([['agent','knowledge/sdk.mdx'],['activity','notes/chat.mdx']]);
	});

	it('reads attributed query results from their authorized same-team repositories',async()=>{
		const calls:any[]=[];const context=await readFocusedTreeDxContext({assignment:{metadata:{contextQueryRefs:[{kind:'query',id:'team-guidance',revision:1,layer:'agent'}],contextQueryChecks:[
			{definition:{kind:'query',id:'team-guidance',revision:1},stats:{sources:[{projectId:'team-project',source:'team-library',ref:'team-ref',paths:['knowledge/governance.mdx']}]}}
		]}},assignmentId:'a',leaseToken:'l',runnerId:'r',treeDx:{projectId:'sdk-project',handleId:'handle-1',repositoryId:'sdk-repo',workspaceId:'w',baseRef:'sdk-ref',readRepositories:[
			{projectId:'team-project',projectSlug:'team',repositoryId:'team-repo',baseRef:'team-ref',allowedPaths:['**'],allowedModels:['knowledge'],source:'team-library'}],
			invoke:async(_operation:string,input:any)=>{calls.push(input);return {data:{result:{files:input.body.paths.map((path:string)=>({path,content:'# Governance'}))}}};}}});
		expect(calls[0].path).toEqual({projectId:'team-project',repoId:'team-repo'});
		expect(context.sources[0]).toMatchObject({projectId:'team-project',path:'knowledge/governance.mdx',immutableRef:'team-ref'});
	});

	it('requires objective-directory Markdown to satisfy the SDK objective content model', () => {
		expect(() => assertObjectiveContentModel('objectives/core.mdx', { frontmatter: coreObjective })).not.toThrow();
		expect(() => assertObjectiveContentModel('objectives/core.md', { frontmatter: {} })).toThrow(/SDK objective content model/u);
		expect(() => assertObjectiveContentModel('knowledge/core.md', { frontmatter: {} })).not.toThrow();
	});

	it('uses the logical core objective while preserving an exact source path from a frozen snapshot', async () => {
		let requested: string[] = [];
		const context = await readIdentityContext({ assignment: { metadata: { identityManifest: {
			agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1' },
			coreObjective: { path: 'objectives/core', expectedRevision: 'commit-1' },
			projectReadme: { path: 'README.md', expectedRevision: 'commit-1' }, instructionTemplates: [],
		} } }, assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner', treeDx: {
			projectId: 'project-1', handleId: 'handle-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1', invoke: async (_operationId, value: any) => {
				requested = value.body.paths; return { data: { result: { files: [
					{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.md', content: 'objective', frontmatter: coreObjective }, { path: 'README.md', content: 'readme' },
				] } } };
			},
		} }, new Set(['agents/architect.yaml', 'objectives/core.md', 'README.md']));
		expect(requested).toContain('objectives/core.md');
		expect(requested).not.toContain('objectives/core.mdx');
		expect((context.manifest.sources as any[])[1]).toMatchObject({ logicalPath: 'objectives/core', path: 'objectives/core.md' });
	});

	it('reads the committed discussion message at the assignment exact ref', async () => {
		let input: Record<string, unknown> | undefined;
		const content = await readDiscussionSourceMessage({
			assignment: { sourceMessageRefs: ['discussion-messages/topic/message.mdx'] },
			assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner',
			treeDx: { projectId: 'project-1', handleId: 'handle-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1',
				invoke: async (_operationId, value) => { input = value; return {
					data: { result: { files: [{ content: 'Exact message' }] }, receipt: { requestId: 'request-1' } },
				}; } },
		});
		expect(content).toBe('Exact message');
		expect(input).toEqual({ path: { repoId: 'repo-1' }, body: {
			paths: ['discussion-messages/topic/message.mdx'], encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
		} });
	});

	it('binds live TreeDX tools to profile policy, repository, and exact ref', async()=>{
		let operation='';let input:any;const request:any={assignment:{assignmentAttempt:{grant:{tools:['source.read']}}},treeDx:{repositoryId:'repo-1',baseRef:'commit-1',invoke:async(op:string,value:any)=>{operation=op;input=value;return {ok:true};}}};
		await executeAssignmentTreeDxTool(request,'treedx_read_files',{paths:['objectives/core']});
		expect(operation).toBe('treedx.repositories.files.read');expect(input).toMatchObject({path:{repoId:'repo-1'},body:{paths:['objectives/core']}});expect(input.body).not.toHaveProperty('ref');
		const predecessorCommit='9dbd4dd76ad0868ebab15d4ad9657a413c41b967';
		await executeAssignmentTreeDxTool(request,'treedx_read_files',{paths:['knowledge/sdk-architecture/page.md'],ref:predecessorCommit});
		expect(input.body.ref).toBe(predecessorCommit);
		await expect(executeAssignmentTreeDxTool(request,'treedx_read_files',{paths:['objectives/core'],ref:'staging'})).rejects.toThrow(/exact commit/u);
		request.assignment.assignmentAttempt.grant.tools=['discussion'];
		await expect(executeAssignmentTreeDxTool(request,'treedx_search_files',{query:'secret'})).rejects.toThrow(/does not authorize/u);
	});

	it('uses the project that owns the current repository when the assignment workspace is a team library',async()=>{
		let input:any;const request:any={assignment:{assignmentAttempt:{grant:{tools:['source.read']}}},treeDx:{projectId:'sdk-project',repositoryId:'team-repo',baseRef:'commit-1',
			readRepositories:[{projectId:'team-project',projectSlug:'team',repositoryId:'team-repo',baseRef:'commit-1',allowedPaths:['**'],allowedModels:['knowledge'],source:'team-library'}],
			invoke:async(_operation:string,value:any)=>{input=value;return {ok:true};}}};
		await executeAssignmentTreeDxTool(request,'treedx_build_context',{request:{query:'team objective'}});
		expect(input.path).toEqual({projectId:'team-project',repoId:'team-repo'});
	});

	it('resolves an exact predecessor repository ID only through an authorized TreeDX read grant',async()=>{
		let input:any;const request:any={assignment:{assignmentAttempt:{grant:{tools:['source.read']}}},treeDx:{projectId:'sdk-project',repositoryId:'team-repo',baseRef:'commit-1',
			readRepositories:[{projectId:'sdk-project',projectSlug:'sdk',repositoryId:'sdk-repo',baseRef:'commit-2',allowedPaths:['**'],allowedModels:['knowledge'],source:'project-library'}],
			invoke:async(_operation:string,value:any)=>{input=value;return {ok:true};}}};
		const ref='9dbd4dd76ad0868ebab15d4ad9657a413c41b967';
		await executeAssignmentTreeDxTool(request,'treedx_read_files',{project:'sdk-repo',paths:['knowledge/sdk-architecture/page.md'],ref});
		expect(input.path).toEqual({projectId:'sdk-project',repoId:'sdk-repo'});
		expect(input.body.ref).toBe(ref);
		await expect(executeAssignmentTreeDxTool(request,'treedx_read_files',{project:'other-repo',paths:['knowledge/secret.md'],ref})).rejects.toThrow(/no TreeDX read grant/u);
	});

	it('translates the assignment context helper into the canonical TreeDX context contract',async()=>{
		let input:any;const request:any={assignment:{assignmentAttempt:{grant:{tools:['source.read']}}},treeDx:{repositoryId:'repo-1',baseRef:'commit-1',invoke:async(_operation:string,value:any)=>{input=value;return {ok:true};}}};
		await executeAssignmentTreeDxTool(request,'treedx_build_context',{request:{topics:['SDK architecture','dependency boundaries'],paths:['objectives/core'],maxItems:8,maxTokens:2400}});
		expect(input.body).toEqual({query:'SDK architecture dependency boundaries',paths:['objectives/core'],budget:{maxNodes:8,maxTokens:2400},topics:undefined,maxItems:undefined,maxTokens:undefined});
	});

	it('fails closed when TreeDX omits a file selected by a verified initial query',async()=>{
		const request:any={assignment:{metadata:{contextQueryRefs:[{kind:'query',id:'architecture',revision:1,layer:'agent'}],contextQueryChecks:[{definition:{kind:'query',id:'architecture',revision:1},stats:{paths:['knowledge/required.mdx']}}]}},assignmentId:'a',leaseToken:'l',runnerId:'r',treeDx:{projectId:'p',repositoryId:'repo',workspaceId:'w',baseRef:'commit',invoke:async()=>({data:{result:{files:[]}}})}};
		await expect(readFocusedTreeDxContext(request)).rejects.toThrow(/omitted required verified context-query results/u);
	});

	it('verifies exact identity, objective, and instruction sources at the immutable TreeDX ref', async () => {
		const profile = 'name: Architect'; const digest = `sha256:${createHash('sha256').update(profile).digest('hex')}`; let input: any;
		const context = await readIdentityContext({ assignment: { metadata: { identityManifest: {
			agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1', digest },
			coreObjective: { path: 'objectives/core', expectedRevision: 'commit-1' },
			projectReadme: { path: 'README.md', expectedRevision: 'commit-1' },
			instructionTemplates: [{ path: 'instructions/chat.md', expectedRevision: 'commit-1' }],
		} } }, assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner',
			treeDx: { projectId: 'project-1', handleId: 'handle-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1', invoke: async (_operationId, value) => { input = value; return { data: { result: { files: [
				{ path: 'agents/architect.yaml', content: profile }, { path: 'objectives/core.mdx', sourcePath: 'objectives/core.mdx', logicalPath: 'objectives/core', requestedPath: 'objectives/core', content: '# Objective', frontmatter: coreObjective }, { path: 'README.md', content: '# SDK' }, { path: 'instructions/chat.md', content: 'Be concise.' },
			] } } }; } } });
		expect(input.body).not.toHaveProperty('ref');
		expect(input.body.paths).toContain('objectives/core');
		expect(input.body.paths).not.toContain('objectives/core.mdx');
		expect(context.manifest.agentHandle).toBe('@sdk/architect');
		expect((context.manifest.sources as any[]).map((source) => source.path)).toEqual(['agents/architect.yaml', 'objectives/core.mdx', 'README.md', 'instructions/chat.md']);
		expect((context.manifest.sources as any[])[1].logicalPath).toBe('objectives/core');
		expect((context.manifest.sources as any[]).every((source) => source.disposition === 'prompt-injected')).toBe(true);
	});

	it('fails closed when identity authority or content digest is mismatched', async () => {
		const request: any = { assignment: { metadata: { identityManifest: { agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1', digest: 'sha256:wrong' }, coreObjective: { path: 'objectives/core', expectedRevision: 'commit-1' }, instructionTemplates: [] } } },
			assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner', treeDx: { projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1',
				invoke: async () => ({ data: { result: { files: [{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.mdx', sourcePath: 'objectives/core.mdx', logicalPath: 'objectives/core', requestedPath: 'objectives/core', content: 'objective', frontmatter: coreObjective }] } } }) } };
		await expect(readIdentityContext(request)).rejects.toThrow(/digest mismatch/u);
		request.treeDx.baseRef = 'commit-2';
		await expect(readIdentityContext(request)).rejects.toThrow(/does not match/u);
	});
});
