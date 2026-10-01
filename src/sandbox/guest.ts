import { run } from './process-runner.ts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sandboxAssignmentSchema, sandboxResultSchema, sourceWorkspaceKeySchema, type SandboxAssignment } from '@treeseed/sdk/capacity-provider/sandbox';
import { providerCredentialValues, providerFailureSummary, redactProviderDiagnostic } from './provider-failure.ts';
import { activityAllowsVerification } from './guest-contract.ts';
import { activityCompletionOutputSchema, validateActivityCompletion, type ActivityCompletionReport } from '../activity-completion.ts';
import { completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext, assertPredecessorSynthesis, assertArchitectSourceCitation, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTestFirstRedVerification, omitUnreplayableVerification, codexReasoningArguments, codexProjectInstructionArguments, codexInteractiveTimeoutMs, requiresActivityCompletion, reportedVerificationCommands, record, text, providerToolName, codexToolInFlight, codexIdleTimeoutMs, codexCloseoutTimeoutMs, codexResumeIdleTimeoutMs } from './guest-contract.ts';
import { recoverPlanningSynthesis } from './planning-synthesis-recovery.ts';

const inputRoot = '/run/treeseed-assignment';
const outputRoot = '/run/treeseed-output';
const workspaceRoot = '/workspace';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const objectDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const progress = (stage: string) => writeFile(resolve(outputRoot, 'progress.json'), `${JSON.stringify({ stage, occurredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
async function fileDigest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}

async function materialize(assignment: SandboxAssignment) {
	for (const descriptor of assignment.inputs) {
		try {
			await progress(`input.${descriptor.id}.stat`);
			const source = resolve(inputRoot, `input-${descriptor.id}`), information = await stat(source);
			if (information.size !== descriptor.bytes) throw new Error('signed size mismatch');
			await progress(`input.${descriptor.id}.hash`);
			if (await fileDigest(source) !== descriptor.digest) throw new Error('signed digest mismatch');
			const target = resolve(descriptor.targetPath); if (!target.startsWith(`${workspaceRoot}/`)) throw new Error('target escaped the guest workspace');
			await progress(`input.${descriptor.id}.copy`);
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
	{name:'treedx_read_files',description:'Read authorized TreeDX logical content identifiers. Supply the exact 40-character commit from an authorized predecessor reference when reviewing its output; omit ref for the pinned current view.',inputSchema:{type:'object',properties:{project:{type:'string'},ref:{type:'string',pattern:'^[a-f0-9]{40}$'},paths:{type:'array',items:{type:'string'},maxItems:20}},required:['paths'],additionalProperties:false}},
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

export function timingRecoveryEligible(contract: ReturnType<typeof timingAwarenessContract>, remainingMs: number) {
	// A model may make the second clock check, then use another tool. In that
	// case the final-tool boundary is still broken; one same-session clock-only
	// continuation can repair it without extending the allocator deadline.
	return contract.firstToolCompliant && (contract.completedChecks < 2 || !contract.finalToolCompliant)
		&& remainingMs >= 15_000;
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

/** Convert model-reported passing checks into runner-observed evidence. */
export async function verifyReportedActivityCommands(report: ActivityCompletionReport,
	execute: (command: string) => Promise<void> = async (command) => {
		await run('/bin/sh', ['-lc', command], { cwd: '/workspace/project', timeoutMs: 120_000 });
	}) {
	const commands = reportedVerificationCommands(report);
	for (const command of commands) {
		try { await execute(command); }
		catch { throw new Error(`Runner-observed verification failed: ${command}`); }
	}
	return report;
}

export async function observeReportedActivityCommands(report: ActivityCompletionReport, secrets: string[] = [], execute: typeof run = run) {
	const commands = reportedVerificationCommands(report);
	if (commands.some(requiresNodeDependencyRestore)
		&& await stat('/workspace/project/package-lock.json').then(() => true, () => false)
		&& !await stat('/workspace/project/node_modules/.bin/vitest').then(() => true, () => false)) {
		try { await run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
			{ cwd: '/workspace/project', timeoutMs: 120_000 }); }
		catch (error) {
			const exit = /exited (\d+)/u.exec(error instanceof Error ? error.message : String(error))?.[1] ?? 'unknown';
			throw new Error(`Runner verification dependency restore failed (exit ${exit}).`);
		}
	}
	const verification = [];
	for (const command of commands) {
		const started = process.hrtime.bigint(); let failedOutput = '';
		try {
			const output = await execute('/bin/sh', ['-lc', command], { cwd: '/workspace/project', captureStdout: true,
				maxStdoutBytes: 8_388_608, timeoutMs: 120_000,
				onLine: line => { failedOutput = `${failedOutput}\n${redactProviderDiagnostic(line, secrets)}`.slice(-1_024); } });
			verification.push({ command, status: 'passed' as const, exitCode: 0,
				outputDigest: objectDigest({ stdout: output.stdout, stderr: output.stderr }),
				durationSeconds: Math.ceil(Number(process.hrtime.bigint() - started) / 1e9) });
		} catch (error) {
			const exit = /exited (\d+)/u.exec(error instanceof Error ? error.message : String(error))?.[1] ?? 'unknown';
			throw new Error(`Runner-observed verification failed (exit ${exit}): ${redactProviderDiagnostic(command, secrets)}; ${redactProviderDiagnostic(error, secrets)}; ${failedOutput}`);
		}
	}
	return { report, verification };
}
export function requiresNodeDependencyRestore(command: string) {
	return /^(?:npm\s+(?:run|exec|test)(?:\s|$)|npx(?:\s|$))/u.test(command.trim());
}

export function providerResourceAbort(events: Record<string, unknown>[]) {
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

export async function prepareNodeWorkspace(
	root = '/workspace/project',
	proxyUrl?: string,
	execute: (executable: string, args: string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<unknown>
		= (executable, args, options) => run(executable, args, options),
) {
	const hasLock = await stat(resolve(root, 'package-lock.json')).then(() => true, () => false);
	const hasManifest = await stat(resolve(root, 'package.json')).then(() => true, () => false);
	const hasModules = await stat(resolve(root, 'node_modules')).then(() => true, () => false);
	if (!hasLock || !hasManifest || hasModules) return false;
	await execute('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
		cwd: root, timeoutMs: 120_000,
		...(proxyUrl ? { env: { ...process.env, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl } } : {}),
	});
	return true;
}

/** Keep completion evidence replayable: one validation command or pipeline, never a shell workflow or source mutation. */
export async function runSandboxGuest() {
	const started = process.hrtime.bigint(), usageBefore = process.resourceUsage();
	await progress('guest.started');
	const assignment = sandboxAssignmentSchema.parse(JSON.parse(await readFile(resolve(inputRoot, 'assignment.json'), 'utf8')));
	await progress('assignment.verified');
	const sandboxId = (await readFile(resolve(inputRoot, 'sandbox-id'), 'utf8')).trim(), operationToken = (await readFile(resolve(inputRoot, 'operation-token'), 'utf8')).trim();
	const assignmentProxy = `http://${encodeURIComponent(sandboxId)}:${encodeURIComponent(operationToken)}@10.89.0.1:7444`;
	await materialize(assignment); const context = record(JSON.parse(await readFile('/workspace/.treeseed/context.json', 'utf8')));
	await mkdir('/workspace/project', { recursive: true, mode: 0o700 });
	await progress('inputs.ready');
	if (assignment.contextManifestDigest !== assignment.inputs.find((input) => input.id === 'execution-context')?.digest || assignment.identityManifestDigest !== objectDigest(record(record(context.identity).manifest))) throw new Error('Guest context or identity manifest does not match the signed assignment.');
	const sourceText = await readFile(resolve(inputRoot, 'source.json'), 'utf8').catch(() => null);
	const sourceMetadata = sourceText ? record(JSON.parse(sourceText)) : null;
	const source = sourceMetadata ? sourceWorkspaceKeySchema.parse(sourceMetadata.source) : null;
	const canonicalActivity = text(record(record(record(context.canonicalAssignmentContext).assignment).effectiveProfile).activity);
	const canonicalAssignment = record(record(context.canonicalAssignmentContext).assignment);
	const allowVerification = activityAllowsVerification(canonicalActivity, text(canonicalAssignment.agentClass),
		text(record(canonicalAssignment.workspace).mode));
	if (source) {
		if (source.teamId !== assignment.teamId || source.projectId !== assignment.projectId) throw new Error('Attached source does not match assignment scope.');
		const head = (await run('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: 128, timeoutMs: 10_000 })).stdout.trim();
		if (head !== source.commit) throw new Error('Attached source differs from its exact authorized commit.');
		context.projectManifest = { ...record(context.projectManifest), source, revision: head, mode: sourceMetadata?.mode, publication: sourceMetadata?.publication };
		if (allowVerification) {
			await progress('workspace.dependencies.starting');
			await prepareNodeWorkspace('/workspace/project', assignmentProxy);
			await progress('workspace.dependencies.ready');
		}
	}
	const codexHome = '/workspace/.treeseed/codex', responsePath = '/workspace/.treeseed/response.md'; await mkdir(codexHome, { recursive: true, mode: 0o700 });
	await writeFile(resolve(codexHome,'config.toml'),codexTreeDxMcpConfig(sandboxId,operationToken,assignment),{mode:0o600});
	const subscriptionAuth = await readFile(resolve(inputRoot, 'codex-auth.json')).catch(() => null);
	if (assignment.network.allowedServices.includes('codex-subscription') && !subscriptionAuth) throw new Error('Authorized Codex subscription credential is missing from the guest input.');
	if (subscriptionAuth) {
		await writeFile(resolve(codexHome, 'auth.json'), subscriptionAuth, { mode: 0o600 });
		// Seed the protected return channel before model execution so a killed or
		// non-refreshing Codex process cannot strand the host credential updater.
		await writeFile(resolve(outputRoot, 'codex-auth.json'), subscriptionAuth, { mode: 0o600, flag: 'wx' });
	}
	const relay = subscriptionAuth ? null : await startModelRelay(assignment, sandboxId, operationToken);
	const subscriptionProxy = subscriptionAuth ? assignmentProxy : null;
	const events: Record<string, unknown>[] = [], timingTracker: TimingAwarenessTracker = { completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false },
		composedPrompt = promptFromContext(context, assignment.modelPolicy.reasoningEffort, assignment.resources.durationSeconds);
	const structuredCompletion = (Boolean(canonicalActivity) && canonicalActivity !== 'chat')
		|| (sourceMetadata ? requiresActivityCompletion(sourceMetadata.mode) : false);
	const completionSchemaPath = resolve(codexHome, 'activity-completion.schema.json');
	if (structuredCompletion) {
		await writeFile(completionSchemaPath, `${JSON.stringify(activityCompletionOutputSchema(completionFrontmatterSchema(context), allowVerification,
			completionOutputTargetVariants(context), canonicalActivity === 'reviewing'))}\n`, { mode: 0o600 });
	}
	// Session state stays inside this assignment's disposable Kata guest so a
	// missing final clock check can be corrected in the same Codex conversation.
	const providerArguments = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--model', assignment.modelPolicy.model,
		...codexReasoningArguments(assignment.modelPolicy.reasoningEffort),
		...codexProjectInstructionArguments(),
		...(structuredCompletion ? ['--output-schema', completionSchemaPath] : []),
		'--disable', 'browser_use', '--disable', 'apps', '--disable', 'multi_agent_v2', '--disable', 'image_generation', '--color', 'never', '--output-last-message', responsePath, '-C', '/workspace/project', '-'];
	let providerError: Error | null = null, providerThreadId: string | null = null, closeoutInterrupted = false;
	const providerEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: codexHome, CODEX_HOME: codexHome,
		TREESEED_RELAY_URL:assignment.network.relayUrl,TREESEED_SANDBOX_ID:sandboxId,TREESEED_GUEST_TOKEN:operationToken,TREESEED_RELAY_CA:'/workspace/.treeseed/relay-ca.crt',
		...(relay ? { OPENAI_BASE_URL: relay.baseUrl, OPENAI_API_KEY: 'treeseed-assignment-relay' } : {}),
		...(subscriptionProxy ? { HTTPS_PROXY: subscriptionProxy, https_proxy: subscriptionProxy } : {}), LANG: 'C.UTF-8' };
	try {
		await progress('provider.starting');
		await run('/usr/local/bin/codex', providerArguments, {
			cwd: '/workspace/project', input: composedPrompt, env: providerEnvironment,
			timeoutMs: codexInteractiveTimeoutMs(assignment.resources.durationSeconds),
			idleTimeoutMs: canonicalActivity === 'estimating' ? codexIdleTimeoutMs(assignment.resources.durationSeconds) : undefined,
			closeoutTimeoutMs: canonicalActivity === 'chat' || canonicalActivity === 'estimating'
				? codexCloseoutTimeoutMs(assignment.resources.durationSeconds, canonicalActivity) : undefined,
			canInterrupt: () => Boolean(providerThreadId && timingTracker.firstToolSucceeded && !codexToolInFlight(events)),
			onLine(line) { let event: Record<string, unknown>; try { event = record(JSON.parse(line)); } catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
				providerThreadId ??= codexThreadId([event]);
				const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
				observeTimingAwarenessEvent(timingTracker, event); events.push(event); if (events.length > 256) events.shift(); },
		}).catch(error => {
			if (error instanceof Error && error.message === 'codex_closeout_interrupted') { closeoutInterrupted = true; return; }
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			const detail = providerFailureSummary(events, secrets);
			// Avoid leaking credentials through the subprocess stderr fallback too.
			const fallback = providerFailureSummary([{ type: 'error', message: error instanceof Error ? error.message : String(error) }], secrets);
			providerError = new Error(`Codex execution failed: ${detail || fallback || 'no structured error was supplied'}`);
		});
		if (closeoutInterrupted) {
			const remainingMs = assignment.resources.durationSeconds * 1_000 - Number(process.hrtime.bigint() - started) / 1e6 - 5_000;
			if (!providerThreadId || remainingMs < 20_000 || codexToolInFlight(events)) throw new Error('Codex turn ended without a safe bounded session continuation.');
			await progress('provider.closeout-recovery.starting');
			const resumeArguments = ['exec', 'resume', providerThreadId, '--json', '--dangerously-bypass-approvals-and-sandbox', '--model', assignment.modelPolicy.model,
				...codexReasoningArguments(assignment.modelPolicy.reasoningEffort), ...codexProjectInstructionArguments(),
				...(structuredCompletion ? ['--output-schema', completionSchemaPath] : []),
				'--output-last-message', responsePath, '-'];
			let finalCloseoutInterrupted = false;
			await run('/usr/local/bin/codex', resumeArguments, {
				cwd: '/workspace/project', env: providerEnvironment,
				input: `The prior turn was interrupted to preserve closeout time after its completed tools. Continue this SAME assignment using only evidence already inspected. Do not repeat inspection or start new work. You have at most ${Math.floor(remainingMs / 1_000)} seconds including closeout; the original deadline has not moved. Your NEXT and FINAL tool action must call mcp__treedx__treeseed_time_status through functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. Then immediately produce ${structuredCompletion ? 'the required structured result' : 'the substantive discussion reply'}. If evidence is insufficient, say so honestly rather than waiting for the deadline.`,
				timeoutMs: Math.floor(remainingMs),
				...(canonicalActivity === 'estimating' ? { idleTimeoutMs: codexResumeIdleTimeoutMs(remainingMs),
					canInterrupt: () => timingTracker.firstToolSucceeded && !codexToolInFlight(events) } : {}),
				onLine(line) { let event: Record<string, unknown>; try { event = record(JSON.parse(line)); } catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
					const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); if (events.length > 256) events.shift(); },
			}).catch(error => {
				if (error instanceof Error && error.message === 'codex_closeout_interrupted') { finalCloseoutInterrupted = true; return; }
				throw error;
			});
			if (finalCloseoutInterrupted) {
				const finalRemainingMs = assignment.resources.durationSeconds * 1_000 - Number(process.hrtime.bigint() - started) / 1e6 - 5_000;
				if (!providerThreadId || finalRemainingMs < 25_000 || codexToolInFlight(events)) throw new Error('Codex estimate closeout has no safe remaining continuation.');
				await progress('provider.final-closeout-recovery.starting');
				await run('/usr/local/bin/codex', resumeArguments, {
					cwd: '/workspace/project', env: providerEnvironment,
					input: `This is the FINAL continuation of the same estimating assignment. The original deadline has not moved. Use only evidence already inspected; do not inspect or run another command. You have at most ${Math.floor(finalRemainingMs / 1_000)} seconds. Call mcp__treedx__treeseed_time_status once through functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. Then immediately return the required compact estimate JSON. If evidence is incomplete, state the uncertainty in the rationale and finish now.`,
					timeoutMs: Math.floor(finalRemainingMs),
					onLine(line) { let event: Record<string, unknown>; try { event = record(JSON.parse(line)); } catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
					const executionProgress = providerExecutionProgress(event); if (executionProgress) void progress(executionProgress).catch(() => undefined);
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); if (events.length > 256) events.shift(); },
				});
				await progress('provider.final-closeout-recovery.completed');
			}
			await progress('provider.closeout-recovery.completed');
		}
		if (subscriptionAuth) {
			const refreshed = await readFile(resolve(codexHome, 'auth.json'));
			await writeFile(resolve(outputRoot, 'codex-auth.json'), refreshed, { mode: 0o600 });
		}
		if (providerError) throw providerError;
		await progress('provider.completed');
		const initialTiming = timingAwarenessContract(events);
		const remainingMs = assignment.resources.durationSeconds * 1_000 - Number(process.hrtime.bigint() - started) / 1e6 - 5_000;
		const threadId = providerThreadId;
		if (threadId && timingRecoveryEligible(initialTiming, remainingMs) && (await readFile(responsePath, 'utf8').catch(() => '')).trim()) {
			await progress('provider.final-clock-recovery.starting');
			const recoveryEvents: Record<string, unknown>[] = [];
			const recoverySchemaPath = resolve(codexHome, 'final-clock.schema.json');
			await writeFile(recoverySchemaPath, JSON.stringify({ type: 'object', properties: { ack: { type: 'string', const: 'done' } }, required: ['ack'], additionalProperties: false }), { mode: 0o600 });
			const recoveryArguments = ['exec', 'resume', threadId, '--json', '--dangerously-bypass-approvals-and-sandbox', '--model', assignment.modelPolicy.model,
				...codexReasoningArguments(assignment.modelPolicy.reasoningEffort), ...codexProjectInstructionArguments(),
				'--output-schema', recoverySchemaPath, '--output-last-message', resolve(codexHome, 'final-clock-response.txt'), '-'];
			await run('/usr/local/bin/codex', recoveryArguments, {
				cwd: '/workspace/project', env: providerEnvironment,
				input: 'The substantive response was already captured. Do not inspect or change files and do not repeat the task. Your NEXT and ONLY tool action must call mcp__treedx__treeseed_time_status using functions.exec with: text(await tools.mcp__treedx__treeseed_time_status({}));. After the successful clock result, return {"ack":"done"} without any other tool action.',
				timeoutMs: Math.floor(remainingMs),
				onLine(line) { let event: Record<string, unknown>; try { event = record(JSON.parse(line)); } catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
					observeTimingAwarenessEvent(timingTracker, event); events.push(event); recoveryEvents.push(event); if (events.length > 256) events.shift(); },
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
		if (structuredCompletion && await recoverPlanningSynthesis({ context, activity: canonicalActivity, threadId,
			responsePath, schemaPath: completionSchemaPath, allowVerification, durationSeconds: assignment.resources.durationSeconds,
			started, model: assignment.modelPolicy.model, reasoningEffort: assignment.modelPolicy.reasoningEffort,
			providerEnvironment, progress,
			onEvent(event) { observeTimingAwarenessEvent(timingTracker, event); events.push(event); if (events.length > 256) events.shift(); },
			verifyClock(correctionEvents) { const correction = timingAwarenessContract(correctionEvents);
				if (!correction.firstToolCompliant || !correction.finalToolCompliant || correctionEvents.some((event) => providerToolName(event) && providerToolName(event) !== 'treedx:treeseed_time_status')) throw new Error('Planning synthesis correction failed its clock-only tool boundary.'); },
		}) && subscriptionAuth) {
			await writeFile(resolve(outputRoot, 'codex-auth.json'), await readFile(resolve(codexHome, 'auth.json')), { mode: 0o600 }); }
		const timingAwareness = { schemaVersion: 'treeseed.assignment-timing-awareness/v1' as const, requiredChecks: 2 as const, ...timingTracker,
			firstToolCompliant: timingTracker.firstTool === 'treedx:treeseed_time_status' && timingTracker.firstToolSucceeded,
			finalToolCompliant: timingTracker.lastTool === 'treedx:treeseed_time_status' && timingTracker.lastToolSucceeded };
		if (timingAwareness.completedChecks < 2 || !timingAwareness.firstToolCompliant || !timingAwareness.finalToolCompliant) {
			const secrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
			throw new Error(`Agent timing-awareness contract requires treeseed_time_status as the first and final tool actions with two completed checks. Provider errors: ${providerFailureSummary(events, secrets) || '(none)'}. Observed ${JSON.stringify(timingAwareness)}. Provider event shapes: ${JSON.stringify(providerEventShapeSummary(events, secrets))}. Response preview: ${providerResponsePreview(events, secrets) || '(empty)'}`);
		}
		const rawResponse = (await readFile(responsePath, 'utf8')).trim(); if (!rawResponse) throw new Error('Execution provider returned an empty response.');
		const resourceAbort = providerResourceAbort(events);
		if (resourceAbort) throw new Error(`sandbox_resource_exhausted: command exited ${resourceAbort.exitCode}: ${resourceAbort.command}`);
		const validatedCompletion = structuredCompletion ? validateActivityCompletion(JSON.parse(rawResponse), allowVerification) : null;
		const correctedCompletion = validatedCompletion ? correctObservedTestFirstRedVerification(validatedCompletion, events,
			text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria) : null;
		const replayableCompletion = correctedCompletion ? omitUnreplayableVerification(correctedCompletion) : null;
		const diagnosticSecrets = [operationToken, ...(subscriptionAuth ? providerCredentialValues(JSON.parse(subscriptionAuth.toString('utf8'))) : [])];
		const observedCompletion = replayableCompletion ? await observeReportedActivityCommands(replayableCompletion, diagnosticSecrets) : null;
		const activityCompletion = attachObservedTesterFailures(observedCompletion?.report ?? null, events,
			text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria);
		assertArchitectSourceCitation(activityCompletion, source?.commit ?? null, text(canonicalAssignment.agentClass), canonicalActivity);
		assertTesterFailureEvidence(activityCompletion, text(canonicalAssignment.agentClass), canonicalActivity, canonicalAssignment.acceptanceCriteria);
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
