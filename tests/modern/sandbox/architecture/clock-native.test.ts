import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { sandboxAssignmentSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { objectDigest } from '../../../../src/sandbox/verification.ts';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { completedTimeStatusChecks, invokeTreeDxRelay, timingAwarenessContract } from '../../../../src/sandbox/guest.ts';
import { clockRequest } from './clock-fixture.ts';

// Existing guest HTTPS relay plus owning provider clock tool, not mocked
// requests. Supplied execution time is NOT independently retrieved API time,
// model use of the readings, broker token policy, Kata or physical teardown.
async function nativeClock() {
	const directory = await mkdtemp(join(tmpdir(), 'agent-native-clock-')), key = join(directory, 'relay.key'), cert = join(directory, 'relay.crt');
	let server: ReturnType<typeof createServer> | undefined;
	try {
		// Ordinary fixture TLS certificate; missing openssl fails explicitly.
		// Do not disable certificate validation or use released runtime credentials.
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
			'-subj', '/CN=treeseed-sandbox-relay', '-addext', 'subjectAltName=DNS:treeseed-sandbox-relay'], { stdio: 'ignore' });
		const { input, attempt, execution } = clockRequest(), calls: Array<{ path: string; tool: string; arguments: Record<string, unknown> }> = [], readings: unknown[] = [];
		let status = 200, fault = '', started = true;
		server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
			let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += chunk; });
			incoming.on('end', () => { void (async () => {
				const supplied: { tool: string; arguments: Record<string, unknown> } = JSON.parse(body);
				calls.push({ path: incoming.url ?? '', ...supplied });
				if (incoming.headers.authorization !== 'Bearer isolated-clock-token' || incoming.url !== '/v1/sandboxes/isolated-clock/tools/treedx') {
					outgoing.writeHead(403); outgoing.end(JSON.stringify({ error: 'controlled token or sandbox denied' })); return;
				}
				if (fault === 'reset') { incoming.socket.destroy(); return; }
				outgoing.statusCode = status; outgoing.setHeader('content-type', 'application/json');
				if (fault === 'json') { outgoing.end('{'); return; }
				if (status >= 400) { outgoing.end(JSON.stringify({ error: 'controlled clock read denied' })); return; }
				try { const value = await executeAssignmentTreeDxTool(input, supplied.tool, supplied.arguments, started ? execution : undefined);
					readings.push(structuredClone(value)); outgoing.end(JSON.stringify(value)); }
				catch (error) { outgoing.statusCode = 409; outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
			})().catch(error => { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: String(error) })); }); });
		});
		await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native TLS clock address required');
		const environment = { TREESEED_RELAY_URL: `https://127.0.0.1:${address.port}`, TREESEED_SANDBOX_ID: 'isolated-clock',
			TREESEED_GUEST_TOKEN: 'isolated-clock-token', TREESEED_RELAY_CA: cert };
		return { directory, cert, input, attempt, execution, calls, readings, environment, set(code = 200, transportFault = '', productiveStarted = true) { status = code; fault = transportFault; started = productiveStarted; },
			read: (timeoutMs = 5_000) => invokeTreeDxRelay('treeseed_time_status', {}, environment, timeoutMs),
			close: async () => { server!.closeAllConnections(); try { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
				finally { await rm(directory, { recursive: true, force: true }); } } };
	} catch (error) { server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); await rm(directory, { recursive: true, force: true }); throw error; }
}
describe('native trusted guest clock relay and owning provider tool', () => {
	it('native whole guest retains first and final clock bytes across a long provider stream and cannot forget an early killed command', async () => {
		const outcomes: Array<{ mode: string; failure: string; events: Record<string, unknown>[]; clockValues: unknown[]; retainedPrivateFiles: string[] }> = [];
		for (const mode of ['completed', 'resource-abort', 'invalid-context', 'missing-subscription']) {
			const f = await nativeClock();
			try {
				const input = join(f.directory, 'input'), output = join(f.directory, 'output'), workspace = join(f.directory, 'workspace');
				for (const path of [input, output, join(workspace, 'project')]) await mkdir(path, { recursive: true });
				await symlink(resolve('node_modules'), join(workspace, 'project/node_modules'));
				const context = { identity: { manifest: {} }, canonicalAssignmentContext: { assignment: {
					...f.attempt, workspace: { mode: 'read-only' }, effectiveProfile: { activity: 'chat', handler: 'writer',
						prompt: { system: 'Controlled native fixture only.' } },
				}, predecessorResults: [], context: [{ ref: f.attempt.sourceRef, value: { frontmatter: {
					executionPlan: { workItems: [{ id: f.attempt.workItemId, agentClass: f.attempt.agentClass }] },
				} } }] } };
				if (mode === 'invalid-context') context.canonicalAssignmentContext.context = [];
				const bytes = Buffer.from(JSON.stringify(context)), digest = (value: Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
				await writeFile(join(input, 'input-execution-context'), bytes); await copyFile(f.cert, join(input, 'input-relay-ca'));
				const ca = await readFile(f.cert);
				const assignment = sandboxAssignmentSchema.parse({ schemaVersion: 'treeseed.sandbox-assignment/v1',
					assignmentId: f.attempt.id, attempt: f.attempt.attempt, runnerId: 'native-fixture', providerId: f.attempt.provider.providerId,
					teamId: f.attempt.teamId, projectId: f.attempt.projectId, profile: 'configured-chat', guestImage: 'controlled-input', guestImageDigest: digest(bytes),
					identityManifestDigest: objectDigest(context.identity.manifest), contextManifestDigest: digest(bytes),
					resources: { cpuCores: 1, memoryBytes: 536870912, diskBytes: 67108864, durationSeconds: 30, processLimit: 32, outputBytes: 1048576 },
					inputs: [{ id: 'execution-context', digest: digest(bytes), bytes: bytes.length, disposition: 'copy-on-write', mediaType: 'application/json',
						targetPath: '/workspace/.treeseed/context.json' }, { id: 'relay-ca', digest: digest(ca), bytes: ca.length, disposition: 'copy-on-write',
						mediaType: 'application/x-pem-file', targetPath: '/workspace/.treeseed/relay-ca.crt' }], outputs: [],
					network: { defaultDeny: true, relayUrl: f.environment.TREESEED_RELAY_URL, allowedServices: ['treedx'] },
					modelPolicy: { provider: 'controlled-native-input', model: 'not-a-real-model', capabilities: [] }, credentialHandles: [], treeDxHandleIds: [],
					leaseExpiresAt: f.attempt.deadline, signature: { keyId: 'controlled-native-input', algorithm: 'Ed25519', value: 'supplied-not-issued' } });
				if (mode === 'missing-subscription') assignment.network.allowedServices.push('codex-subscription');
				const held = JSON.stringify(assignment); await writeFile(join(input, 'assignment.json'), held);
				await writeFile(join(input, 'sandbox-id'), 'isolated-clock'); await writeFile(join(input, 'operation-token'), 'isolated-clock-token');
				await writeFile(join(input, 'stream-mode'), mode);
				const provider = resolve('tests/modern/sandbox/fixtures/clock-stream-provider.ts'), executable = join(input, 'codex');
				const providerInput = (await readFile(provider, 'utf8')).replace("'../../../../src/sandbox/guest.ts'", JSON.stringify(resolve('src/sandbox/guest.ts')));
				await writeFile(executable, ts.transpileModule(providerInput, { compilerOptions: {
					target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
				} }).outputText);
				await chmod(executable, 0o755);
				// Namespace mounts only allocated writable roots. Never write the
				// guest's fixed paths on the host or invoke its released Codex image.
				let failure = '';
				try { await promisify(execFile)('bwrap', ['--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session', '--tmpfs', '/',
					'--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc',
					'--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--tmpfs', '/tmp', '--tmpfs', '/usr/local/bin',
					'--ro-bind', resolve('..'), resolve('..'), '--ro-bind', dirname(dirname(process.execPath)), dirname(dirname(process.execPath)),
					'--ro-bind', input, '/run/treeseed-assignment', '--bind', output, '/run/treeseed-output', '--bind', workspace, '/workspace',
					'--ro-bind', process.execPath, '/usr/local/bin/node', '--ro-bind', executable, '/usr/local/bin/codex',
					'--chdir', process.cwd(), process.execPath, '--import', 'tsx', provider, '--guest'],
					{ timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
				} catch (error) { failure = error instanceof Error ? error.message : String(error); }
				let events: Record<string, unknown>[] = [];
				const resultPath = join(output, 'result.json');
				try { const result = sandboxResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')));
					if (!Array.isArray(result.diagnostics.providerEvents)) throw new Error('Native raw event array required');
					events = result.diagnostics.providerEvents;
					if (mode === 'completed') expect(result.timingAwareness).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
				} catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
				const retainedPrivateFiles: string[] = [];
				for (const name of ['auth.json', 'config.toml', 'activity-completion.schema.json']) {
					try { await stat(join(workspace, '.treeseed/codex', name)); retainedPrivateFiles.push(name); }
					catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
				}
				outcomes.push({ mode, failure, events, clockValues: structuredClone(f.readings.slice(1)), retainedPrivateFiles });
				expect(await readFile(join(input, 'assignment.json'), 'utf8')).toBe(held);
				expect(await readFile(join(input, 'input-execution-context'))).toEqual(bytes);
				expect(f.calls).toEqual(Array.from({ length: mode === 'invalid-context' || mode === 'missing-subscription' ? 1 : 3 },
					() => ({ path: '/v1/sandboxes/isolated-clock/tools/treedx', tool: 'treeseed_time_status', arguments: {} })));
				if (mode === 'invalid-context' || mode === 'missing-subscription') {
					await expect(stat(join(output, 'provider-invoked'))).rejects.toMatchObject({ code: 'ENOENT' });
					await expect(stat(resultPath)).rejects.toMatchObject({ code: 'ENOENT' });
				} else expect((await stat(join(output, 'provider-invoked'))).isFile()).toBe(true);
			} finally { await f.close(); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' }); }
		}
		expect(outcomes[0]!.failure, outcomes.map(value => `${value.mode}: ${value.failure}`).join('\n')).toBe('');
		const summary = outcomes.slice(0, 2).map(value => ({ mode: value.mode, rawEvents: value.events.length,
			retainedClocks: completedTimeStatusChecks(value.events), resourceFailure: value.failure.includes('sandbox_resource_exhausted: command exited 137') }));
		expect(summary, JSON.stringify(summary))
			.toEqual([{ mode: 'completed', rawEvents: 302, retainedClocks: 2, resourceFailure: false },
				{ mode: 'resource-abort', rawEvents: 0, retainedClocks: 0, resourceFailure: true }]);
		expect(outcomes[0]!.events).toHaveLength(302);
		for (const [index, id] of [[0, 'original-first-clock'], [301, 'original-final-clock']] as const) {
			const value = outcomes[0]!.clockValues[index === 0 ? 0 : 1];
			expect(outcomes[0]!.events[index]).toEqual({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx',
				tool: 'treeseed_time_status', status: 'completed', error: null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } });
		}
		expect(timingAwarenessContract(outcomes[0]!.events)).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
		expect(outcomes[1]!.failure).toContain('sandbox_resource_exhausted: command exited 137'); expect(outcomes[1]!.events).toEqual([]);
		expect(outcomes[2]!.failure).toContain('assignment_exact_proposal_context_required'); expect(outcomes[2]!.events).toEqual([]);
		expect(outcomes[3]!.failure).toContain('Authorized Codex subscription credential is missing'); expect(outcomes[3]!.events).toEqual([]);
		for (const outcome of outcomes) expect(outcome.retainedPrivateFiles,
			JSON.stringify(outcomes.map(value => ({ mode: value.mode, retainedPrivateFiles: value.retainedPrivateFiles })))).toEqual([]);
	}, 30_000);
	it('native public guest MCP clock transports exact first and final HTTPS values and rejects corrupted observed payloads without rewriting native bytes', async () => {
		const f = await nativeClock(); try {
			const inputBefore = structuredClone(f.input.assignment), entrypoint = resolve('src/sandbox/guest.ts'), sourceBefore = await readFile(entrypoint);
			const requests = [1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'treeseed_time_status', arguments: {} } }));
			const began = Date.now();
			// Async child is the ORIGINAL public guest --treedx-mcp mode; the parent
			// must keep serving HTTPS. Missing native tools/dependencies fail, no build.
			const output = await new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
				const child = execFile(process.execPath, ['--import', 'tsx', entrypoint, '--treedx-mcp'], {
					env: { ...process.env, ...f.environment }, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576, encoding: 'utf8',
				}, (error, stdout, stderr) => error ? reject(error) : accept({ stdout, stderr }));
				child.stdin!.end(requests.map(value => JSON.stringify(value)).join('\n') + '\n');
			});
			const ended = Date.now(); expect(output.stderr).toBe('');
			const responses: Array<{ jsonrpc: string; id: number; result: { content: Array<{ type: string; text: string }>; structuredContent: { startedAt: string; deadlineAt: string; remainingSeconds: number; observedAt: string } } }> = output.stdout.trim().split('\n').map(line => JSON.parse(line));
			expect(responses.map(value => ({ jsonrpc: value.jsonrpc, id: value.id }))).toEqual(requests.map(({ jsonrpc, id }) => ({ jsonrpc, id })));
			for (const response of responses) {
				const value = response.result.structuredContent;
				expect(value).toMatchObject(f.execution); expect(response.result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }]);
				expect(typeof value.observedAt).toBe('string'); const observed = Date.parse(value.observedAt);
				expect(observed).toBeGreaterThanOrEqual(began); expect(observed).toBeLessThanOrEqual(ended);
				expect(value.remainingSeconds).toBe(Math.max(0, Math.ceil((Date.parse(f.attempt.deadline) - observed) / 1000)));
				expect(Number.isInteger(value.remainingSeconds)).toBe(true);
				expect(value.remainingSeconds).toBeGreaterThanOrEqual(Math.max(0, Math.ceil((Date.parse(f.attempt.deadline) - ended) / 1_000)));
				expect(value.remainingSeconds).toBeLessThanOrEqual(Math.max(0, Math.ceil((Date.parse(f.attempt.deadline) - began) / 1_000)));
			}
			expect(responses[1]!.result.structuredContent.remainingSeconds).toBeLessThanOrEqual(responses[0]!.result.structuredContent.remainingSeconds);
			const event = (result: unknown) => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null, result } });
			const events = responses.map(value => event(value.result)), nativeBefore = structuredClone(responses);
			expect(completedTimeStatusChecks(events)).toBe(2); expect(timingAwarenessContract(events)).toMatchObject({ completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true });
			const corruptions: unknown[] = [undefined, {}, { ...responses[1]!.result, structuredContent: {} },
				{ ...responses[1]!.result, content: [{ type: 'text', text: '{}' }] }, { ...responses[1]!.result, isError: true }];
			const admitted = corruptions.map(result => { const observed = [event(responses[0]!.result), event(result)], contract = timingAwarenessContract(observed);
				return completedTimeStatusChecks(observed) >= 2 || (contract.completedChecks >= 2 && contract.firstToolCompliant && contract.finalToolCompliant); });
			expect(admitted).toEqual(corruptions.map(() => false)); expect(responses).toEqual(nativeBefore);
			expect(f.calls).toEqual(requests.map(() => ({ path: '/v1/sandboxes/isolated-clock/tools/treedx', tool: 'treeseed_time_status', arguments: {} })));
			expect(f.input.assignment).toEqual(inputBefore); expect(await readFile(entrypoint)).toEqual(sourceBefore);
			// Event wrappers/corruptions are INPUTS. This exercises actual MCP/TLS/
			// provider tool composition, NOT actual Codex model actions or API issuance.
		} finally { await f.close(); }
	});
	it('native trusted clock rejects caller supplied authority and retains denial before exact empty argument retry', async () => {
		const f = await nativeClock(); try {
			const before = structuredClone(f.input.assignment), authority = structuredClone(f.execution), observations: unknown[] = [];
			const fields = ['now', 'observedAt', 'startedAt', 'deadlineAt', 'remainingSeconds', 'executionSeconds', 'closeoutSeconds'];
			for (const field of fields) {
				const args = { [field]: field.endsWith('Seconds') ? 1 : authority.startedAt }, held = structuredClone(args);
				try { observations.push({ admitted: true, value: await invokeTreeDxRelay('treeseed_time_status', args, f.environment, 5000) }); }
				catch (error) { observations.push({ admitted: false, message: error instanceof Error ? error.message : String(error) }); }
				expect(args).toEqual(held);
			}
			expect(observations).toHaveLength(fields.length);
			for (const value of observations) expect(value).toMatchObject({ admitted: false, message: expect.stringContaining('Clock tool does not accept caller supplied arguments') });
			const retained = structuredClone(observations), calls = structuredClone(f.calls);
			const began = Date.now(), retry = await f.read(), ended = Date.now(); expect(retry).toMatchObject(authority);
			if (!retry || typeof retry !== 'object' || !('observedAt' in retry)) throw new Error('Actual retry clock timestamp required.');
			expect(Date.parse(String(retry.observedAt))).toBeGreaterThanOrEqual(began); expect(Date.parse(String(retry.observedAt))).toBeLessThanOrEqual(ended);
			expect(f.calls.slice(0, -1)).toEqual(calls); expect(f.calls.at(-1)?.arguments).toEqual({}); expect(observations).toEqual(retained);
			expect(f.input.assignment).toEqual(before); expect(f.execution).toEqual(authority);
		} finally { await f.close(); }
	});
	it('independently reads first and final native HTTPS clock values against unchanged original bounds with no model compliance claim', async () => {
		const f = await nativeClock(); try {
			const before = structuredClone(f.input.assignment), readings: unknown[] = [];
			for (let index = 0; index < 2; index++) {
				const began = Date.now(), value = await f.read(), ended = Date.now(); readings.push(value);
				expect(value).toMatchObject(f.execution);
				if (!value || typeof value !== 'object' || !('remainingSeconds' in value)) throw new Error('Missing native remaining time');
				expect(typeof value.remainingSeconds).toBe('number');
				expect(value.remainingSeconds).toBeGreaterThanOrEqual(Math.max(0, Math.ceil((Date.parse(f.attempt.deadline) - ended) / 1000)));
				expect(value.remainingSeconds).toBeLessThanOrEqual(Math.max(0, Math.ceil((Date.parse(f.attempt.deadline) - began) / 1000)));
			}
			expect(readings).toHaveLength(2); expect(f.calls).toEqual(Array.from({ length: 2 }, () => ({ path: '/v1/sandboxes/isolated-clock/tools/treedx', tool: 'treeseed_time_status', arguments: {} })));
			expect(f.input.assignment).toEqual(before);
		} finally { await f.close(); }
	});
	it('native preparation denial authorization error reset and malformed clock never becomes a successful first or final check', async () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['preparation', 'denied', 'unavailable', 'reset', 'json']) {
			const f = await nativeClock(); try {
				f.set(mutation === 'denied' ? 403 : mutation === 'unavailable' ? 503 : 200,
					mutation === 'reset' || mutation === 'json' ? mutation : '', mutation !== 'preparation');
				const before = structuredClone(f.input.assignment); try { await f.read(); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.calls).toHaveLength(1); expect(f.input.assignment).toEqual(before); expect(timingAwarenessContract([]).completedChecks).toBe(0);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(5).fill(true));
	});
	it('exhausted caller windows and missing private relay authority deny before opening native clock transport', async () => {
		const f = await nativeClock(); try {
			await expect(f.read(0)).rejects.toThrow('assignment_execution_budget_exhausted');
			await expect(invokeTreeDxRelay('treeseed_time_status', {}, { ...f.environment, TREESEED_GUEST_TOKEN: '' })).rejects.toThrow('relay environment is incomplete');
			await expect(invokeTreeDxRelay('treeseed_time_status', {}, { ...f.environment, TREESEED_RELAY_CA: '/missing/isolated-clock-ca' })).rejects.toThrow();
			expect(f.calls).toEqual([]);
		} finally { await f.close(); }
	});
});
