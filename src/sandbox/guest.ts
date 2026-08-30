import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sandboxAssignmentSchema, sandboxResultSchema, type SandboxAssignment } from '@treeseed/sdk/capacity-provider';

const inputRoot = '/run/treeseed-assignment';
const outputRoot = '/run/treeseed-output';
const workspaceRoot = '/workspace';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const objectDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

async function fileDigest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}


function run(executable: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; captureStdout?: boolean; maxStdoutBytes?: number } = {}) {
	return new Promise<{ stderr: string; stdout: string }>((accept, reject) => {
		const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }); let pending = '', stderr = '', stdout = '';
		child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => {
			const value = String(chunk);
			if (options.captureStdout) { stdout += value; if (Buffer.byteLength(stdout) > (options.maxStdoutBytes ?? 8_388_608)) child.kill('SIGKILL'); }
			pending += value; const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) options.onLine?.(line);
		});
		child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
		child.once('error', reject); child.once('exit', (code, signal) => { if (pending.trim()) options.onLine?.(pending); code === 0 ? accept({ stderr, stdout }) : reject(new Error(`${executable} exited ${code ?? signal}: ${stderr}`)); });
		child.stdin.end(options.input ?? '');
	});
}

async function materialize(assignment: SandboxAssignment) {
	for (const descriptor of assignment.inputs) {
		const source = resolve(inputRoot, `input-${descriptor.id}`), information = await stat(source);
		if (information.size !== descriptor.bytes || await fileDigest(source) !== descriptor.digest) throw new Error(`Signed input failed guest verification: ${descriptor.id}`);
		const target = resolve(descriptor.targetPath); if (!target.startsWith(`${workspaceRoot}/`)) throw new Error('Signed input target escaped the guest workspace.');
		await mkdir(descriptor.mediaType.endsWith('+tar') ? target : dirname(target), { recursive: true, mode: 0o700 });
		if (descriptor.mediaType === 'application/vnd.treeseed.directory+tar') await run('/bin/tar', ['--extract', '--file', source, '--directory', target, '--no-same-owner', '--no-same-permissions']);
		else if (descriptor.mediaType === 'application/json' || descriptor.mediaType === 'application/x-pem-file') await writeFile(target, await readFile(source), { mode: descriptor.disposition === 'read-only' ? 0o400 : 0o600 });
		else throw new Error(`Unsupported signed input media type: ${descriptor.mediaType}`);
		if (descriptor.disposition === 'read-only') { await run('/bin/chmod', ['-R', 'a-w', target]); await chmod(target, 0o500); }
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

function promptFromContext(context: Record<string, unknown>) {
	const identity = record(context.identity), manifest = record(identity.manifest), sources = Array.isArray(identity.sources) ? identity.sources.map(record) : [];
	const assignment = record(context.assignment), metadata = record(assignment.metadata), chatProfile = record(metadata.chatProfile), prompt = record(chatProfile.prompt), communication = record(metadata.communication);
	const sourceText = sources.map((source) => `## ${text(source.kind)}: ${text(source.path)}\nImmutable ref: ${text(source.immutableRef)}\nDigest: ${text(source.digest)}\n\n${text(source.content)}`).join('\n\n');
	const required = text(communication.requirement) !== 'optional';
	return `You are exactly ${text(manifest.agentHandle)}. Your verified immutable TreeDX identity sources follow.\n\n${sourceText}\n\nActivity task:\n${text(prompt.task) || 'Respond to the committed Discussion message.'}\n\n${required ? 'You were directly addressed and must provide a substantive response.' : 'Respond only if your role adds material value; otherwise return exactly <!-- treeseed:abstain -->.'}\nThe working directory is the exact project repository snapshot. The read-only TreeDX library is at /workspace/.treedx/library. Inspect repository files and AGENTS.md before answering. Do not inspect outside /workspace or disclose credentials. Return only the message to post.\n\nDiscussion message:\n${text(record(context.message).content)}`;
}

export async function runSandboxGuest() {
	const started = process.hrtime.bigint(), usageBefore = process.resourceUsage();
	const assignment = sandboxAssignmentSchema.parse(JSON.parse(await readFile(resolve(inputRoot, 'assignment.json'), 'utf8')));
	const sandboxId = (await readFile(resolve(inputRoot, 'sandbox-id'), 'utf8')).trim(), operationToken = (await readFile(resolve(inputRoot, 'operation-token'), 'utf8')).trim();
	await materialize(assignment); const context = record(JSON.parse(await readFile('/workspace/.treeseed/context.json', 'utf8')));
	if (assignment.contextManifestDigest !== assignment.inputs.find((input) => input.id === 'execution-context')?.digest || assignment.identityManifestDigest !== objectDigest(record(record(context.identity).manifest))) throw new Error('Guest context or identity manifest does not match the signed assignment.');
	const writableProject = assignment.inputs.some((input) => input.id === 'project-repository' && input.disposition === 'copy-on-write');
	if (writableProject) {
		await run('/usr/bin/git', ['init', '--quiet'], { cwd: '/workspace/project' });
		await run('/usr/bin/git', ['config', 'user.name', 'TreeSeed Assignment Baseline'], { cwd: '/workspace/project' });
		await run('/usr/bin/git', ['config', 'user.email', 'assignment-baseline@treeseed.invalid'], { cwd: '/workspace/project' });
		await run('/usr/bin/git', ['add', '--all'], { cwd: '/workspace/project' });
		await run('/usr/bin/git', ['commit', '--quiet', '--allow-empty', '-m', 'Immutable assignment baseline'], { cwd: '/workspace/project' });
	}
	const codexHome = '/workspace/.treeseed/codex', responsePath = '/workspace/.treeseed/response.md'; await mkdir(codexHome, { recursive: true, mode: 0o700 });
	const subscriptionAuth = await readFile(resolve(inputRoot, 'codex-auth.json')).catch(() => null);
	if (subscriptionAuth) await writeFile(resolve(codexHome, 'auth.json'), subscriptionAuth, { mode: 0o600 });
	const relay = subscriptionAuth ? null : await startModelRelay(assignment, sandboxId, operationToken);
	const events: Record<string, unknown>[] = [], composedPrompt = promptFromContext(context);
	const providerArguments = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--approve-for-me', ...(writableProject ? [] : ['--skip-git-repo-check']), '--model', assignment.modelPolicy.model,
		'--enable', 'code_mode_host', '--disable', 'browser_use', '--disable', 'apps', '--disable', 'multi_agent_v2', '--disable', 'image_generation', '--color', 'never', '--output-last-message', responsePath, '-C', '/workspace/project', '-'];
	try {
		await run('/usr/local/bin/codex', providerArguments, {
			cwd: '/workspace/project', input: composedPrompt, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: codexHome, CODEX_HOME: codexHome,
				...(relay ? { OPENAI_BASE_URL: relay.baseUrl, OPENAI_API_KEY: 'treeseed-assignment-relay' } : {}), LANG: 'C.UTF-8' },
			onLine(line) { try { events.push(record(JSON.parse(line))); } catch { events.push({ type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }); } },
		});
		const responseMarkdown = (await readFile(responsePath, 'utf8')).trim(); if (!responseMarkdown) throw new Error('Execution provider returned an empty response.');
		const artifacts: Array<{ id: string; path: string; digest: string; mediaType: string; bytes: number }> = [];
		if (writableProject) {
			const patch = (await run('/usr/bin/git', ['diff', '--binary', '--full-index', 'HEAD'], { cwd: '/workspace/project', captureStdout: true, maxStdoutBytes: assignment.outputs.find((output) => output.id === 'project-patch')?.maxBytes })).stdout;
			if (patch) {
				const patchPath = resolve(outputRoot, 'project.patch'); await writeFile(patchPath, patch, { mode: 0o600 });
				artifacts.push({ id: 'project-patch', path: '/run/treeseed-output/project.patch', digest: await fileDigest(patchPath), mediaType: 'application/vnd.treeseed.git-patch', bytes: Buffer.byteLength(patch) });
			}
		}
		const completed = [...events].reverse().find((event) => text(event.type).includes('completed')) ?? {}, elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9, usageAfter = process.resourceUsage();
		const result = sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1', sandboxId, assignmentId: assignment.assignmentId,
			status: responseMarkdown === '<!-- treeseed:abstain -->' ? 'completed' : 'completed', summary: 'Kata assignment completed.', responseMarkdown,
			artifacts, usage: { ...record(completed.usage), provenance: Object.keys(record(completed.usage)).length ? 'execution-provider' : 'unavailable', elapsedSeconds,
				cpuUserMicros: usageAfter.userCPUTime - usageBefore.userCPUTime, cpuSystemMicros: usageAfter.systemCPUTime - usageBefore.systemCPUTime, peakRssBytes: usageAfter.maxRSS * 1024 },
			diagnostics: { systemPrompt: composedPrompt, providerEvents: events, providerArguments, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, contextManifest: context,
				guestKernel: (await readFile('/proc/version', 'utf8')).trim(), guestUid: process.getuid?.() ?? null, sandboxProfile: assignment.profile }, teardown: { verified: false, completedAt: null } });
		await writeFile(resolve(outputRoot, 'result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
	} finally { await rm(resolve(codexHome, 'auth.json'), { force: true }); await relay?.close(); }
}

if (process.argv[1]?.endsWith('/sandbox/guest.js')) runSandboxGuest().catch(async (error) => {
	await mkdir(outputRoot, { recursive: true });
	await writeFile(resolve(outputRoot, 'failure.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`).catch(() => undefined);
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1;
});
