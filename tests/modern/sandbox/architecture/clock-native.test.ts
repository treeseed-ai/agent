import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
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
		const { input, attempt, execution } = clockRequest(), calls: Array<{ path: string; tool: string; arguments: Record<string, unknown> }> = [];
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
				try { outgoing.end(JSON.stringify(await executeAssignmentTreeDxTool(input, supplied.tool, supplied.arguments, started ? execution : undefined))); }
				catch (error) { outgoing.statusCode = 409; outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
			})().catch(error => { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: String(error) })); }); });
		});
		await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native TLS clock address required');
		const environment = { TREESEED_RELAY_URL: `https://127.0.0.1:${address.port}`, TREESEED_SANDBOX_ID: 'isolated-clock',
			TREESEED_GUEST_TOKEN: 'isolated-clock-token', TREESEED_RELAY_CA: cert };
		return { input, attempt, execution, calls, environment, set(code = 200, transportFault = '', productiveStarted = true) { status = code; fault = transportFault; started = productiveStarted; },
			read: (timeoutMs = 5_000) => invokeTreeDxRelay('treeseed_time_status', {}, environment, timeoutMs),
			close: async () => { server!.closeAllConnections(); try { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
				finally { await rm(directory, { recursive: true, force: true }); } } };
	} catch (error) { server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); await rm(directory, { recursive: true, force: true }); throw error; }
}
describe('native trusted guest clock relay and owning provider tool', () => {
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
			const responses: Array<{ jsonrpc: string; id: number; result: { content: Array<{ type: string; text: string }>; structuredContent: { startedAt: string; deadlineAt: string; remainingSeconds: number } } }> = output.stdout.trim().split('\n').map(line => JSON.parse(line));
			expect(responses.map(value => ({ jsonrpc: value.jsonrpc, id: value.id }))).toEqual(requests.map(({ jsonrpc, id }) => ({ jsonrpc, id })));
			for (const response of responses) {
				const value = response.result.structuredContent;
				expect(value).toMatchObject(f.execution); expect(response.result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }]);
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
