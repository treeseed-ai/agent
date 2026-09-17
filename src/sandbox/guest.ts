import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sandboxAssignmentSchema, sandboxResultSchema, sourceWorkspaceKeySchema, type SandboxAssignment } from '@treeseed/sdk/capacity-provider/sandbox';
import { providerCredentialValues, providerFailureSummary, redactProviderDiagnostic } from './provider-failure.ts';
import { activityCompletionOutputSchema, validateActivityCompletion, type ActivityCompletionReport } from '../activity-completion.ts';
import { describeContentFrontmatterContract, describeContentFrontmatterJsonSchema } from '@treeseed/sdk/content-validation';

const inputRoot = '/run/treeseed-assignment';
const outputRoot = '/run/treeseed-output';
const workspaceRoot = '/workspace';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const objectDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const progress = (stage: string) => writeFile(resolve(outputRoot, 'progress.json'), `${JSON.stringify({ stage, occurredAt: new Date().toISOString() })}\n`, { mode: 0o600 });

async function fileDigest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}


function run(executable: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; captureStdout?: boolean; maxStdoutBytes?: number; timeoutMs?: number } = {}) {
	return new Promise<{ stderr: string; stdout: string }>((accept, reject) => {
		const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); let pending = '', stderr = '', stdout = '', timedOut = false;
		if (!child.stdout || !child.stderr) { reject(new Error(`Could not capture ${executable} output.`)); return; }
		const childStdout = child.stdout, childStderr = child.stderr;
		const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs) : null;
		childStdout.setEncoding('utf8'); childStdout.on('data', (chunk) => {
			const value = String(chunk);
			if (options.captureStdout) { stdout += value; if (Buffer.byteLength(stdout) > (options.maxStdoutBytes ?? 8_388_608)) child.kill('SIGKILL'); }
			pending += value; const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) options.onLine?.(line);
		});
		childStderr.setEncoding('utf8'); childStderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
		child.once('error', (error) => { if (timeout) clearTimeout(timeout); reject(error); }); child.once('exit', (code, signal) => { if (timeout) clearTimeout(timeout); if (pending.trim()) options.onLine?.(pending); code === 0 ? accept({ stderr, stdout }) : reject(new Error(timedOut ? `${executable} exceeded its interactive execution deadline.` : `${executable} exited ${code ?? signal}: ${stderr}`)); });
		child.stdin?.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

async function materialize(assignment: SandboxAssignment) {
	for (const descriptor of assignment.inputs) {
		try {
			await progress(`input.${descriptor.id}.verifying`);
			const source = resolve(inputRoot, `input-${descriptor.id}`), information = await stat(source);
			if (information.size !== descriptor.bytes || await fileDigest(source) !== descriptor.digest) throw new Error('signed digest or size mismatch');
			const target = resolve(descriptor.targetPath); if (!target.startsWith(`${workspaceRoot}/`)) throw new Error('target escaped the guest workspace');
			await mkdir(descriptor.mediaType.endsWith('+tar') ? target : dirname(target), { recursive: true, mode: 0o700 });
			if (descriptor.mediaType === 'application/vnd.treeseed.directory+tar') await run('/bin/tar', ['--extract', '--file', source, '--directory', target, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 10_000 });
			else if (descriptor.mediaType === 'application/json' || descriptor.mediaType === 'application/x-pem-file') await writeFile(target, await readFile(source), { mode: descriptor.disposition === 'read-only' ? 0o400 : 0o600 });
			else throw new Error(`unsupported media type ${descriptor.mediaType}`);
			if (descriptor.disposition === 'read-only') { await run('/bin/chmod', ['-R', 'a-w', target], { timeoutMs: 10_000 }); await chmod(target, 0o500); }
			await progress(`input.${descriptor.id}.ready`);
		} catch (error) { throw new Error(`Guest input materialization failed for ${descriptor.id}: ${error instanceof Error ? error.message : String(error)}`); }
	}
}

async function startModelRelay(assignment: SandboxAssignment, sandboxId: string, operationToken: string) {
	const ca = await readFile('/workspace/.treeseed/relay-ca.crt');
	const server = createServer((incoming, outgoing) => {
		if (incoming.method !== 'POST' || incoming.url !== `/${'v1'}/responses`) { outgoing.writeHead(404); outgoing.end(); return; }
		const url = new URL(assignment.network.relayUrl);
		const upstream = httpsRequest({ hostname: url.hostname, port: Number(url.port), ca, servername: 'treeseed-sandbox-relay', method: 'POST', path: `/${'v1'}/sandboxes/${encodeURIComponent(sandboxId)}/model/responses`, headers: { ...incoming.headers, host: 'treeseed-sandbox-relay', authorization: `Bearer ${operationToken}` } }, (response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
		});
		upstream.once('error', (error) => { if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: error.message })); }); incoming.pipe(upstream);
	});
	await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
	const address = server.address(); if (!address || typeof address === 'string') throw new Error('Guest model relay did not bind a TCP port.');
	return { baseUrl: `http://127.0.0.1:${address.port}/${'v1'}`, close: () => new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept())) };
}

export function treeDxToolDefinitions(){return [
	{name:'treeseed_time_status',description:'Return the authoritative productive execution start, deadline, and current remaining seconds for this assignment.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
	{name:'treedx_build_context',description:'Build focused knowledge context. Omit project for the owning project; select team library or another authorized same-team project by slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},request:{type:'object',properties:{query:{type:'string'},topics:{type:'array',items:{type:'string'},maxItems:20},paths:{type:'array',items:{type:'string'},maxItems:20},mode:{type:'string',enum:['brief','detailed','citations','mixed']},maxItems:{type:'integer',minimum:1,maximum:50},maxTokens:{type:'integer',minimum:1}},anyOf:[{required:['query']},{required:['topics']}],additionalProperties:false}},required:['request'],additionalProperties:false}},
	{name:'treedx_read_files',description:'Read authorized TreeDX logical content identifiers. Omit project for the owning project; otherwise provide an authorized project slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},paths:{type:'array',items:{type:'string'},maxItems:20}},required:['paths'],additionalProperties:false}},
	{name:'treedx_search_files',description:'Search authorized TreeDX content. Omit project for the owning project; otherwise provide an authorized project slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},query:{type:'string'},paths:{type:'array',items:{type:'string'},maxItems:20},limit:{type:'integer'},includeBody:{type:'boolean'}},required:['query'],additionalProperties:false}},
	{name:'treedx_list_paths',description:'List authorized TreeDX logical paths. Omit project for the owning project; otherwise provide an authorized project slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},paths:{type:'array',items:{type:'string'},maxItems:20},limit:{type:'integer'}},required:['paths'],additionalProperties:false}},
	];}

export function completedTimeStatusChecks(events: Record<string, unknown>[]) {
	return events.filter(event => {
		const item = record(event.item);
		return event.type === 'item.completed'
			&& item.type === 'mcp_tool_call'
			&& item.server === 'treedx'
			&& item.tool === 'treeseed_time_status'
			&& item.status === 'completed'
			&& !item.error;
	}).length;
}

type TimingAwarenessTracker = {
	completedChecks: number;
	firstTool: string | null;
	firstToolSucceeded: boolean;
	lastTool: string | null;
	lastToolSucceeded: boolean;
};

function providerToolName(event: Record<string, unknown>) {
	if (event.type !== 'item.started' && event.type !== 'item.completed') return null;
	const item = record(event.item);
	if (item.type === 'mcp_tool_call') return `${text(item.server)}:${text(item.tool)}`;
	if (['command_execution', 'file_change', 'web_search'].includes(text(item.type))) return text(item.type);
	return null;
}

export function observeTimingAwarenessEvent(tracker: TimingAwarenessTracker, event: Record<string, unknown>) {
	const tool = providerToolName(event);
	if (!tool) return tracker;
	const item = record(event.item);
	const completed = event.type === 'item.completed';
	const succeeded = completed && item.status === 'completed' && !item.error;
	if (!tracker.firstTool) { tracker.firstTool = tool; tracker.firstToolSucceeded = succeeded; }
	else if (completed && tracker.firstTool === tool && tracker.lastTool === tool) tracker.firstToolSucceeded ||= succeeded;
	tracker.lastTool = tool;
	tracker.lastToolSucceeded = succeeded;
	if (completed && tool === 'treedx:treeseed_time_status' && succeeded) tracker.completedChecks += 1;
	return tracker;
}

export function timingAwarenessContract(events: Record<string, unknown>[]) {
	const tracker = events.reduce(observeTimingAwarenessEvent, { completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false } as TimingAwarenessTracker);
	return { requiredChecks: 2, ...tracker,
		schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const,
		firstToolCompliant: tracker.firstTool === 'treedx:treeseed_time_status' && tracker.firstToolSucceeded,
		finalToolCompliant: tracker.lastTool === 'treedx:treeseed_time_status' && tracker.lastToolSucceeded };
}

export function providerEventShapeSummary(events: Record<string, unknown>[], secrets: string[] = []) {
	return events.slice(-32).map(event => {
		const item = record(event.item);
		return {
			type: text(event.type) || null,
			itemType: text(item.type) || null,
			server: text(item.server) || null,
			tool: text(item.tool) || null,
			status: text(item.status) || null,
			error: redactProviderDiagnostic(item.error, secrets) || null,
		};
	});
}

export function providerResponsePreview(events: Record<string, unknown>[], secrets: string[] = []) {
	const message = [...events].reverse().map(event => record(event.item))
		.find(item => item.type === 'agent_message');
	return redactProviderDiagnostic(message?.text ?? message?.message ?? '', secrets);
}

export function codexTreeDxMcpConfig(sandboxId:string,operationToken:string,assignment:SandboxAssignment){
	const values={TREESEED_RELAY_URL:assignment.network.relayUrl,TREESEED_SANDBOX_ID:sandboxId,TREESEED_GUEST_TOKEN:operationToken,TREESEED_RELAY_CA:'/workspace/.treeseed/relay-ca.crt'};
	return `[features]\ncode_mode_host = false\n\n[mcp_servers.treedx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([process.argv[1],'--treedx-mcp'])}\nrequired = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n\n[mcp_servers.treedx.env]\n${Object.entries(values).map(([key,value])=>`${key} = ${JSON.stringify(value)}`).join('\n')}\n`;
}

async function invokeTreeDxRelay(tool:string,arguments_:Record<string,unknown>){
	const relayUrl=text(process.env.TREESEED_RELAY_URL),sandboxId=text(process.env.TREESEED_SANDBOX_ID),operationToken=text(process.env.TREESEED_GUEST_TOKEN),caPath=text(process.env.TREESEED_RELAY_CA);
	if(!relayUrl||!sandboxId||!operationToken||!caPath) throw new Error('TreeDX MCP relay environment is incomplete.');
	const encoded=Buffer.from(JSON.stringify({tool,arguments:arguments_})),url=new URL(relayUrl),ca=await readFile(caPath);
	return new Promise<unknown>((resolve,reject)=>{const request=httpsRequest({hostname:url.hostname,port:Number(url.port),ca,servername:'treeseed-sandbox-relay',method:'POST',path:`/${'v1'}/sandboxes/${encodeURIComponent(sandboxId)}/tools/treedx`,headers:{authorization:`Bearer ${operationToken}`,'content-type':'application/json','content-length':String(encoded.byteLength)}},(response)=>{let body='';response.setEncoding('utf8');response.on('data',(chunk)=>{body+=chunk;});response.on('end',()=>{try{const value=body?JSON.parse(body):{};(response.statusCode??500)<400?resolve(value):reject(new Error(String(value.error??`TreeDX relay returned ${response.statusCode}.`)));}catch(error){reject(error);}});});request.once('error',reject);request.end(encoded);});
}

export async function runTreeDxMcpServer(){
	const tools = treeDxToolDefinitions();
	const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
	for await(const line of lines){if(!line.trim())continue;let message:Record<string,unknown>;try{message=record(JSON.parse(line));}catch{continue;}const id=message.id,method=text(message.method);let result:unknown;
		try{if(method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'treeseed-assignment-treedx',version:'1'}};
			else if(method==='tools/list')result={tools};
			else if(method==='tools/call'){const parameters=record(message.params),name=text(parameters.name),arguments_=record(parameters.arguments);const value=await invokeTreeDxRelay(name,arguments_);result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:record(value)};}
			else if(method.startsWith('notifications/'))continue;else throw new Error(`Unsupported MCP method ${method}.`);
			process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,result})}\n`);
		}catch(error){process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:error instanceof Error?error.message:String(error)}})}\n`);}
	}
}

export function promptFromContext(context: Record<string, unknown>, reasoningEffort?: string, executionSeconds?: number) {
	const timingInstruction = `MANDATORY ASSIGNMENT CLOCK: You have ${executionSeconds ?? 'an API-defined number of'} productive seconds. The clock is provisioned for every assignment independently of the activity profile's grant.tools list. Codex exposes it as mcp__treedx__treeseed_time_status: MCP server treedx, tool treeseed_time_status. Your FIRST tool action must call mcp__treedx__treeseed_time_status before inspection, analysis, or any other tool. This required MCP server is already provisioned; invoke the exact callable immediately rather than inspecting the tool surface, guessing an alias, or replying that it is unavailable. After finishing all work, call mcp__treedx__treeseed_time_status again as your FINAL tool action, then immediately compose the final response without another tool call. Any attempted tool action before the initial clock check or after the final clock check invalidates the assignment, including a failed attempt. A response with fewer than two successful clock checks is rejected, even if the work is otherwise correct. Use each returned remainingSeconds value to bound scope and reserve time for verification and closeout.`;
	const timingStartReminder = 'DO NOT ANSWER OR REASON ABOUT THE TASK YET. Your next action must call mcp__treedx__treeseed_time_status (server treedx, tool treeseed_time_status). After completing the task, call that same fully qualified tool once more immediately before your response.';
	const canonicalContext = record(context.canonicalAssignmentContext);
	if (Object.keys(canonicalContext).length) {
		const assignment = record(canonicalContext.assignment);
		const authorityRefs = Array.isArray(assignment.authorityRefs) ? assignment.authorityRefs.map(record) : [];
		const acceptedDecision = authorityRefs.some((reference) => text(reference.model) === 'decision');
		const profile = record(assignment.effectiveProfile);
		const profilePrompt = record(profile.prompt);
		const items = Array.isArray(canonicalContext.context) ? canonicalContext.context.map(record) : [];
		const predecessors = Array.isArray(canonicalContext.predecessorResults) ? canonicalContext.predecessorResults : [];
		const predecessorIds = predecessors.map((value) => text(record(value).id)).filter(Boolean);
		const acceptanceCriteria = Array.isArray(assignment.acceptanceCriteria) ? assignment.acceptanceCriteria.map(text).filter(Boolean) : [];
		const estimating = text(profile.handler) === 'estimate';
		const proposalOutput = estimating
			? `This estimating assignment must return contentOutput with model \"proposal\", a substantive Markdown body, and frontmatter containing one JSON object satisfying this canonical SDK proposal contract: ${JSON.stringify(describeContentFrontmatterContract('proposal'))}. Copy the exact assigned proposal frontmatter, not a predecessor proposal. The contract describes valid fields; it does not authorize rewriting existing values. Preserve every field except the assigned estimate or Reviewer reviewEstimate. Put new rationale inside that estimate's rationale field and source evidence in contentOutput.body, citing the attached Git repository and its exact source commit. Never attribute source paths to the TreeDX library commit. Cite predecessor contributions in contentOutput.body only: never copy their estimates into other work items, even when they are accepted. Preserve dependencies, source references, evidenceRefs, objectiveRefs, and status exactly. Use the exact proposal write target and source authority in the assignment. Do not create a Note or a separate estimate artifact.`
			: 'Return contentOutput as null unless this handler explicitly requires governed content output.';
		const authorized = items.map((item) => `Reference: ${JSON.stringify(item.ref)}\nDigest: ${text(item.digest)}\n\n${JSON.stringify(item.value)}`).join('\n\n');
		return [
			timingInstruction,
			text(profilePrompt.system),
			...(Array.isArray(profilePrompt.instructions) ? profilePrompt.instructions.map(text).filter(Boolean) : []),
			`Execute canonical assignment ${text(assignment.id)}${text(assignment.workItemId) ? ` for work item ${text(assignment.workItemId)}` : ''} from ${text(record(assignment.sourceRef).model)}/${text(record(assignment.sourceRef).id)}.`,
			`Activity: ${text(profile.activity)}. Handler: ${text(profile.handler)}. Workspace: ${text(record(assignment.workspace).mode)}.`,
			'Use only the exact authorized context and predecessor results below. The attached repository root is /workspace/project. Inspect it with ordinary shell and Git commands whenever source is attached; do not answer from supplied summaries alone. Use the treedx_* MCP tools for governed knowledge. The trsd CLI is intentionally absent from assignment guests. Do not claim an inspection or verification you did not perform.',
			text(profile.activity) === 'reviewing' && text(record(assignment.sourceRef).model) === 'proposal' && !acceptedDecision
				? 'This is pre-decision proposal review. Judge whether the proposed plan is decision-ready and testable; its Actor has not executed, so no predecessor result or runtime acceptance evidence is expected. The proposal sourceRef commit is only the exact revision of the proposal in its TreeDX content repository. It is not, does not claim to be, and must never be resolved as an SDK Git commit. The independently attached project source commit is the only SDK source revision available for feasibility inspection. Approve a sound plan even when its stated post-decision acceptance evidence has not yet been produced.'
				: '',
			text(profile.activity) === 'reviewing' && acceptedDecision
				? 'This is post-decision paired work review. Review only the exact predecessor Actor result against this work item\'s acceptance criteria. Do not re-review the already accepted proposal, demand implementation outside this work item, or replace its acceptance boundary with broader proposal outcomes. Approve when the predecessor result satisfies this work item; otherwise request precise changes to that result.'
				: '',
			acceptanceCriteria.length ? `Work-item acceptance criteria:\n${JSON.stringify(acceptanceCriteria)}` : 'No additional work-item acceptance criteria were supplied.',
			authorized ? `Authorized context:\n${authorized}` : 'No additional context references were authorized.',
			predecessors.length ? `Predecessor results:\n${JSON.stringify(predecessors)}` : 'There are no predecessor results.',
			predecessorIds.length > 1
				? `Collaborative synthesis is mandatory. In contentOutput.body, cite every predecessor result by its exact ID and state the material contribution incorporated from each: ${predecessorIds.join(', ')}.`
				: '',
			proposalOutput,
			estimating
				? `Estimate scope is not proposal scope. Return the entire exact assigned proposal, retaining every work item, dependency target, objective, acceptance criterion, permission, and source reference. Never return only your own work item: that would delete other roles and leave dangling dependencies. ${text(assignment.workItemId) ? `Change only the estimate and rationale for work item ${text(assignment.workItemId)}; preserve the other items unchanged.` : 'As independent Reviewer, assess the reviewEstimate for every review-required work item; preserve owner estimates and the complete product chain.'} Do not execute the proposed work or mark the proposal ready on behalf of the other participants. Source inspection establishes your rationale, not a passing implementation test: return verification: [] unless you actually ran a standalone acceptance test. Never list source-inspection commands as verification. The AgentKernel validates the estimate contract and publication.`
				: '',
			'For Git work, commit every intended change and leave the worktree clean. The verification field is only for deliberate acceptance checks with a defined pass condition; never include exploratory search or inspection commands such as rg, grep, find, ls, cat, sed, or git status there. Report only the exact standalone acceptance commands you actually ran and directly observed exit zero. Every reported command must be syntactically complete with balanced quotes; prefer a short standard project check over a complex inline program. A search that finds no matches exits nonzero: treat that as a finding, never as passing verification. If a command returned nonzero or was originally executed with chaining, redirection, substitution, or a script, omit it completely; never rewrite it into a cleaner command for the report. Put each command in its own JSON array item; never join commands with &&, ||, ;, redirection, command substitution, or a shell script. Tool authority is enforced by the assignment grant.',
			`Assigned reasoning effort: ${reasoningEffort || 'provider-default'}.`,
			`Productive execution budget: ${(executionSeconds ?? text(record(assignment.limits).maximumSeconds)) || 'unknown'} seconds. When time is short, stop broadening scope and finish the highest-value verified result.`,
			timingStartReminder,
		].join('\n\n');
	}
	const identity = record(context.identity), manifest = record(identity.manifest), coreContext=record(context.coreContext),sources=Array.isArray(coreContext.sources)?coreContext.sources.map(record):[];
	const assignment = record(context.assignment), metadata = record(assignment.metadata), chatProfile = record(metadata.chatProfile), prompt = record(chatProfile.prompt), communication = record(metadata.communication);
	const sourceText = sources.map((source) => `## ${text(source.layer)} / ${text(source.kind)}: ${text(source.path)||text(source.id)}\nProject: ${text(source.projectId)}\nDigest: ${text(source.digest)}\nDisposition: ${text(source.disposition)}\n\n${text(source.content)}`).join('\n\n');
	const required = text(communication.requirement) !== 'optional';
	const projectAccess = `The complete project source repository is attached at /workspace/project at immutable revision ${text(record(context.projectManifest).revision)}, with Git history and private writable scratch storage. Before answering, inspect that repository with ordinary shell and Git commands; do not answer from supplied summaries alone. Use the treedx_* MCP tools for governed knowledge. Builds and tests may modify this disposable workspace. Filesystem write access does not grant publication authority. Do not claim code inspection you did not perform.`;
	if (assignment.executionKind === 'workday') throw new Error('legacy_workday_assignment_not_supported');
	return `${timingInstruction}\n\nYou are exactly ${text(manifest.agentHandle)}. The verified TreeDX context below is ordered by mandatory core, agent-general, activity-specific, and live discussion layers.\n\n${sourceText}\n\nActivity instructions:\n${text(prompt.system)}\n\nActivity task:\n${text(prompt.task) || 'Respond to the committed Discussion message.'}\n\n${required ? 'You were directly addressed and must provide a substantive response.' : 'Respond only if your role adds material value; otherwise return exactly <!-- treeseed:abstain -->.'}\n${projectAccess} Prefer extensionless identifiers such as objectives/core. Do not supply or reason about Git commits for normal TreeDX access; the assignment relay privately enforces consistent views. Do not invoke trsd: the CLI is intentionally absent from assignment guests. Tool and content permissions come from this activity profile. When time is short, stop broadening scope and finish the highest-value verified result. The assigned reasoning effort is ${reasoningEffort || 'provider-default'}. Scale inspection and research depth to that setting and the question. Do not run unrelated broad test suites or exhaustive scans. Do not inspect outside /workspace or disclose credentials. Return only the message to post.\n\nDiscussion message:\n${text(record(context.message).content)}\n\n${timingStartReminder}`;
}

export function assertPredecessorSynthesis(context: Record<string, unknown>, completion: ActivityCompletionReport | null) {
	const canonical = record(context.canonicalAssignmentContext);
	const assignment = record(canonical.assignment);
	if (text(record(assignment.effectiveProfile).activity) !== 'estimating') return;
	const ids = (Array.isArray(canonical.predecessorResults) ? canonical.predecessorResults : [])
		.map((value) => text(record(value).id)).filter(Boolean);
	if (ids.length < 2) return;
	const body = completion?.contentOutput?.body ?? '';
	const missing = ids.filter((id) => !body.includes(id));
	if (missing.length) throw new Error(`predecessor_result_citation_missing:${missing.join(',')}`);
}

export function codexReasoningArguments(reasoningEffort: string | undefined) {
	return reasoningEffort && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)
		? ['-c', `model_reasoning_effort=${reasoningEffort}`] : [];
}

export function codexProjectInstructionArguments() {
	// Repository AGENTS.md files describe trusted host workspaces and may require
	// tools such as trsd that intentionally do not exist inside an assignment VM.
	// The canonical assignment prompt is the only guest execution instruction.
	return ['-c', 'project_doc_max_bytes=0'];
}

export function codexInteractiveTimeoutMs(durationSeconds: number) {
	return Math.max(1_000, durationSeconds * 1_000 - 5_000);
}

export function requiresActivityCompletion(sourceMode: unknown) {
	return sourceMode === 'work';
}

/** Convert model-reported passing checks into runner-observed evidence. */
export async function verifyReportedActivityCommands(report: ActivityCompletionReport,
	execute: (command: string) => Promise<void> = async (command) => {
		await run('/bin/sh', ['-lc', command], { cwd: '/workspace/project', timeoutMs: 120_000 });
	}) {
	const commands = [...new Set(report.verification.filter((entry) => entry.status === 'passed').flatMap((entry) => entry.commands))];
	if (commands.length > 8 || commands.some((command) => command.length > 4096 || command.includes('\0'))) throw new Error('Activity completion verification command set exceeds its bounded policy.');
	for (const command of commands) assertReplayableVerificationCommand(command);
	for (const command of commands) {
		try { await execute(command); }
		catch { throw new Error(`Runner-observed verification failed: ${command}`); }
	}
	return report;
}

async function observeReportedActivityCommands(report: ActivityCompletionReport) {
	const commands = [...new Set(report.verification.filter((entry) => entry.status === 'passed').flatMap((entry) => entry.commands))];
	if (commands.length > 8 || commands.some((command) => command.length > 4096 || command.includes('\0'))) throw new Error('Activity completion verification command set exceeds its bounded policy.');
	const verification = [];
	for (const command of commands) {
		assertReplayableVerificationCommand(command);
		const started = process.hrtime.bigint();
		try {
			const output = await run('/bin/sh', ['-lc', command], { cwd: '/workspace/project', captureStdout: true,
				maxStdoutBytes: 8_388_608, timeoutMs: 120_000 });
			verification.push({ command, status: 'passed' as const, exitCode: 0,
				outputDigest: objectDigest({ stdout: output.stdout, stderr: output.stderr }),
				durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) });
		} catch { throw new Error(`Runner-observed verification failed: ${command}`); }
	}
	return { report, verification };
}

/** Keep completion evidence replayable: one validation command or pipeline, never a shell workflow or source mutation. */
export function assertReplayableVerificationCommand(command: string) {
	const normalized = command.trim();
	if (!normalized || hasUnsafeShellControl(normalized)) {
		throw new Error(`Activity completion verification must be one standalone command: ${command}`);
	}
	if (/\b(?:sudo|su|doas|rm|mv|cp|install|chmod|chown|truncate|tee)\b/u.test(normalized)
		|| /\bgit\s+(?:add|commit|push|reset|checkout|switch|clean|merge|rebase|tag|branch|restore)(?=\s|$)/u.test(normalized)
		|| /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade)\b/u.test(normalized)
		|| /\b(?:sh|bash|zsh|dash)\s+-c\b/u.test(normalized)) {
		throw new Error(`Activity completion verification may not mutate or prepare the workspace: ${command}`);
	}
	return normalized;
}

function hasUnsafeShellControl(command: string) {
	let quote: "'" | '"' | null = null, escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (escaped) { escaped = false; continue; }
		if (character === '\\' && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (character === quote) quote = null;
			else if (quote === '"' && (character === '`' || (character === '$' && command[index + 1] === '('))) return true;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if ('\r\n;&<>`'.includes(character) || (character === '|' && command[index + 1] === '|')
			|| (character === '$' && command[index + 1] === '(')) return true;
	}
	return quote !== null || escaped;
}

export async function runSandboxGuest() {
	const started = process.hrtime.bigint(), usageBefore = process.resourceUsage();
	await progress('guest.started');
	const assignment = sandboxAssignmentSchema.parse(JSON.parse(await readFile(resolve(inputRoot, 'assignment.json'), 'utf8')));
	await progress('assignment.verified');
	const sandboxId = (await readFile(resolve(inputRoot, 'sandbox-id'), 'utf8')).trim(), operationToken = (await readFile(resolve(inputRoot, 'operation-token'), 'utf8')).trim();
	await materialize(assignment); const context = record(JSON.parse(await readFile('/workspace/.treeseed/context.json', 'utf8')));
	await mkdir('/workspace/project', { recursive: true, mode: 0o700 });
	await progress('inputs.ready');
	if (assignment.contextManifestDigest !== assignment.inputs.find((input) => input.id === 'execution-context')?.digest || assignment.identityManifestDigest !== objectDigest(record(record(context.identity).manifest))) throw new Error('Guest context or identity manifest does not match the signed assignment.');
	const sourceText = await readFile(resolve(inputRoot, 'source.json'), 'utf8').catch(() => null);
	const sourceMetadata = sourceText ? record(JSON.parse(sourceText)) : null;
	const source = sourceMetadata ? sourceWorkspaceKeySchema.parse(sourceMetadata.source) : null;
	if (source) {
		if (source.teamId !== assignment.teamId || source.projectId !== assignment.projectId) throw new Error('Attached source does not match assignment scope.');
		const head = (await run('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 128, timeoutMs: 10_000 })).stdout.trim();
		if (head !== source.commit) throw new Error('Attached source differs from its exact authorized commit.');
		context.projectManifest = { ...record(context.projectManifest), source, revision: head, mode: sourceMetadata?.mode, publication: sourceMetadata?.publication };
	}
	const codexHome = '/workspace/.treeseed/codex', responsePath = '/workspace/.treeseed/response.md'; await mkdir(codexHome, { recursive: true, mode: 0o700 });
	await writeFile(resolve(codexHome,'config.toml'),codexTreeDxMcpConfig(sandboxId,operationToken,assignment),{mode:0o600});
	const subscriptionAuth = await readFile(resolve(inputRoot, 'codex-auth.json')).catch(() => null);
	if (subscriptionAuth) {
		await writeFile(resolve(codexHome, 'auth.json'), subscriptionAuth, { mode: 0o600 });
		// Seed the protected return channel before model execution so a killed or
		// non-refreshing Codex process cannot strand the host credential updater.
		await writeFile(resolve(outputRoot, 'codex-auth.json'), subscriptionAuth, { mode: 0o600, flag: 'wx' });
	}
	const relay = subscriptionAuth ? null : await startModelRelay(assignment, sandboxId, operationToken);
	const subscriptionProxy = subscriptionAuth ? `http://${encodeURIComponent(sandboxId)}:${encodeURIComponent(operationToken)}@10.89.0.1:7444` : null;
	const events: Record<string, unknown>[] = [], timingTracker: TimingAwarenessTracker = { completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false },
		composedPrompt = promptFromContext(context, assignment.modelPolicy.reasoningEffort, assignment.resources.durationSeconds);
	const canonicalActivity = text(record(record(record(context.canonicalAssignmentContext).assignment).effectiveProfile).activity);
	const structuredCompletion = (Boolean(canonicalActivity) && canonicalActivity !== 'chat')
		|| (sourceMetadata ? requiresActivityCompletion(sourceMetadata.mode) : false);
	const completionSchemaPath = resolve(codexHome, 'activity-completion.schema.json');
	if (structuredCompletion) await writeFile(completionSchemaPath, `${JSON.stringify(activityCompletionOutputSchema(canonicalActivity === 'estimating' ? describeContentFrontmatterJsonSchema('proposal') : undefined))}\n`, { mode: 0o600 });
	const providerArguments = ['exec', '--json', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--model', assignment.modelPolicy.model,
		...codexReasoningArguments(assignment.modelPolicy.reasoningEffort),
		...codexProjectInstructionArguments(),
		...(structuredCompletion ? ['--output-schema', completionSchemaPath] : []),
		'--disable', 'browser_use', '--disable', 'apps', '--disable', 'multi_agent_v2', '--disable', 'image_generation', '--color', 'never', '--output-last-message', responsePath, '-C', '/workspace/project', '-'];
	let providerError: Error | null = null;
	try {
		await progress('provider.starting');
		await run('/usr/local/bin/codex', providerArguments, {
			cwd: '/workspace/project', input: composedPrompt, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: codexHome, CODEX_HOME: codexHome,
				TREESEED_RELAY_URL:assignment.network.relayUrl,TREESEED_SANDBOX_ID:sandboxId,TREESEED_GUEST_TOKEN:operationToken,TREESEED_RELAY_CA:'/workspace/.treeseed/relay-ca.crt',
				...(relay ? { OPENAI_BASE_URL: relay.baseUrl, OPENAI_API_KEY: 'treeseed-assignment-relay' } : {}),
				...(subscriptionProxy ? { HTTPS_PROXY: subscriptionProxy, https_proxy: subscriptionProxy } : {}), LANG: 'C.UTF-8' },
			timeoutMs: codexInteractiveTimeoutMs(assignment.resources.durationSeconds),
			onLine(line) { let event: Record<string, unknown>; try { event = record(JSON.parse(line)); } catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
				observeTimingAwarenessEvent(timingTracker, event); events.push(event); if (events.length > 256) events.shift(); },
		}).catch(error => {
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			const detail = providerFailureSummary(events, secrets);
			// Avoid leaking credentials through the subprocess stderr fallback too.
			const fallback = providerFailureSummary([{ type: 'error', message: error instanceof Error ? error.message : String(error) }], secrets);
			providerError = new Error(`Codex execution failed: ${detail || fallback || 'no structured error was supplied'}`);
		});
		if (subscriptionAuth) {
			const refreshed = await readFile(resolve(codexHome, 'auth.json'));
			await writeFile(resolve(outputRoot, 'codex-auth.json'), refreshed, { mode: 0o600 });
		}
		if (providerError) throw providerError;
		await progress('provider.completed');
		const timingAwareness = { schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const, requiredChecks: 2 as const, ...timingTracker,
			firstToolCompliant: timingTracker.firstTool === 'treedx:treeseed_time_status' && timingTracker.firstToolSucceeded,
			finalToolCompliant: timingTracker.lastTool === 'treedx:treeseed_time_status' && timingTracker.lastToolSucceeded };
		if (timingAwareness.completedChecks < 2 || !timingAwareness.firstToolCompliant || !timingAwareness.finalToolCompliant) {
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			throw new Error(`Agent timing-awareness contract requires treeseed_time_status as the first and final tool actions with two completed checks; observed ${JSON.stringify(timingAwareness)}. Provider event shapes: ${JSON.stringify(providerEventShapeSummary(events, secrets))}. Response preview: ${providerResponsePreview(events, secrets) || '(empty)'}`);
		}
		const rawResponse = (await readFile(responsePath, 'utf8')).trim(); if (!rawResponse) throw new Error('Execution provider returned an empty response.');
		const observedCompletion = structuredCompletion ? await observeReportedActivityCommands(validateActivityCompletion(JSON.parse(rawResponse))) : null;
		const activityCompletion = observedCompletion?.report ?? null;
		assertPredecessorSynthesis(context, activityCompletion);
		const responseMarkdown = activityCompletion?.summary ?? rawResponse;
		if (sourceMetadata?.mode === 'work') {
			// Do not trust the execution repository's index flags or stat cache when
			// deciding whether a candidate is clean. The later verifier uses a fresh
			// index as well, so both boundaries now evaluate the same committed tree.
			const verificationIndex = resolve('/tmp', `treeseed-clean-${assignment.assignmentId}`);
			const verificationEnvironment = { PATH: '/usr/bin:/bin', GIT_INDEX_FILE: verificationIndex,
				GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
			const gitArguments = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
			try {
				await run('/usr/bin/git', [...gitArguments, 'read-tree', 'HEAD'], { cwd: '/workspace/project', env: verificationEnvironment, timeoutMs: 10_000 });
				const status = (await run('/usr/bin/git', [...gitArguments, 'status', '--porcelain', '--untracked-files=all'], {
					cwd: '/workspace/project', env: verificationEnvironment, captureStdout: true, maxStdoutBytes: 1_048_576, timeoutMs: 10_000,
				})).stdout.replace(/\n$/u, '');
				if (status) throw new Error(`Work-mode execution left uncommitted changes: ${status.split('\n').slice(0, 20).map(line => line.length >= 4 ? line.slice(3) : line).join(', ')}`);
			} finally { await rm(verificationIndex, { force: true }); }
			// Candidate verification intentionally runs in a different Kata VM after the
			// execution VM has stopped. Flush the committed tree and Git object database
			// before returning success so that verifier reads cannot observe a newer ref
			// with stale worktree blocks from the executed overlay.
			await run('/bin/sync', [], { timeoutMs: 30_000 });
		}
		const changedPaths = sourceMetadata?.mode === 'work' && source
			? (await run('/usr/bin/git', ['diff', '--name-only', `${source.commit}..HEAD`], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 1_048_576, timeoutMs: 10_000 })).stdout.split('\n').map((path) => path.trim()).filter(Boolean)
			: [];
		const diagnosticSecrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
		const providerEventShapes = providerEventShapeSummary(events, diagnosticSecrets);
		const artifacts: Array<{ id: string; path: string; digest: string; mediaType: string; bytes: number }> = [];
		const completed = [...events].reverse().find((event) => text(event.type).includes('completed')) ?? {}, elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9, usageAfter = process.resourceUsage();
		const result = sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1', sandboxId, assignmentId: assignment.assignmentId,
			status: responseMarkdown === '<!-- treeseed:abstain -->' ? 'completed' : 'completed', summary: 'Kata assignment completed.', responseMarkdown,
			artifacts, timingAwareness, usage: { ...record(completed.usage), provenance: Object.keys(record(completed.usage)).length ? 'execution-provider' : 'unavailable', activeSeconds: elapsedSeconds, elapsedSeconds,
				cpuUserMicros: usageAfter.userCPUTime - usageBefore.userCPUTime, cpuSystemMicros: usageAfter.systemCPUTime - usageBefore.systemCPUTime, peakRssBytes: usageAfter.maxRSS * 1024 },
			diagnostics: { systemPrompt: composedPrompt, providerEvents: events, providerEventShapes, providerArguments, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, contextManifest: context, activityCompletion,
				verificationRecords: observedCompletion?.verification ?? [], changedPaths,
				sourceCommit: sourceMetadata?.mode === 'work' ? (await run('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 128, timeoutMs: 10_000 })).stdout.trim() : source?.commit ?? null,
				guestKernel: (await readFile('/proc/version', 'utf8')).trim(), guestUid: process.getuid?.() ?? null, sandboxProfile: assignment.profile }, teardown: { verified: false, completedAt: null } });
		await writeFile(resolve(outputRoot, 'result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
	} finally { await rm(resolve(codexHome, 'auth.json'), { force: true }); await rm(resolve(codexHome,'config.toml'),{force:true}); await rm(resolve(codexHome,'activity-completion.schema.json'),{force:true}); await relay?.close(); }
}

if(process.argv.includes('--treedx-mcp')) runTreeDxMcpServer().catch((error)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1;});
else if (process.argv[1]?.endsWith('/sandbox/guest.js')) runSandboxGuest().catch(async (error) => {
	await mkdir(outputRoot, { recursive: true });
	await writeFile(resolve(outputRoot, 'failure.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`).catch(() => undefined);
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1;
});
