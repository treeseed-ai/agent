import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertObjectiveContentModel, discussionMessageSourcePaths, readDiscussionSourceMessage, readFocusedTreeDxContext, readIdentityContext } from '../../../src/provider/execution/codex-chat-executor.ts';
import { executeAssignmentTreeDxTool } from '../../../src/provider/execution/microvm-executor.ts';
import { assertPredecessorSynthesis, assertReplayableVerificationCommand, codexInteractiveTimeoutMs, codexProjectInstructionArguments, codexReasoningArguments, codexTreeDxMcpConfig, completedTimeStatusChecks, promptFromContext, providerEventShapeSummary, providerResponsePreview, requiresActivityCompletion, timingAwarenessContract, treeDxToolDefinitions, verifyReportedActivityCommands } from '../../../src/sandbox/guest.ts';

describe('Codex chat executor', () => {
	it('requires structured completion only for a mutable legacy source workspace', () => {
		expect(requiresActivityCompletion('work')).toBe(true);
		expect(requiresActivityCompletion('read')).toBe(false);
	});
	it('rejects retired workday context and exposes no semantic publication tools', () => {
		expect(() => promptFromContext({ assignment: { executionKind: 'workday' } })).toThrow('legacy_workday_assignment_not_supported');
		expect(treeDxToolDefinitions().map(tool => tool.name)).not.toContain('treeseed_publish_review');
		expect(treeDxToolDefinitions().map(tool => tool.name)).toContain('treeseed_time_status');
	});
	it('directs source-backed chat to the mounted repository and TreeDX MCP rather than the host CLI', () => {
		const prompt = promptFromContext({
			identity: { manifest: { agentHandle: '@sdk/architect' } },
			assignment: { executionKind: 'communication', metadata: { communication: { requirement: 'required' }, chatProfile: {
				prompt: { system: 'Answer with evidence.', task: 'Research the current project.' },
			} } },
			projectManifest: { revision: 'exact-commit' }, coreContext: { sources: [] },
			message: { content: 'Describe the state of the project.' },
		}, undefined, 180);
		expect(prompt).toContain('attached at /workspace/project at immutable revision exact-commit');
		expect(prompt).toContain('inspect that repository with ordinary shell and Git commands');
		expect(prompt).toContain('treedx_* MCP tools');
		expect(prompt).toContain('Do not invoke trsd');
		expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
		expect(prompt).toContain('You have 180 productive seconds');
		expect(prompt).toContain('Your FIRST tool action must call mcp__treedx__treeseed_time_status');
		expect(prompt).toContain("independently of the activity profile's grant.tools list");
		expect(prompt).toContain('call mcp__treedx__treeseed_time_status again as your FINAL tool action');
		expect(prompt).toContain('including a failed attempt');
		expect(prompt).toContain('fewer than two successful clock checks is rejected');
		expect(prompt).toMatch(/DO NOT ANSWER OR REASON ABOUT THE TASK YET[\s\S]*fully qualified tool once more immediately before your response\.$/u);
		expect(prompt).toContain('stop broadening scope and finish the highest-value verified result');
		expect(codexProjectInstructionArguments()).toEqual(['-c', 'project_doc_max_bytes=0']);
	});
	it('accepts timing awareness only from completed model-initiated clock checks', () => {
		expect(completedTimeStatusChecks([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'in_progress' } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } },
		])).toBe(2);
		expect(completedTimeStatusChecks([
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'failed', error: 'unavailable' } },
		])).toBe(0);
	});
	it('requires clock checks to bracket every other provider tool action', () => {
		const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } };
		const command = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', error: null } };
		expect(timingAwarenessContract([clock, command, clock])).toMatchObject({
			completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true,
		});
		expect(timingAwarenessContract([command, clock, clock])).toMatchObject({ firstToolCompliant: false });
		expect(timingAwarenessContract([clock, clock, command])).toMatchObject({ finalToolCompliant: false });
		expect(timingAwarenessContract([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'wrong_clock_alias', status: 'in_progress' } },
			clock, clock,
		])).toMatchObject({ firstTool: 'treedx:wrong_clock_alias', firstToolCompliant: false });
	});
	it('summarizes provider event shapes without retaining arguments or output', () => {
		expect(providerEventShapeSummary([{ type: 'item.completed', item: {
			type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
			arguments: { secret: 'never retain' }, result: { remainingSeconds: 42 },
	} }])).toEqual([{ type: 'item.completed', itemType: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null }]);
	});
	it('redacts the last provider response used to diagnose a missing clock boundary', () => {
		expect(providerResponsePreview([{ type: 'item.completed', item: { type: 'agent_message', text: 'Cannot call sk-secret.' } }], ['sk-secret']))
			.toBe('Cannot call [redacted].');
	});
	it('reports remaining time from the API-started productive window without a content grant', async () => {
		const deadlineAt = new Date(Date.now() + 60_000).toISOString();
		const result = await executeAssignmentTreeDxTool({} as never, 'treeseed_time_status', {}, {
			startedAt: new Date().toISOString(), deadlineAt,
		});
		expect(result).toMatchObject({ deadlineAt });
		expect(Number((result as Record<string, unknown>).remainingSeconds)).toBeGreaterThan(55);
	});
	it('requires structured activities to report replayable checks as separate commands', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-1', sourceRef: { model: 'proposal', id: 'proposal-1' }, workspace: { mode: 'treedx' },
			effectiveProfile: { activity: 'estimating', handler: 'estimate', prompt: { system: 'Estimate the work.' } },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
		expect(prompt).toContain('Put each command in its own JSON array item');
		expect(prompt).toContain('never join commands with &&, ||, ;');
		expect(prompt).toContain('never rewrite it into a cleaner command');
		expect(prompt).toContain('directly observed exit zero');
		expect(prompt).toContain('A search that finds no matches exits nonzero');
		expect(prompt).not.toContain('This is pre-decision proposal review');
		expect(prompt).toContain('never include exploratory search or inspection commands');
		expect(prompt).toContain('rg, grep, find, ls, cat, sed, or git status');
		expect(prompt).toContain('use only field names shown by this contract');
		expect(prompt).toContain('Copy exact authorized references rather than manufacturing them');
		expect(prompt).toContain('exactly one contextRefs entry whose store matches that workspace');
		expect(prompt).toContain('Preserve proposal-level evidenceRefs, objectiveRefs, status');
		expect(prompt).toContain('never attribute source paths to the TreeDX library commit');
		expect(prompt).not.toContain('Put other evidence in the proposal-level evidenceRefs');
	});
	it('keeps the entire proposal while limiting estimating edits to the assigned role', () => {
		const context = (workItemId?: string) => ({ canonicalAssignmentContext: { assignment: {
			id: 'estimate-1', workItemId, sourceRef: { model: 'proposal', id: 'proposal-1' },
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'estimating', handler: 'estimate', prompt: {} },
		}, context: [], predecessorResults: [] } });
		const owner = promptFromContext(context('implement-change'));
		expect(owner).toContain('Return the entire exact assigned proposal');
		expect(owner).toContain('Never return only your own work item');
		expect(owner).toContain('Change only the estimate and rationale for work item implement-change');
		expect(owner).toContain('Do not execute the proposed work or mark the proposal ready');
		const reviewer = promptFromContext(context());
		expect(reviewer).toContain('assess the reviewEstimate for every review-required work item');
		expect(reviewer).toContain('preserve owner estimates and the complete product chain');
	});
	it('distinguishes a TreeDX proposal revision from the attached Git source during proposal review', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-review', sourceRef: { model: 'proposal', id: 'proposal-1', commit: 'proposal-commit' },
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'reviewing', handler: 'writer',
				prompt: { system: 'Review the proposal.' } },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain('This is pre-decision proposal review');
		expect(prompt).toContain('must never be resolved as an SDK Git commit');
		expect(prompt).toContain('Approve a sound plan');
		expect(prompt).toContain('no predecessor result or runtime acceptance evidence is expected');
	});
	it('reviews the paired Actor result when exact decision authority exists', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-work-review', sourceRef: { model: 'proposal', id: 'proposal-1' },
			authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision-1', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
			acceptanceCriteria: ['The Actor identifies the exact source commit.'],
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'reviewing', handler: 'writer',
				prompt: { system: 'Review the Actor result.' } },
		}, context: [], predecessorResults: [{ id: 'result-1' }] } });
		expect(prompt).not.toContain('This is pre-decision proposal review');
		expect(prompt).toContain('This is post-decision paired work review');
		expect(prompt).toContain('Review only the exact predecessor Actor result');
		expect(prompt).toContain('The Actor identifies the exact source commit.');
		expect(prompt).toContain('Predecessor results');
	});
	it('requires round-two estimating output to materially cite every predecessor result', () => {
		const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'estimating' } },
			predecessorResults: [{ id: 'result-a' }, { id: 'result-b' }] } };
		const prompt = promptFromContext(context);
		expect(prompt).toContain('cite every predecessor result by its exact ID');
		expect(prompt).toContain('result-a, result-b');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'Synthesized.', verification: [], reviewDisposition: null,
			contentOutput: { model: 'proposal', body: 'Used result-a only.', frontmatter: {} } }))
			.toThrow('predecessor_result_citation_missing:result-b');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'Synthesized.', verification: [], reviewDisposition: null,
			contentOutput: { model: 'proposal', body: 'result-a supplied scope; result-b supplied risks.', frontmatter: {} } }))
			.not.toThrow();
	});
	it('passes the configured reasoning effort to Codex', () => {
		expect(codexReasoningArguments('high')).toEqual(['-c', 'model_reasoning_effort=high']);
		expect(codexReasoningArguments(undefined)).toEqual([]);
	});
	it('respects the configured activity runtime for deeper chat reasoning', () => {
		expect(codexInteractiveTimeoutMs(900)).toBe(895_000);
		expect(codexInteractiveTimeoutMs(20)).toBe(15_000);
	});
	it('accepts passing verification only after the guest runner observes every command', async () => {
		const observed: string[] = [];
		await verifyReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'done', reviewDisposition: null, contentOutput: null,
			verification: [{ status: 'passed', summary: 'focused tests passed', commands: ['npm test -- focused'] }] }, async (command) => { observed.push(command); });
		expect(observed).toEqual(['npm test -- focused']);
	});
	it('rejects a claimed pass when runner observation fails', async () => {
		await expect(verifyReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'done', reviewDisposition: null, contentOutput: null,
			verification: [{ status: 'passed', summary: 'claimed pass', commands: ['false'] }] }, async () => { throw new Error('exit 1'); })).rejects.toThrow(/Runner-observed verification failed/u);
	});
	it('rejects compound, setup, and source-mutating commands as verification evidence', async () => {
		expect(() => assertReplayableVerificationCommand('npm test && git add . && git commit -m test')).toThrow(/one standalone command/u);
		expect(() => assertReplayableVerificationCommand('git commit -am test')).toThrow(/may not mutate/u);
		expect(() => assertReplayableVerificationCommand('npm ci')).toThrow(/may not mutate/u);
		expect(assertReplayableVerificationCommand('git diff --check')).toBe('git diff --check');
		expect(assertReplayableVerificationCommand('git merge-base --is-ancestor HEAD~1 HEAD')).toBe('git merge-base --is-ancestor HEAD~1 HEAD');
		expect(assertReplayableVerificationCommand('npm test -- focused')).toBe('npm test -- focused');
		expect(assertReplayableVerificationCommand("find /workspace/project -maxdepth 2 -mindepth 1 -printf '%y %p\\n' | head -100"))
			.toContain('| head -100');
		expect(() => assertReplayableVerificationCommand('npm test || true')).toThrow(/one standalone command/u);
		expect(assertReplayableVerificationCommand('node -e "const result = values.map(value => value > 0); if (!result[0]) process.exit(1)"'))
			.toContain('value => value > 0');
		expect(() => assertReplayableVerificationCommand('node test.js > result.txt')).toThrow(/one standalone command/u);
		expect(() => assertReplayableVerificationCommand('node -e "console.log($(whoami))"')).toThrow(/one standalone command/u);
	});
	it('requires canonical assignment prompts to explain complete verification commands', () => {
		const rendered = promptFromContext({ canonicalAssignmentContext: {
			assignment: { id: 'assignment', workItemId: 'work', sourceRef: { model: 'proposal', id: 'proposal' },
				authorityRefs: [], effectiveProfile: { activity: 'acting', handler: 'actor', prompt: { system: 'Work.' } },
				workspace: { mode: 'git' }, acceptanceCriteria: [], limits: { maximumSeconds: 30 } },
			context: [], predecessorResults: [],
		} }, 'high', 30);
		expect(rendered).toContain('syntactically complete with balanced quotes');
	});
	it('requires the assignment TreeDX MCP server and gives it only ephemeral relay authority', () => {
		const config = codexTreeDxMcpConfig('sandbox-1', 'one-use-token', { network: { relayUrl: 'https://relay.invalid' } } as never);
		expect(config).toContain('required = true');
		expect(config).toContain('startup_timeout_sec = 10');
		expect(config).toContain('TREESEED_GUEST_TOKEN = "one-use-token"');
		expect(config).toContain('TREESEED_RELAY_URL = "https://relay.invalid"');
	});
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
		expect(() => assertObjectiveContentModel('objectives/core.mdx', { frontmatter: { title: 'Core objective' } })).not.toThrow();
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
					{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.md', content: 'objective', frontmatter: { title: 'Core objective' } }, { path: 'README.md', content: 'readme' },
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
				{ path: 'agents/architect.yaml', content: profile }, { path: 'objectives/core.mdx', sourcePath: 'objectives/core.mdx', logicalPath: 'objectives/core', requestedPath: 'objectives/core', content: '# Objective', frontmatter: { title: 'Core objective' } }, { path: 'README.md', content: '# SDK' }, { path: 'instructions/chat.md', content: 'Be concise.' },
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
				invoke: async () => ({ data: { result: { files: [{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.mdx', sourcePath: 'objectives/core.mdx', logicalPath: 'objectives/core', requestedPath: 'objectives/core', content: 'objective', frontmatter: { title: 'Core objective' } }] } } }) } };
		await expect(readIdentityContext(request)).rejects.toThrow(/digest mismatch/u);
		request.treeDx.baseRef = 'commit-2';
		await expect(readIdentityContext(request)).rejects.toThrow(/does not match/u);
	});
});
