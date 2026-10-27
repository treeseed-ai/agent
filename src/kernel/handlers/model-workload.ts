import { run, withinAssignmentBudget, remainingExecutionMs } from '../../sandbox/process-runner.ts';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sandboxAssignmentSchema, sandboxResultSchema, sourceWorkspaceKeySchema, type SandboxAssignment } from '@treeseed/sdk/capacity-provider/sandbox';
import { providerCredentialValues, providerFailureSummary, redactProviderDiagnostic, redactProviderEvents } from '../../sandbox/provider-failure.ts';
import { activityAllowsVerification, providerItemIdentity, scopeProviderEvent, validateModelContext } from './model-workload-contract.ts';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../activity-completion.ts';
import { completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext, assertArchitectSourceCitation, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTestFirstRedVerification, omitUnreplayableVerification, codexInvocationTimerOptions, requiresActivityCompletion, record, text, providerToolName, codexToolInFlight, codexResumeIdleTimeoutMs } from './model-workload-contract.ts';
import { planningSynthesisOutputSchema, assertPredecessorSynthesis } from './planning-synthesis.ts';
import { recoverPlanningSynthesis } from '../../sandbox/planning-synthesis-recovery.ts';
import { closeModelProduct } from './model-product-closeout.ts';
import { assertCleanWorkSource, objectDigest, observeReportedActivityCommands, prepareReleaseReview, prepareNodeWorkspace } from './model-verification.ts';
export { observeReportedActivityCommands, verifyReportedActivityCommands, requiresNodeDependencyRestore, prepareNodeWorkspace } from './model-verification.ts';

const inputRoot = '/run/treeseed-assignment';
const outputRoot = '/run/treeseed-output';
const workspaceRoot = '/workspace';
const progress = (stage: string) => writeFile(resolve(outputRoot, 'progress.json'), `${JSON.stringify({ stage, occurredAt: new Date().toISOString() })}\n`, { mode: 0o600 });

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
	{name:'treedx_read_files',description:'Read authorized TreeDX logical content identifiers. Supply the exact 40-character commit from an authorized predecessor reference when reviewing its output; omit ref for the pinned current view.',inputSchema:{type:'object',properties:{project:{type:'string'},ref:{type:'string',pattern:'^[a-f0-9]{40}$'},paths:{type:'array',items:{type:'string'},maxItems:20}},required:['paths'],additionalProperties:false}},
	{name:'treedx_search_files',description:'Search authorized TreeDX content. Omit project for the owning project; otherwise provide an authorized project slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},query:{type:'string'},paths:{type:'array',items:{type:'string'},maxItems:20},limit:{type:'integer'},includeBody:{type:'boolean'}},required:['query'],additionalProperties:false}},
	{name:'treedx_list_paths',description:'List authorized TreeDX logical paths. Omit project for the owning project; otherwise provide an authorized project slug or ID.',inputSchema:{type:'object',properties:{project:{type:'string'},paths:{type:'array',items:{type:'string'},maxItems:20},limit:{type:'integer'}},required:['paths'],additionalProperties:false}},
	];}

export function completedTimeStatusChecks(events: Record<string, unknown>[]) {
	return timingAwarenessContract(events).completedChecks;
}

type TimingAwarenessTracker = {
	completedChecks: number;
	firstTool: string | null;
	firstToolSucceeded: boolean;
	firstToolItemId?: unknown;
	firstToolPending?: boolean;
	lastTool: string | null;
	lastToolSucceeded: boolean;
	clockWindow?: { startedAt: string; deadlineAt: string; observedAt: string; remainingSeconds: number };
	clockInvalid?: boolean;
	completedClockItemIds?: Set<string>;
};

export function clockReading(raw: unknown): TimingAwarenessTracker['clockWindow'] | undefined {
	const result = record(raw);
	if (result.isError || !Array.isArray(result.content) || result.content.length !== 1) return;
	const content = record(result.content[0]);
	if (content.type !== 'text' || typeof content.text !== 'string') return;
	let parsed: unknown;
	try { parsed = JSON.parse(content.text); } catch { return; }
	if (result.structuredContent !== undefined && !isDeepStrictEqual(parsed, result.structuredContent)) return;
	// Codex SDK events serialize the MCP result's structured field in snake case.
	if (result.structured_content !== undefined && !isDeepStrictEqual(parsed, result.structured_content)) return;
	const value = record(parsed), start = value.startedAt, end = value.deadlineAt, observed = value.observedAt, remaining = value.remainingSeconds;
	const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
	if (typeof start !== 'string' || typeof end !== 'string' || !iso.test(start) || !iso.test(end)
		|| !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)
		|| typeof observed !== 'string' || !iso.test(observed) || !Number.isFinite(Date.parse(observed))
		|| new Date(observed).toISOString() !== observed || Date.parse(observed) < Date.parse(start)
		|| typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 0
		|| remaining !== Math.max(0, Math.ceil((Date.parse(end) - Date.parse(observed)) / 1_000))) return;
	return { startedAt: start, deadlineAt: end, observedAt: observed, remainingSeconds: remaining };
}

export function observeTimingAwarenessEvent(tracker: TimingAwarenessTracker, event: Record<string, unknown>) {
	const tool = providerToolName(event);
	if (!tool) return tracker;
	const item = record(event.item), identity = providerItemIdentity(event);
	const completed = event.type === 'item.completed';
	if (tracker.firstToolPending && (tool !== tracker.firstTool || identity !== tracker.firstToolItemId)) tracker.clockInvalid = true;
	let succeeded = completed && item.status === 'completed' && !item.error;
	if (completed && tool === 'treedx:treeseed_time_status' && typeof item.id === 'string') {
		const ids = tracker.completedClockItemIds ??= new Set<string>();
		if (ids.has(identity)) { tracker.clockInvalid = true; succeeded = false; }
		else ids.add(identity);
	}
	if (completed && tool === 'treedx:treeseed_time_status' && succeeded) {
		const reading = clockReading(item.result), prior = tracker.clockWindow;
		if (!reading || prior && (reading.startedAt !== prior.startedAt || reading.deadlineAt !== prior.deadlineAt
			|| reading.remainingSeconds > prior.remainingSeconds || Date.parse(reading.observedAt) < Date.parse(prior.observedAt))) { tracker.clockInvalid = true; succeeded = false; }
		else tracker.clockWindow = reading;
	}
	if (!tracker.firstTool) {
		tracker.firstTool = tool; tracker.firstToolSucceeded = succeeded;
		tracker.firstToolItemId = identity; tracker.firstToolPending = !completed;
	} else if (tracker.firstToolPending && completed && tracker.firstTool === tool && tracker.firstToolItemId === identity) {
		tracker.firstToolSucceeded = succeeded; tracker.firstToolPending = false;
	}
	tracker.lastTool = tool;
	tracker.lastToolSucceeded = succeeded;
	if (completed && tool === 'treedx:treeseed_time_status' && succeeded) tracker.completedChecks += 1;
	return tracker;
}

export function timingAwarenessContract(events: Record<string, unknown>[]) {
	const tracker = events.reduce(observeTimingAwarenessEvent, { completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false } as TimingAwarenessTracker);
	const { clockWindow: _window, clockInvalid, completedClockItemIds: _clockIds, firstToolItemId: _firstId, firstToolPending: _firstPending, ...receipt } = tracker;
	return { requiredChecks: 2, ...receipt,
		schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const,
		firstToolCompliant: !clockInvalid && tracker.firstTool === 'treedx:treeseed_time_status' && tracker.firstToolSucceeded,
		finalToolCompliant: !clockInvalid && tracker.lastTool === 'treedx:treeseed_time_status' && tracker.lastToolSucceeded };
}

export function timingRecoveryEligible(contract: ReturnType<typeof timingAwarenessContract>, remainingMs: number) {
	// A model may make the second clock check, then use another tool. In that
	// case the final-tool boundary is still broken; one same-session clock-only
	// continuation can repair it without extending the allocator deadline.
	return contract.schemaVersion === 'treeseed.assignment-timing-awareness/v1' && contract.requiredChecks === 2
		&& contract.firstTool === 'treedx:treeseed_time_status' && contract.firstToolSucceeded === true && contract.firstToolCompliant === true
		&& typeof contract.finalToolCompliant === 'boolean' && Number.isSafeInteger(contract.completedChecks) && contract.completedChecks >= 1
		&& (contract.completedChecks < 2 || !contract.finalToolCompliant)
		&& typeof remainingMs === 'number' && Number.isFinite(remainingMs) && remainingMs >= 15_000;
}

export function codexThreadId(events: Record<string, unknown>[]) {
	const id = events.find(event => event.type === 'thread.started')?.thread_id;
	return typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id) ? id : null;
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
	return `[features]\ncode_mode_host = true\n\n[mcp_servers.treedx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([process.argv[1],'--treedx-mcp'])}\nrequired = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n\n[mcp_servers.treedx.env]\n${Object.entries(values).map(([key,value])=>`${key} = ${JSON.stringify(value)}`).join('\n')}\n`;
}

export async function invokeTreeDxRelay(tool:string,arguments_:Record<string,unknown>,environment:NodeJS.ProcessEnv=process.env,timeoutMs=30_000){
	const relayUrl=text(environment.TREESEED_RELAY_URL),sandboxId=text(environment.TREESEED_SANDBOX_ID),operationToken=text(environment.TREESEED_GUEST_TOKEN),caPath=text(environment.TREESEED_RELAY_CA);
	if(!relayUrl||!sandboxId||!operationToken||!caPath) throw new Error('TreeDX MCP relay environment is incomplete.');
	if(!Number.isFinite(timeoutMs)||timeoutMs<=0) throw new Error('assignment_execution_budget_exhausted');
	const encoded=Buffer.from(JSON.stringify({tool,arguments:arguments_})),url=new URL(relayUrl),ca=await readFile(caPath);
	return new Promise<unknown>((resolve,reject)=>{const request=httpsRequest({hostname:url.hostname,port:Number(url.port),ca,signal:AbortSignal.timeout(Math.floor(timeoutMs)),servername:'treeseed-sandbox-relay',method:'POST',path:`/${'v1'}/sandboxes/${encodeURIComponent(sandboxId)}/tools/treedx`,headers:{authorization:`Bearer ${operationToken}`,'content-type':'application/json','content-length':String(encoded.byteLength)}},(response)=>{let body='';response.setEncoding('utf8');response.on('data',(chunk)=>{body+=chunk;});response.on('end',()=>{try{const value=body?JSON.parse(body):{};(response.statusCode??500)<400?resolve(value):reject(new Error(String(value.error??`TreeDX relay returned ${response.statusCode}.`)));}catch(error){reject(error);}});});request.once('error',reject);request.end(encoded);});
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

export function providerResourceAbort(events: Record<string, unknown>[], providerFailed: boolean) {
	// A completed provider turn may have handled an inner-tool failure. Preserve
	// that event as evidence; it does not establish failure of the whole workload.
	if (!providerFailed) return null;
	for (const event of events) {
		const item = record(event.item);
		if (text(event.type) !== 'item.completed' || text(item.type) !== 'command_execution') continue;
		const exitCode = Number(item.exit_code), output = text(item.aggregated_output);
		const killed = exitCode === 137 && /(?:^|\n)Killed(?:\n|$)/u.test(output);
		const heapExhausted = exitCode === 134 && /(?:heap out of memory|allocation failed|reached heap limit)/iu.test(output);
		if (killed || heapExhausted) {
			return { exitCode, command: text(item.command) };
		}
	}
	return null;
}

/** Report fixed execution categories only; never tool arguments, reasoning, or output. */
export function providerExecutionProgress(event: Record<string, unknown>) {
	const item = record(event.item);
	if (['item.started', 'item.completed'].includes(text(event.type)) && item.type === 'mcp_tool_call') {
		return `provider.tool.${event.type === 'item.started' ? 'started' : 'completed'}`;
	}
	if (event.type === 'item.completed' && item.type === 'reasoning') return 'provider.reasoning.completed';
	if (event.type === 'turn.started') return 'provider.turn.started';
	if (event.type === 'turn.completed') return 'provider.turn.completed';
	if (item.type !== 'command_execution' || !['item.started', 'item.completed'].includes(text(event.type))) return null;
	const command = text(item.command);
	const category = /\bnpm\s+run\s+release:verify\b/u.test(command) ? 'release-checks'
		: /\bnpm\s+(?:run\s+)?build(?::dist)?\b/u.test(command) ? 'build'
			: /\bnpm\s+pack\b/u.test(command) ? 'pack'
				: /\b(?:vitest|npm\s+(?:run\s+)?test(?::[a-z-]+)?)\b/u.test(command) ? 'tests'
					: /\bgit\s+(?:status|diff|log|show|rev-parse)\b/u.test(command) ? 'git-inspection' : 'other';
	return `provider.command.${event.type === 'item.started' ? 'started' : 'completed'}.${category}${typeof item.exit_code === 'number' ? `.exit-${item.exit_code}` : ''}`;
}

/** Keep completion evidence replayable: one validation command or pipeline, never a shell workflow or source mutation. */
export async function runModelWorkload() {
	const started = process.hrtime.bigint(), usageBefore = process.resourceUsage();
	await progress('guest.started');
	const assignment = sandboxAssignmentSchema.parse(JSON.parse(await readFile(resolve(inputRoot, 'assignment.json'), 'utf8')));
	let executionDeadlineAt: string | null = null;
	const getRemainingMs = () => remainingExecutionMs(assignment.resources.durationSeconds, Number(process.hrtime.bigint() - started) / 1e6, executionDeadlineAt);
	const execute = withinAssignmentBudget(run, getRemainingMs);
	await progress('assignment.verified');
	const sandboxId = (await readFile(resolve(inputRoot, 'sandbox-id'), 'utf8')).trim(), operationToken = (await readFile(resolve(inputRoot, 'operation-token'), 'utf8')).trim();
	const assignmentProxy = `http://${encodeURIComponent(sandboxId)}:${encodeURIComponent(operationToken)}@10.89.0.1:7444`;
	const context = record(JSON.parse(await readFile('/workspace/.treeseed/context.json', 'utf8')));
	const modelRequest = record(JSON.parse(await readFile('/workspace/.treeseed/model-request.json', 'utf8')));
	if (typeof modelRequest.prompt !== 'string' || !modelRequest.prompt.trim()) throw new Error('prepared_model_request_required');
	// Exclude materialization from active usage; retain original timer/deadline bounds.
	const productiveStarted = process.hrtime.bigint();
	const relayEnvironment = { TREESEED_RELAY_URL: assignment.network.relayUrl, TREESEED_SANDBOX_ID: sandboxId,
		TREESEED_GUEST_TOKEN: operationToken, TREESEED_RELAY_CA: '/workspace/.treeseed/relay-ca.crt' };
	// Reuse the same API clock, without counting a trusted runtime read as a model check.
	executionDeadlineAt = text(record(await invokeTreeDxRelay('treeseed_time_status', {}, relayEnvironment, Math.min(30_000, getRemainingMs()))).deadlineAt);
	getRemainingMs();
	await mkdir('/workspace/project', { recursive: true, mode: 0o700 });
	await progress('inputs.ready');
	if (assignment.contextManifestDigest !== assignment.inputs.find((input) => input.id === 'execution-context')?.digest || assignment.identityManifestDigest !== objectDigest(record(record(context.identity).manifest))) throw new Error('Guest context or identity manifest does not match the signed assignment.');
	const sourceText = await readFile(resolve(inputRoot, 'source.json'), 'utf8').catch(() => null);
	const sourceMetadata = sourceText ? record(JSON.parse(sourceText)) : null;
	const source = sourceMetadata ? sourceWorkspaceKeySchema.parse(sourceMetadata.source) : null;
	const canonicalActivity = text(record(record(record(context.canonicalAssignmentContext).assignment).effectiveProfile).activity);
	const canonicalAssignment = record(record(context.canonicalAssignmentContext).assignment);
	const allowVerification = activityAllowsVerification(canonicalActivity, text(canonicalAssignment.agentClass),
		text(record(canonicalAssignment.workspace).mode), canonicalAssignment.acceptanceCriteria);
	if (source) {
		if (source.teamId !== assignment.teamId || source.projectId !== assignment.projectId) throw new Error('Attached source does not match assignment scope.');
		const head = (await execute('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 128, timeoutMs: 10_000 })).stdout.trim();
		if (head !== source.commit) throw new Error('Attached source differs from its exact authorized commit.');
		context.projectManifest = { ...record(context.projectManifest), source, revision: head, mode: sourceMetadata?.mode, publication: sourceMetadata?.publication };
		if (allowVerification) {
			await progress('workspace.dependencies.starting');
			await prepareNodeWorkspace('/workspace/project', assignmentProxy, execute);
			await progress('workspace.dependencies.ready');
		}
	}
	const codexHome = '/workspace/.treeseed/codex', responsePath = '/workspace/.treeseed/response.md';
	let relay: Awaited<ReturnType<typeof startModelRelay>> | null = null;
	try {
	await mkdir(codexHome, { recursive: true, mode: 0o700 });
	await writeFile(resolve(codexHome,'config.toml'),codexTreeDxMcpConfig(sandboxId,operationToken,assignment),{mode:0o600});
	const subscriptionAuth = await readFile(resolve(inputRoot, 'codex-auth.json')).catch(() => null);
	if (assignment.network.allowedServices.includes('codex-subscription') && !subscriptionAuth) throw new Error('Authorized Codex subscription credential is missing from the guest input.');
	if (subscriptionAuth) {
		await writeFile(resolve(codexHome, 'auth.json'), subscriptionAuth, { mode: 0o600 });
		// Seed the protected return channel before model execution so a killed or
		// non-refreshing Codex process cannot strand the host credential updater.
		await writeFile(resolve(outputRoot, 'codex-auth.json'), subscriptionAuth, { mode: 0o600, flag: 'wx' });
	}
	validateModelContext(context);
	relay = subscriptionAuth ? null : await startModelRelay(assignment, sandboxId, operationToken);
	const subscriptionProxy = subscriptionAuth ? assignmentProxy : null;
	const reviewSecrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
	await progress('workspace.release-review-verification.starting');
	const releaseReview = await prepareReleaseReview(context, reviewSecrets, execute);
	await progress('workspace.release-review-verification.completed');
	const events: Record<string, unknown>[] = [], timingTracker: TimingAwarenessTracker = { completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false },
		composedPrompt = modelRequest.prompt;
	const structuredCompletion = (Boolean(canonicalActivity) && canonicalActivity !== 'chat')
		|| (sourceMetadata ? requiresActivityCompletion(sourceMetadata.mode) : false);
	const completionSchemaPath = resolve(codexHome, 'activity-completion.schema.json');
	const completionSchema = structuredCompletion ? planningSynthesisOutputSchema(context, activityCompletionOutputSchema(completionFrontmatterSchema(context), allowVerification,
		completionOutputTargetVariants(context), canonicalActivity === 'reviewing')) : undefined;
	if (structuredCompletion) await writeFile(completionSchemaPath, `${JSON.stringify(completionSchema)}\n`, { mode: 0o600 });
	// Session state stays inside this assignment's disposable Kata guest so a
	// missing final clock check can be corrected in the same Codex conversation.
	let providerInvocation = 0, providerThreadId: string | null = null, closeoutInterrupted = false;
	const providerEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: codexHome, CODEX_HOME: codexHome,
		...relayEnvironment,
		...(relay ? { OPENAI_BASE_URL: relay.baseUrl, OPENAI_API_KEY: 'treeseed-assignment-relay' } : {}),
		...(subscriptionProxy ? { HTTPS_PROXY: subscriptionProxy, https_proxy: subscriptionProxy } : {}), LANG: 'C.UTF-8' };
	// Provider hosts import clock evidence helpers from this module and contain no Codex packages.
	const { CodexWorkloadSession, codexUsageEvidence } = await import('./codex-sdk-session.ts');
	const session = new CodexWorkloadSession({ model: assignment.modelPolicy.model, reasoningEffort: assignment.modelPolicy.reasoningEffort,
		environment: providerEnvironment, remainingMs: getRemainingMs });
	const measuredUsage = () => {
		const finished = process.hrtime.bigint(), after = process.resourceUsage(), evidence = codexUsageEvidence(events);
		const observed = evidence ? evidence.complete ? evidence.observed : {} : record([...events].reverse().find(event => text(event.type).includes('completed'))?.usage);
		return { evidence, usage: { ...observed, provenance: Object.keys(observed).length ? 'execution-provider' : 'unavailable',
			activeSeconds: Number(finished - productiveStarted) / 1e9, elapsedSeconds: Number(finished - started) / 1e9,
			cpuUserMicros: after.userCPUTime - usageBefore.userCPUTime, cpuSystemMicros: after.systemCPUTime - usageBefore.systemCPUTime, peakRssBytes: after.maxRSS * 1024 } };
	};
		await progress('provider.starting');
		const invocationTimers = codexInvocationTimerOptions(getRemainingMs(), canonicalActivity);
		const providerError = await session.runTurn({
			input: composedPrompt, outputSchema: completionSchema, responsePath,
			...invocationTimers,
			canInterrupt: () => Boolean(providerThreadId && timingTracker.firstToolSucceeded && !codexToolInFlight(events)),
			onEvent(raw) { const event = scopeProviderEvent(raw, 0);
				providerThreadId ??= codexThreadId([event]);
				const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
				observeTimingAwarenessEvent(timingTracker, event); events.push(event); },
		}).then(() => null).catch(error => {
			if (error instanceof Error && error.message === 'codex_closeout_interrupted') { closeoutInterrupted = true; return null; }
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			const detail = providerFailureSummary(events, secrets);
			// Avoid leaking credentials through the subprocess stderr fallback too.
			const fallback = providerFailureSummary([{ type: 'error', message: error instanceof Error ? error.message : String(error) }], secrets);
			return new Error(`Codex execution failed: ${detail || fallback || 'no structured error was supplied'}`);
		});
		if (closeoutInterrupted) {
			const remainingMs = getRemainingMs();
			if (!providerThreadId || remainingMs < 20_000 || codexToolInFlight(events)) throw new Error('Codex turn ended without a safe bounded session continuation.');
			await progress('provider.closeout-recovery.starting');
			let finalCloseoutInterrupted = false;
			const resumeIdleTimeoutMs = codexResumeIdleTimeoutMs(remainingMs), closeoutInvocation = ++providerInvocation;
			await session.runTurn({
				responsePath, outputSchema: completionSchema,
				input: `The prior turn was interrupted to preserve closeout time after its completed tools. Continue this SAME assignment using only evidence already inspected. Do not repeat inspection or start new work. You have at most ${Math.floor(remainingMs / 1_000)} seconds including closeout; the original deadline has not moved. Your NEXT and FINAL tool action must call mcp__treedx__treeseed_time_status through functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. Then immediately produce ${structuredCompletion ? 'the required structured result' : 'the substantive discussion reply'}. If evidence is insufficient, say so honestly rather than waiting for the deadline.`,
				timeoutMs: Math.floor(remainingMs),
				...(canonicalActivity === 'estimating' ? { ...(resumeIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: resumeIdleTimeoutMs }),
					canInterrupt: () => timingTracker.firstToolSucceeded && !codexToolInFlight(events) } : {}),
				onEvent(raw) { const event = scopeProviderEvent(raw, closeoutInvocation);
					const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); },
			}).catch(error => {
				if (error instanceof Error && error.message === 'codex_closeout_interrupted') { finalCloseoutInterrupted = true; return; }
				throw error;
			});
			if (finalCloseoutInterrupted) {
				const finalRemainingMs = getRemainingMs(), finalCloseoutInvocation = ++providerInvocation;
				if (!providerThreadId || finalRemainingMs < 25_000 || codexToolInFlight(events)) throw new Error('Codex estimate closeout has no safe remaining continuation.');
				await progress('provider.final-closeout-recovery.starting');
				await session.runTurn({
					responsePath, outputSchema: completionSchema,
					input: `This is the FINAL continuation of the same estimating assignment. The original deadline has not moved. Use only evidence already inspected; do not inspect or run another command. You have at most ${Math.floor(finalRemainingMs / 1_000)} seconds. Call mcp__treedx__treeseed_time_status once through functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. Then immediately return the required compact estimate JSON. If evidence is incomplete, state the uncertainty in the rationale and finish now.`,
					timeoutMs: Math.floor(finalRemainingMs),
					onEvent(raw) { const event = scopeProviderEvent(raw, finalCloseoutInvocation);
					const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); },
				});
				await progress('provider.final-closeout-recovery.completed');
			}
			await progress('provider.closeout-recovery.completed');
		}
		if (subscriptionAuth) {
			const refreshed = await readFile(resolve(codexHome, 'auth.json'));
			await writeFile(resolve(outputRoot, 'codex-auth.json'), refreshed, { mode: 0o600 });
		}
		await progress(providerError ? 'provider.failed' : 'provider.completed');
		const initialTiming = timingAwarenessContract(events);
		const remainingMs = getRemainingMs();
		const threadId = providerThreadId;
		if (!providerError && threadId && timingRecoveryEligible(initialTiming, remainingMs) && (await readFile(responsePath, 'utf8').catch(() => '')).trim()) {
			await progress('provider.final-clock-recovery.starting');
			const recoveryEvents: Record<string, unknown>[] = [], clockInvocation = ++providerInvocation;
			const recoverySchemaPath = resolve(codexHome, 'final-clock.schema.json');
			await writeFile(recoverySchemaPath, JSON.stringify({ type: 'object', properties: { ack: { type: 'string', const: 'done' } }, required: ['ack'], additionalProperties: false }), { mode: 0o600 });
			await session.runTurn({
				responsePath: resolve(codexHome, 'final-clock-response.txt'), outputSchema: JSON.parse(await readFile(recoverySchemaPath, 'utf8')),
				input: 'The substantive response was already captured. Do not inspect or change files and do not repeat the task. Your NEXT and ONLY tool action must call mcp__treedx__treeseed_time_status using functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. After the successful clock result, return {"ack":"done"} without any other tool action.',
				timeoutMs: Math.floor(remainingMs),
				onEvent(raw) { const event = scopeProviderEvent(raw, clockInvocation);
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); recoveryEvents.push(event); },
			});
			const recoveryTiming = timingAwarenessContract(recoveryEvents);
			if (!recoveryTiming.firstToolCompliant || !recoveryTiming.finalToolCompliant
				|| recoveryEvents.some(event => providerToolName(event) && providerToolName(event) !== 'treedx:treeseed_time_status')) {
				throw new Error('Final clock recovery performed an unauthorized tool action or failed to check remaining time.');
			}
			if (subscriptionAuth) {
				const refreshed = await readFile(resolve(codexHome, 'auth.json'));
				await writeFile(resolve(outputRoot, 'codex-auth.json'), refreshed, { mode: 0o600 });
			}
			await progress('provider.final-clock-recovery.completed');
		}
		const planningInvocation = ++providerInvocation;
		if (!providerError && structuredCompletion && await recoverPlanningSynthesis({ context, activity: canonicalActivity, threadId,
			responsePath, outputSchema: completionSchema, allowVerification, remainingMs: getRemainingMs,
			execute: session.runTurn.bind(session), progress,
			onEvent(raw) { const event=scopeProviderEvent(raw,planningInvocation); observeTimingAwarenessEvent(timingTracker, event); events.push(event); },
			verifyClock(correctionEvents) { const correction = timingAwarenessContract(correctionEvents);
				if (!correction.firstToolCompliant || !correction.finalToolCompliant || correctionEvents.some((event) => providerToolName(event) && providerToolName(event) !== 'treedx:treeseed_time_status')) throw new Error('Planning synthesis correction failed its clock-only tool boundary.'); },
		}) && subscriptionAuth) {
			await writeFile(resolve(outputRoot, 'codex-auth.json'), await readFile(resolve(codexHome, 'auth.json')), { mode: 0o600 }); }
		const { clockWindow: _window, clockInvalid, completedClockItemIds: _clockIds, firstToolItemId: _firstId, firstToolPending: _firstPending, ...timingReceipt } = timingTracker;
		const timingAwareness = { schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const, requiredChecks: 2 as const, ...timingReceipt,
			firstToolCompliant: !clockInvalid && timingTracker.firstTool === 'treedx:treeseed_time_status' && timingTracker.firstToolSucceeded,
			finalToolCompliant: !clockInvalid && timingTracker.lastTool === 'treedx:treeseed_time_status' && timingTracker.lastToolSucceeded };
		if (timingAwareness.completedChecks < 2 || !timingAwareness.firstToolCompliant || !timingAwareness.finalToolCompliant) {
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			throw new Error(`Agent timing-awareness contract requires treeseed_time_status as the first and final tool actions with two completed checks. Provider errors: ${providerError?.message ?? (providerFailureSummary(events, secrets) || '(none)')}. Observed ${JSON.stringify(timingAwareness)}. Provider event shapes: ${JSON.stringify(providerEventShapeSummary(events, secrets))}. Response preview: ${providerResponsePreview(events, secrets) || '(empty)'}`);
		}
		let rawResponse = providerError ? '' : (await readFile(responsePath, 'utf8')).trim(); if (!providerError && !rawResponse) throw new Error('Execution provider returned an empty response.');
		const resourceAbort = providerResourceAbort(events, providerError !== null);
		if (resourceAbort) throw new Error(`sandbox_resource_exhausted: command exited ${resourceAbort.exitCode}: ${resourceAbort.command}`);
		const diagnosticSecrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : []), ...(subscriptionAuth ? providerCredentialValues(JSON.parse(await readFile(resolve(codexHome, 'auth.json'), 'utf8'))) : [])];
		const closeoutFailures: Array<{ message: string; code: unknown; response: string }> = [];
		let failureRetained = false;
		const closed = await closeModelProduct({
			complete: async () => {
			rawResponse = providerError ? '' : (await readFile(responsePath, 'utf8')).trim();
			const validatedCompletion = !providerError && structuredCompletion ? validateActivityCompletion(JSON.parse(rawResponse), allowVerification) : null;
			const correctedCompletion = validatedCompletion ? correctObservedTestFirstRedVerification(validatedCompletion, events,
				text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria) : null;
			const replayableCompletion = correctedCompletion ? omitUnreplayableVerification(correctedCompletion) : null;
			const observedCompletion = replayableCompletion ? releaseReview ? await releaseReview.complete(replayableCompletion)
				: await observeReportedActivityCommands(replayableCompletion, diagnosticSecrets, execute, canonicalAssignment) : null;
			const activityCompletion = attachObservedTesterFailures(observedCompletion?.report ?? null, events,
				text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria);
			if (!providerError) {
				assertArchitectSourceCitation(activityCompletion, source?.commit ?? null, text(canonicalAssignment.agentClass), canonicalActivity);
				assertTesterFailureEvidence(activityCompletion, text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria);
				assertPredecessorSynthesis(context, activityCompletion);
			}
			const responseMarkdown = activityCompletion?.summary ?? rawResponse;
			if (!providerError && sourceMetadata?.mode === 'work') {
				await assertCleanWorkSource(assignment.assignmentId, execute);
				// Candidate verification intentionally runs in a different Kata VM after the
				// execution VM has stopped. Flush the committed tree and Git object database
				// before returning success so that verifier reads cannot observe a newer ref
				// with stale worktree blocks from the executed overlay.
				await execute('/bin/sync', [], { timeoutMs: 30_000 });
			}
			const finalTiming = timingAwarenessContract(events);
			if (finalTiming.completedChecks < 2 || !finalTiming.firstToolCompliant || !finalTiming.finalToolCompliant) throw new Error('Agent timing-awareness contract requires first and final clock checks.');
			return { activityCompletion, observedCompletion, responseMarkdown };
			},
			canCorrect: () => !providerError && Boolean(providerThreadId) && !codexToolInFlight(events), remainingMs: getRemainingMs,
			correct: async (error, remaining) => {
				failureRetained = false; const invocation = ++providerInvocation;
				try { await session.runTurn({ responsePath, outputSchema: completionSchema, timeoutMs: Math.floor(remaining - 5_000),
					input: JSON.stringify({ type: 'activity-completion-rejected', validationFailure: { code: record(error).code,
						message: redactProviderDiagnostic(error, diagnosticSecrets) }, remainingSeconds: Math.floor(remaining / 1_000), deadlineAt: executionDeadlineAt }),
					onEvent(raw) { const event = scopeProviderEvent(raw, invocation); observeTimingAwarenessEvent(timingTracker, event); events.push(event); } }); } finally {
				if (subscriptionAuth) { const refreshed = await readFile(resolve(codexHome, 'auth.json'));
					await writeFile(resolve(outputRoot, 'codex-auth.json'), refreshed, { mode: 0o600 });
					diagnosticSecrets.push(...providerCredentialValues(JSON.parse(refreshed.toString('utf8')))); }
				}
			},
			retainFailure: async error => {
				failureRetained = false;
				closeoutFailures.push({ message: redactProviderDiagnostic(error, diagnosticSecrets), code: record(error).code ?? null,
					response: redactProviderDiagnostic(await readFile(responsePath, 'utf8').catch(() => ''), diagnosticSecrets) });
				const snapshot = measuredUsage();
				await writeFile(resolve(outputRoot, 'result.json'), JSON.stringify(sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1',
					sandboxId, assignmentId: assignment.assignmentId, status: 'failed', summary: redactProviderDiagnostic(error, diagnosticSecrets), artifacts: [],
					timingAwareness: timingAwarenessContract(events), usage: snapshot.usage,
					diagnostics: { providerEvents: redactProviderEvents(events, diagnosticSecrets), providerSdk: { package: '@openai/codex-sdk', threadId: session.id },
						providerUsageEvidence: snapshot.evidence, contextManifest: context, closeoutFailures,
						guestKernel: (await readFile('/proc/version', 'utf8')).trim(), guestUid: process.getuid?.() ?? null, sandboxProfile: assignment.profile }, teardown: { verified: false, completedAt: null } })), { mode: 0o600 });
				failureRetained = true;
			},
		}).catch(error => { if (!failureRetained) throw error; return null; });
		if (!closed) return; // A declared failed result must reach the broker through its normal zero-exit output path.
		const { activityCompletion, observedCompletion, responseMarkdown } = closed;
		const changedPaths = sourceMetadata?.mode === 'work' && source
			? (await execute('/usr/bin/git', ['diff', '--name-only', `${source.commit}..HEAD`], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 1_048_576, timeoutMs: 10_000 })).stdout.split('\n').map((path) => path.trim()).filter(Boolean)
			: [];
		const providerEventShapes = providerEventShapeSummary(events, diagnosticSecrets);
		const artifacts: Array<{ id: string; path: string; digest: string; mediaType: string; bytes: number }> = [];
		const snapshot = measuredUsage();
		const result = sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1', sandboxId, assignmentId: assignment.assignmentId,
			status: providerError ? 'failed' : 'completed', summary: providerError?.message ?? 'Kata assignment completed.', responseMarkdown: providerError ? undefined : responseMarkdown,
			artifacts, timingAwareness: timingAwarenessContract(events), usage: snapshot.usage,
			diagnostics: { systemPrompt: composedPrompt, providerEvents: redactProviderEvents(events, diagnosticSecrets), providerEventShapes,
				providerSdk: { package: '@openai/codex-sdk', threadId: session.id }, providerUsageEvidence: snapshot.evidence, closeoutFailures, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, contextManifest: context, activityCompletion,
				verificationRecords: observedCompletion?.verification ?? [], changedPaths,
				verificationObservations: redactProviderEvents((observedCompletion?.observations ?? []).map(value => ({ ...value })), diagnosticSecrets),
				sourceCommit: sourceMetadata?.mode === 'work' ? (await execute('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 128, timeoutMs: 10_000 })).stdout.trim() : source?.commit ?? null,
				guestKernel: (await readFile('/proc/version', 'utf8')).trim(), guestUid: process.getuid?.() ?? null, sandboxProfile: assignment.profile }, teardown: { verified: false, completedAt: null } });
		await writeFile(resolve(outputRoot, 'result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
	} finally { await rm(resolve(codexHome, 'auth.json'), { force: true }); await rm(resolve(codexHome,'config.toml'),{force:true}); await rm(resolve(codexHome,'activity-completion.schema.json'),{force:true}); await relay?.close(); }
}

if(process.argv.includes('--treedx-mcp')) runTreeDxMcpServer().catch((error)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1;});
else if (process.argv[1]?.endsWith('/kernel/handlers/model-workload.js')) runModelWorkload().catch(async (error) => {
	await mkdir(outputRoot, { recursive: true });
	await writeFile(resolve(outputRoot, 'failure.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`).catch(() => undefined);
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1;
});
