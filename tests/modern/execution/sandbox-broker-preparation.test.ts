import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { sandboxAssignmentSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider';
import { remainingPreparationMs, SandboxBrokerClient } from '../../../src/provider/execution/sandbox-broker-client.ts';
import { createMicrovmExecutor, startSandboxToolPump } from '../../../src/provider/execution/microvm-executor.ts';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';
import { initializeCapacityProviderIdentity } from '../../../src/provider/accounts/identity.ts';
import type { ProviderHostRuntimeConfig } from '../../../src/provider/configuration/config.ts';
import { request as executionRequest, timingAwareness, digest } from '../kernel/provider-kernel-fixture.ts';
import { nativeCloseoutTransport } from '../kernel/architecture/portable/portable-kernel-fixture.ts';

describe('sandbox broker preparation authority', () => {
	it('uses the API-issued preparation deadline instead of an independent fifteen-second cutoff', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now)).toBe(60_000);
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now + 44_999)).toBe(15_001);
	});
	it('fails closed when the authoritative preparation window is missing or expired', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(() => remainingPreparationMs('', now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now - 1).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
	});
});

async function broker(handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const directory = await mkdtemp(join(tmpdir(), 'agent-broker-transport-'));
	const socket = join(directory, 'broker.sock');
	const server = createServer(handle);
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
	return { client: new SandboxBrokerClient(socket), directory, server, async close() {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true, force: true });
	} };
}

// Original executor, signer, OS custody, native materialization and Unix HTTP.
// Replies are controlled broker INPUTS, not actual Kata/host physical proof.
async function microvmBroker() {
	const paths: string[] = [], uploads = new Map<string, Buffer>();
	const observations: Array<ReturnType<typeof sandboxResultSchema.parse>> = [];
	let assigned: ReturnType<typeof sandboxAssignmentSchema.parse> | undefined, destroyedAt = '', beginCalls = 0, finishCalls = 0;
	let resultPatch: Record<string, unknown> = {}, destroyReply: unknown, destroyFault = '', artifactBytes = Buffer.from('original artifact\n');
	const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
	const fixture = await broker((request, response) => {
		const path = request.url ?? ''; paths.push(`${request.method} ${path}`); const chunks: Buffer[] = [];
		request.on('data', chunk => { chunks.push(Buffer.from(chunk)); }); request.on('end', () => {
			try {
				const bytes = Buffer.concat(chunks); response.setHeader('content-type', 'application/json');
				if (path === '/v1/sandboxes') {
					assigned = sandboxAssignmentSchema.parse(JSON.parse(bytes.toString('utf8')).assignment);
					response.end('{"sandboxId":"owned-native-sandbox","operationToken":"controlled-native-operation"}'); return;
				}
				if (request.method === 'PUT' && path.includes('/inputs/')) { uploads.set(path.split('/').at(-1)!, bytes); response.end('{}'); return; }
				if (path.endsWith('/tool-requests/next')) { response.end('{"request":null}'); return; }
				if (path.endsWith('/execute')) {
					if (!assigned) throw new Error('Original prepare required');
					const window = { startedAt: new Date(Date.parse(assigned.leaseExpiresAt) - 30_000).toISOString(), deadlineAt: assigned.leaseExpiresAt };
					const clock = (id: string, remainingSeconds: number) => { const value = { ...window, remainingSeconds }; return {
						type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
							result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
					const result = sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1', sandboxId: 'owned-native-sandbox', assignmentId: assigned.assignmentId,
						status: 'completed', summary: 'Controlled complete native result', timingAwareness, artifacts: [],
						usage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3 },
						diagnostics: { providerEvents: [clock('initial', 30), clock('final', 29)] },
						teardown: { verified: false, completedAt: null }, ...resultPatch });
					observations.push(structuredClone(result));
					response.end(JSON.stringify(result)); return;
				}
				if (path.includes('/artifacts/')) { response.end(artifactBytes); return; }
				if (request.method === 'DELETE') {
					destroyedAt = new Date().toISOString();
					if (destroyFault === 'reset') { request.socket.destroy(); return; }
					if (destroyFault === 'json') { response.end('{'); return; }
					if (destroyFault === '403' || destroyFault === '503') { response.statusCode = Number(destroyFault); response.end(JSON.stringify({ error: `original destroy ${destroyFault}` })); return; }
					response.end(JSON.stringify(destroyReply ?? { sandboxId: 'owned-native-sandbox', destroyed: true, teardown: { verified: true, completedAt: destroyedAt } })); return;
				}
				response.statusCode = 500; response.end('{"error":"Unexpected native broker operation"}');
			} catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Native input failed' })); }
		});
	});
	const previousCustodyKey = process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE;
	let custodyKey: string | undefined;
	const close = async () => {
		try { await fixture.close(); }
		finally {
			if (custodyKey && process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE === custodyKey) {
				if (previousCustodyKey === undefined) delete process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE;
				else process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE = previousCustodyKey;
			}
		}
	};
	try {
		// The relay CA remains the required original host input. Only this fresh
		// fixture identity uses an allocated mode-0600 OS custody key; no host
		// provider secret is read, changed, or used as test authority.
		const relayBytes = await readFile('/etc/treeseed/sandbox/relay-ca.crt');
		custodyKey = join(fixture.directory, 'identity-custody-key');
		await writeFile(custodyKey, randomBytes(32), { mode: 0o600 });
		process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE = custodyKey;
		const manifest = createManagedProviderManifestV5({ release: 'native-executor-input', guestImage: 'isolated/guest',
			guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
		manifest.sandbox.brokerSocket = join(fixture.directory, 'broker.sock');
		manifest.identity.privateKeyRef = 'data://native-executor-identity';
		await initializeCapacityProviderIdentity({ ref: manifest.identity.privateKeyRef, baseDirectory: fixture.directory, dataDirectory: fixture.directory });
		const adapter = manifest.adapters[0], binding = adapter?.offers[0];
		if (!adapter || !binding) throw new Error('Original managed offer binding required');
		const config: ProviderHostRuntimeConfig = { dataDir: fixture.directory, manifestPath: join(fixture.directory, 'manifest.yaml'), environment: 'local',
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null, env: {}, redactedEnv: {} };
		const executor = await createMicrovmExecutor(config, manifest, adapter), input = executionRequest(), createdAt = new Date().toISOString();
		const attempt = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), createdAt,
			deadline: new Date(Date.parse(createdAt) + 30_000).toISOString(), workspace: { mode: 'read-only' }, contextRefs: [],
			grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
			provider: { ...assignmentAttemptSchema.parse(input.assignment.assignmentAttempt).provider, offerId: binding.offer.offerId } });
		input.assignment = { id: attempt.id, assignmentAttempt: attempt, workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] },
			capacityProviderId: attempt.provider.providerId, teamId: attempt.teamId, projectId: attempt.projectId, attemptCount: attempt.attempt,
			leaseExpiresAt: attempt.deadline, capacityEnvelope: { budget: { time: { preparationDeadlineAt: attempt.deadline } } } };
		input.beginExecution = async () => { beginCalls++; return { capacityEnvelope: { budget: { time: { executionStartedAt: createdAt, executionDeadlineAt: attempt.deadline } } } }; };
		input.finishExecution = async () => { finishCalls++; }; input.emit = async event => { events.push({ type: event.type, payload: event.payload }); };
		return { ...fixture, close, executor, input, paths, uploads, events, relayBytes, manifest, observations,
			assignment: () => assigned, counters: () => ({ beginCalls, finishCalls }), destroyedAt: () => destroyedAt,
			patchResult(value: Record<string, unknown>) { resultPatch = value; },
			patchDestroy(value: unknown, fault = '') { destroyReply = value; destroyFault = fault; },
			artifact(value: Buffer) { artifactBytes = Buffer.from(value); } };
	} catch (error) { await close(); throw error; }
}

describe('sandbox broker control transport', () => {
	it('native microvm Kernel and provider runner retain original successful and failed executor measurements through exact public delivery and denied closeout', async () => {
		for (const mode of ['completed', 'failed', 'expired', 'diagnostic-denied', 'settlement-denied'] as const) {
			const f = await microvmBroker(); let api: Awaited<ReturnType<typeof nativeCloseoutTransport>> | undefined;
			try {
				const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt), before = structuredClone(f.input.assignment);
				const clock = (id: string, remainingSeconds: number) => {
					const value = { startedAt: attempt.createdAt, deadlineAt: attempt.deadline, remainingSeconds };
					return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status',
						status: 'completed', error: null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } };
				};
				f.patchResult({ ...(mode === 'failed' || mode === 'expired' ? { status: mode } : {}),
					usage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3, provenance: 'execution-provider' },
					diagnostics: { providerEvents: [clock('original-first-clock', 30), clock('original-final-clock', 29)] } });
				api = await nativeCloseoutTransport({ attempt, input: f.input, executor: f.executor }, f.directory, true);
				if (mode === 'diagnostic-denied') api.deny('reportUsage', 403); if (mode === 'settlement-denied') api.deny('settleAssignment', 503);
				let failure: unknown; try { await api.run(); } catch (error) { failure = error; }
				expect(f.observations, failure instanceof Error ? failure.message : String(api.requests.find(item => item.operation === 'failAssignment')?.body.message ?? 'Native executor observation required')).toHaveLength(1); const raw = structuredClone(f.observations[0]!);
				const diagnosticEvents = api.requests.filter(item => item.operation === 'createEvent'
					&& ['provider.execution.completed', 'provider.execution.failed'].includes(String(item.body.eventType)));
				expect(diagnosticEvents).toHaveLength(1);
				expect(diagnosticEvents[0]!.body).toMatchObject({ leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
					protectedPayload: raw.diagnostics });
				expect(Number.isInteger(diagnosticEvents[0]!.body.sequence)).toBe(true);
				expect(Object.hasOwn(diagnosticEvents[0]!.body.context ?? {}, 'providerEvents')).toBe(false);
				const usage = { activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3,
					provenance: 'execution-provider', nativeUsage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3 } };
				expect(raw.usage).toEqual({ ...usage.nativeUsage, provenance: 'execution-provider' });
				expect(api.requests.filter(item => item.operation === 'reportUsage')).toEqual([{ operation: 'reportUsage',
					key: `usage:${attempt.id}:${f.input.runnerId}:0`, body: { leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
						usageDimension: 'diagnostic-0', accountingMode: 'informational', activeSeconds: 0, elapsedSeconds: 0, usageActual: usage } }]);
				const held = (await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id);
				expect(held?.closeoutOutput).toMatchObject({ sandboxId: raw.sandboxId, teardown: { verified: true, completedAt: f.destroyedAt() }, artifacts: [] });
				expect(held?.dispatchEnvelope).toEqual(api.lease.dispatchEnvelope); expect(held?.leaseExpiresAt).toBe(attempt.deadline);
				if (mode.endsWith('denied')) {
					expect(failure).toBeInstanceOf(Error);
					expect(api.requests.some(item => ['completeAssignment', 'returnAssignment', 'failAssignment'].includes(item.operation))).toBe(false);
					if (mode === 'diagnostic-denied') expect(api.requests.some(item => item.operation === 'settleAssignment')).toBe(false);
				} else {
					expect(failure).toBeUndefined();
					if (mode === 'failed') {
						expect(api.requests.filter(item => item.operation === 'failAssignment')).toEqual([{ operation: 'failAssignment',
							key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
							body: { leaseToken: f.input.leaseToken, runnerId: f.input.runnerId, code: 'sandbox_failed',
								message: raw.summary, retryable: false, activeSeconds: 2, elapsedSeconds: 3, usage,
								output: { sandboxId: raw.sandboxId, teardown: { verified: true, completedAt: f.destroyedAt() } } } }]);
						expect(api.requests.some(item => item.operation === 'settleAssignment')).toBe(false);
					} else {
						expect(api.requests.filter(item => item.operation === 'settleAssignment')).toEqual([{ operation: 'settleAssignment',
							key: `assignment-settlement:${attempt.id}:${f.input.runnerId}`, body: { activeSeconds: 2, elapsedSeconds: 3,
								usageDimension: 'aggregate', usageActual: usage } }]);
						const terminal = mode === 'expired' ? 'returnAssignment' : 'completeAssignment';
						expect(api.requests.filter(item => item.operation === terminal)).toHaveLength(1);
						const operations = api.requests.map(item => item.operation);
						expect(operations.indexOf('reportUsage')).toBeLessThan(operations.indexOf('settleAssignment'));
						expect(operations.indexOf('settleAssignment')).toBeLessThan(operations.indexOf(terminal));
					}
				}
				expect(f.observations).toEqual([raw]); expect(f.input.assignment).toEqual(before);
				expect(f.paths.filter(path => path.endsWith('/execute'))).toHaveLength(1);
				expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
				for (const descriptor of f.assignment()!.inputs) {
					const bytes = f.uploads.get(descriptor.id); expect(bytes?.length).toBe(descriptor.bytes);
					expect(`sha256:${createHash('sha256').update(bytes!).digest('hex')}`).toBe(descriptor.digest);
				}
			} finally { try { await api?.close(); } finally { await f.close(); } }
			expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
		}
	});
	it('native original microvm execution materializes exact inputs and retains measured result only after its owning verified destroy receipt', async () => {
		const f = await microvmBroker(); try {
			const before = structuredClone(f.input.assignment), result = await f.executor.execute(f.input), assigned = f.assignment();
			if (!assigned) throw new Error('Actual native signed assignment required');
			expect(result.status).toBe('completed'); expect(result.outputs?.sandboxId).toBe('owned-native-sandbox');
			expect(result.outputs?.teardown).toEqual({ verified: true, completedAt: f.destroyedAt() });
			expect(result.usage).toEqual([{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3,
				nativeUsage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3 } }]);
			expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 }); expect(f.input.assignment).toEqual(before);
			expect(assigned.assignmentId).toBe(f.input.assignmentId); expect(assigned.providerId).toBe('provider-1');
			expect(assigned.resources.durationSeconds).toBeLessThanOrEqual(30); expect(assigned.leaseExpiresAt).toBe(assignmentAttemptSchema.parse(before.assignmentAttempt).deadline);
			for (const descriptor of assigned.inputs) {
				const bytes = f.uploads.get(descriptor.id); expect(bytes).toBeDefined();
				expect(bytes?.length).toBe(descriptor.bytes); expect(`sha256:${createHash('sha256').update(bytes!).digest('hex')}`).toBe(descriptor.digest);
			}
			expect(f.uploads.get('relay-ca')).toEqual(f.relayBytes);
			const context = JSON.parse(f.uploads.get('execution-context')!.toString('utf8'));
			expect(context.canonicalAssignmentContext.assignment).toEqual({ ...assignmentAttemptSchema.parse(before.assignmentAttempt), status: 'running' });
			expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			expect(f.events.filter(event => event.type === 'execution.completed')).toHaveLength(1);
		} finally { await f.close(); }
		expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('native original microvm refuses foreign result correlations and preserves owning closeout and exact observed usage without a passing event', async () => {
		for (const patch of [{ sandboxId: 'foreign-sandbox' }, { assignmentId: 'foreign-assignment' }]) {
			const f = await microvmBroker(); try {
				f.patchResult(patch); const before = structuredClone(f.input.assignment); let failure: unknown;
				try { await f.executor.execute(f.input); } catch (error) { failure = error; }
				expect(failure).toMatchObject({ code: 'sandbox_result_correlation_mismatch', outputs: { sandboxId: 'owned-native-sandbox',
					teardown: { verified: true, completedAt: f.destroyedAt() } }, usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
				expect(f.events.some(event => event.type === 'execution.completed')).toBe(false); expect(f.input.assignment).toEqual(before);
				expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 });
				expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			} finally { await f.close(); }
		}
		const clockOutcomes: Array<{ mode: string; result: unknown; failure: unknown; completed: boolean }> = [];
		for (const mode of ['exact', 'missing', 'foreign-window', 'receipt-count', 'pending', 'zero', 'negative', 'string', 'null',
			'fraction', 'over-window', 'increasing', 'absent-remaining', 'content-drift', 'clock-error', 'duplicate-clock',
			'first-nonclock', 'final-nonclock', 'blocking-without-recheck', 'wrong-server', 'wrong-tool', 'frequent']) {
			const f = await microvmBroker(); try {
				const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt), window = { startedAt: attempt.createdAt, deadlineAt: attempt.deadline };
				const observed = mode === 'foreign-window' ? { startedAt: new Date(Date.parse(window.startedAt) + 1).toISOString(),
					deadlineAt: new Date(Date.parse(window.deadlineAt) + 1).toISOString() } : window;
				const clock = (id: string, remainingSeconds: unknown) => { const value = { ...observed, remainingSeconds }; return {
					type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
						result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
				const events: unknown[] = [clock('first-clock', 30), clock('final-clock', 29)];
				const invalidRemaining: Record<string, unknown> = { zero: 0, negative: -1, string: '29', null: null, fraction: 29.5, 'over-window': 31 };
				if (Object.hasOwn(invalidRemaining, mode)) events[1] = clock('final-clock', invalidRemaining[mode]);
				if (mode === 'increasing') events.splice(0, 2, clock('first-clock', 20), clock('final-clock', 21));
				if (mode === 'absent-remaining') {
					const value = { ...observed }; events[1] = { type: 'item.completed', item: { id: 'final-clock', type: 'mcp_tool_call', server: 'treedx',
						tool: 'treeseed_time_status', status: 'completed', error: null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } };
				}
				if (mode === 'content-drift') { const action = clock('final-clock', 29); action.item.result.content[0]!.text = JSON.stringify({ ...observed, remainingSeconds: 28 }); events[1] = action; }
				if (mode === 'clock-error') events[1] = { type: 'item.completed', item: { id: 'final-clock', type: 'mcp_tool_call', server: 'treedx',
					tool: 'treeseed_time_status', status: 'failed', error: { message: 'Original clock denial' }, result: { isError: true } } };
				if (mode === 'duplicate-clock') events[1] = clock('first-clock', 29);
				// Supplied raw observations, not actual commands or model compliance.
				const command = (id: string) => ({ type: 'item.completed', item: { id, type: 'command_execution',
					status: 'completed', command: 'controlled-verification-input', exit_code: 0, aggregated_output: 'controlled output' } });
				if (mode === 'first-nonclock') events.unshift(command('before-first-clock'));
				if (mode === 'final-nonclock') events.push(command('after-final-clock'));
				if (mode === 'blocking-without-recheck') events.splice(1, 0, command('first-blocking'), command('second-blocking'));
				if (mode === 'frequent') events.splice(0, 2, clock('first-clock', 30), command('first-blocking'),
					clock('between-commands', 29), command('second-blocking'), clock('final-clock', 28));
				if (mode === 'wrong-server') { const action = clock('final-clock', 29); action.item.server = 'foreign-clock'; events[1] = action; }
				if (mode === 'wrong-tool') { const action = clock('final-clock', 29); action.item.tool = 'foreign-time-status'; events[1] = action; }
				if (mode === 'pending') events.splice(1, 0, { type: 'item.started', item: { id: 'uncompleted-command', type: 'command_execution', status: 'in_progress' } });
				const patch = { diagnostics: mode === 'missing' ? {} : { providerEvents: events },
					timingAwareness: { ...timingAwareness, completedChecks: ['receipt-count', 'frequent'].includes(mode) ? 3 : 2 } };
				f.patchResult(patch); const before = structuredClone(f.input.assignment), raw = structuredClone(patch);
				let result: Awaited<ReturnType<typeof f.executor.execute>> | undefined, failure: unknown;
				try { result = await f.executor.execute(f.input); } catch (error) { failure = error; }
				clockOutcomes.push({ mode, result, failure, completed: f.events.some(event => event.type === 'execution.completed') });
				expect(patch).toEqual(raw); expect(f.input.assignment).toEqual(before); expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 });
				expect(f.paths.filter(path => path.endsWith('/execute'))).toHaveLength(1);
				expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			} finally { await f.close(); }
			expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
		}
		for (const observed of clockOutcomes) {
			if (['exact', 'frequent'].includes(observed.mode)) { expect(observed.failure).toBeUndefined(); expect(observed.result).toMatchObject({ status: 'completed' }); }
			else { expect(observed.result).toBeUndefined(); expect(observed.failure).toMatchObject({ message: 'Completed sandbox result lacks valid timing-awareness evidence.' }); expect(observed.completed).toBe(false); }
		}
	});
	it('native original microvm accepts only declared artifact identity and exact immutable bytes digest and size before verified closeout', async () => {
		const originalBytes = Buffer.from('{"exact":"candidate"}\n'), observations = [];
		for (const mode of ['exact', 'changed-bytes', 'short', 'long', 'foreign-id', 'foreign-path', 'foreign-media', 'over-limit']) {
			const f = await microvmBroker(); try {
				const bytes = mode === 'changed-bytes' ? Buffer.from('{"exact":"substitut"}\n') : mode === 'short' ? originalBytes.subarray(0, originalBytes.length - 1)
					: mode === 'long' ? Buffer.concat([originalBytes, Buffer.from('x')]) : Buffer.from(originalBytes);
				const descriptor = { id: mode === 'foreign-id' ? 'ungranted-output' : 'result', path: mode === 'foreign-path' ? '/run/treeseed-output/ungranted.json' : '/run/treeseed-output/result.json',
					mediaType: mode === 'foreign-media' ? 'text/plain' : 'application/json',
					digest: `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`, bytes: mode === 'over-limit' ? 67_108_865 : originalBytes.length };
				f.artifact(bytes); f.patchResult({ artifacts: [descriptor] }); const before = structuredClone(f.input.assignment);
				let failure: unknown, result: Awaited<ReturnType<typeof f.executor.execute>> | undefined;
				try { result = await f.executor.execute(f.input); } catch (error) { failure = error; }
				observations.push({ mode, failure, result, downloaded: f.paths.filter(path => path.includes('/artifacts/')), closedAt: f.destroyedAt() });
				expect(f.input.assignment).toEqual(before); expect(originalBytes).toEqual(Buffer.from('{"exact":"candidate"}\n'));
				expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 });
				expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			} finally { await f.close(); }
		}
		for (const observed of observations) {
			if (observed.mode === 'exact') {
				expect(observed.failure).toBeUndefined(); expect(observed.result?.status).toBe('completed');
				expect(observed.result?.artifacts).toEqual([{ id: 'result', path: '/run/treeseed-output/result.json', mediaType: 'application/json',
					digest: `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`, bytes: originalBytes.length, content: originalBytes.toString('utf8') }]);
			} else {
				const unauthorized = ['foreign-id', 'foreign-path', 'foreign-media', 'over-limit'].includes(observed.mode);
				expect(observed.result).toBeUndefined(); expect(observed.failure).toMatchObject({ code: unauthorized ? 'sandbox_artifact_unauthorized' : 'sandbox_artifact_integrity_invalid',
					outputs: { sandboxId: 'owned-native-sandbox', teardown: { verified: true, completedAt: observed.closedAt } },
					usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
				if (unauthorized) expect(observed.downloaded).toEqual([]);
			}
		}
	});
	it('native original microvm retains denied interrupted malformed and unverified destroy observations instead of accepting model completion or replaying destruction', async () => {
		const denials: Array<{ fault?: string; reply?: { sandboxId: string; destroyed: boolean; teardown: { verified: unknown; completedAt: string | null } } }> =
			[{ fault: '403' }, { fault: '503' }, { fault: 'reset' }, { fault: 'json' },
			{ reply: { sandboxId: 'owned-native-sandbox', destroyed: false, teardown: { verified: false, completedAt: null } } },
			{ reply: { sandboxId: 'foreign-sandbox', destroyed: true, teardown: { verified: true, completedAt: new Date().toISOString() } } },
			{ reply: { sandboxId: 'owned-native-sandbox', destroyed: true, teardown: { verified: 'true', completedAt: new Date().toISOString() } } },
			{ reply: { sandboxId: 'owned-native-sandbox', destroyed: true, teardown: { verified: true, completedAt: null } } }];
		for (const denial of denials) {
			const f = await microvmBroker(); try {
				f.patchDestroy(denial.reply, denial.fault ?? '');
				const before = structuredClone(f.input.assignment); let failure: unknown;
				try { await f.executor.execute(f.input); } catch (error) { failure = error; }
				expect(failure).toMatchObject({ code: 'sandbox_teardown_unverified', outputs: { sandboxId: 'owned-native-sandbox' },
					usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
				if (denial.fault && ['403', '503'].includes(denial.fault)) expect(failure).toMatchObject({ message: expect.stringContaining(`original destroy ${denial.fault}`) });
				if (denial.reply) expect(failure).toMatchObject({ outputs: { teardown: denial.reply.teardown } });
				expect(f.events.some(event => event.type === 'execution.completed')).toBe(false); expect(f.input.assignment).toEqual(before);
				expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 });
				expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			} finally { await f.close(); }
		}
	});
	it('native tool pump polling and delivery denials cancel exactly once and retain failed transport without replay', async () => {
		for (const operation of ['poll', 'delivery']) for (const fault of ['403', '503', 'reset', 'json']) {
			const input = executionRequest(), paths: string[] = [], bodies: string[] = [];
			// A valid, already elapsed canonical interval reaches the clock tool
			// and reports zero; a zero-length interval is malformed authority.
			const end = new Date(Date.now() - 1_000).toISOString(), start = new Date(Date.parse(end) - 1_000).toISOString();
			input.assignment.assignmentAttempt = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), createdAt: start, deadline: end });
			const before = structuredClone(input.assignment), time = { startedAt: start, deadlineAt: end };
			let cancelled: (() => void) | undefined, cancelFailure: unknown, cancellation: Promise<unknown> | undefined;
			const cancelledRequest = new Promise<void>(resolve => { cancelled = resolve; });
			const fixture = await broker((request, response) => {
				const path = request.url ?? ''; paths.push(path); let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
				request.on('end', () => {
					bodies.push(raw); response.setHeader('content-type', 'application/json');
					if (path.endsWith('/cancel')) { response.end('{}'); cancelled?.(); return; }
					const denied = operation === 'poll' ? path.endsWith('/next') : path.endsWith('/tool-clock');
					if (denied) {
						if (fault === 'reset') { request.socket.destroy(); return; }
						if (fault === 'json') { response.end('{'); return; }
						response.statusCode = Number(fault); response.end(JSON.stringify({ error: `retained ${operation} ${fault}` })); return;
					}
					if (path.endsWith('/next')) { response.end(JSON.stringify({ request: { id: 'tool-clock', tool: 'treeseed_time_status', arguments: {} } })); return; }
					response.statusCode = 500; response.end('{"error":"Unexpected replay"}');
				});
			});
			let stop: (() => Promise<Error | undefined>) | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
			try {
				const observed = new Promise<void>((resolve, reject) => { watchdog = setTimeout(() => reject(new Error('Original native cancellation not observed')), 2_000);
					cancelledRequest.then(resolve, reject); });
				stop = startSandboxToolPump(fixture.client, { sandboxId: 'sandbox', operationToken: 'test-operation' }, input, time, () => {
					cancellation = fixture.client.cancel('sandbox', 'test-operation').catch(error => { cancelFailure = error; });
				});
				await observed; clearTimeout(watchdog); await cancellation; expect(cancelFailure).toBeUndefined();
				const failure = await stop(); expect(failure).toBeInstanceOf(Error); expect(await stop()).toBe(failure);
				if (fault === '403' || fault === '503') expect(failure?.message).toBe(`retained ${operation} ${fault}`);
				if (fault === 'json') expect(failure?.message).toBe('Sandbox broker returned invalid JSON.');
				if (fault === 'reset') expect(failure).toMatchObject({ code: 'ECONNRESET' });
				expect(paths).toEqual(operation === 'poll' ? ['/v1/sandboxes/sandbox/tool-requests/next', '/v1/sandboxes/sandbox/cancel']
					: ['/v1/sandboxes/sandbox/tool-requests/next', '/v1/sandboxes/sandbox/tool-requests/tool-clock', '/v1/sandboxes/sandbox/cancel']);
				expect(bodies).toEqual(operation === 'poll' ? ['', ''] : ['', JSON.stringify({ result: { ...time, remainingSeconds: 0 } }), '']);
				expect(input.assignment).toEqual(before);
			} finally {
				if (watchdog) clearTimeout(watchdog); await stop?.(); await cancellation; await fixture.close();
			}
			expect(fixture.server.listening).toBe(false); await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
		}
		// Original client/pump and native Unix HTTP; not actual broker/Kata, API
		// authentication, provider measurements or physical sandbox teardown.
	});
	it('native ordinary tool denial delivers one exact error and explicit stop cannot revive its pending poll', async () => {
		const input = executionRequest(), before = structuredClone(input.assignment), paths: string[] = [], bodies: string[] = [];
		let waiting: (() => void) | undefined, late: ServerResponse | undefined, reads = 0;
		const pending = new Promise<void>(resolve => { waiting = resolve; });
		const fixture = await broker((request, response) => {
			const path = request.url ?? ''; paths.push(path); let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
			request.on('end', () => {
				bodies.push(raw); response.setHeader('content-type', 'application/json');
				if (path.endsWith('/next')) {
					if (++reads === 1) { response.end('{"request":{"id":"denied-tool","tool":"ungranted-tool","arguments":{}}}'); return; }
					late = response; waiting?.(); return;
				}
				response.end('{}');
			});
		});
		let cancellations = 0, stop: (() => Promise<Error | undefined>) | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const now = new Date().toISOString(); stop = startSandboxToolPump(fixture.client, { sandboxId: 'sandbox', operationToken: 'test-operation' }, input,
				{ startedAt: now, deadlineAt: now }, () => { cancellations++; });
			await new Promise<void>((resolve, reject) => { watchdog = setTimeout(() => reject(new Error('Original pending native poll not observed')), 2_000); pending.then(resolve, reject); });
			clearTimeout(watchdog); expect(await stop()).toBeUndefined();
			const history = structuredClone({ paths, bodies });
			late?.end('{"request":{"id":"late-tool","tool":"ungranted-tool","arguments":{}}}');
			expect(await stop()).toBeUndefined(); expect({ paths, bodies }).toEqual(history); expect(cancellations).toBe(0);
			expect(paths).toEqual(['/v1/sandboxes/sandbox/tool-requests/next', '/v1/sandboxes/sandbox/tool-requests/denied-tool', '/v1/sandboxes/sandbox/tool-requests/next']);
			expect(bodies).toEqual(['', '{"error":"Activity profile does not authorize ungranted-tool."}', '']); expect(input.assignment).toEqual(before);
		} finally { if (watchdog) clearTimeout(watchdog); await stop?.(); await fixture.close(); }
		expect(fixture.server.listening).toBe(false); await expect(stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('isolates every control request from peer-retired pooled Unix sockets without replay', async () => {
		const sockets = new Set<IncomingMessage['socket']>();
		const paths: string[] = [];
		const fixture = await broker((request, response) => {
			paths.push(request.url!);
			// A peer may retire a keep-alive connection before the next operation.
			// Exercise the reset at that boundary, not a mock of the client result.
			if (sockets.has(request.socket)) { request.socket.destroy(); return; }
			sockets.add(request.socket);
			request.resume();
			request.on('end', () => {
				response.setHeader('content-type', 'application/json');
				response.end(request.url?.includes('/artifacts/') ? 'data' : '{"request":null}');
			});
		});
		try {
			const client = fixture.client;
			await client.status();
			await client.nextToolRequest('sandbox', 'test-operation');
			await client.completeToolRequest('sandbox', 'test-operation', 'request', { result: {} });
			await client.sourceStatus('sandbox', 'test-operation');
			await client.sourcePublicationStatus('sandbox', 'test-operation');
			await client.prepare({} as never, new Date(Date.now() + 10_000).toISOString());
			await client.source('sandbox', 'test-operation', 'prepare', {} as never);
			await client.sourcePublicationStart('sandbox', 'test-operation', {} as never, 'a'.repeat(40));
			await client.execute('sandbox', 'test-operation', {});
			await client.renew('sandbox', 'test-operation', {} as never);
			const input = join(fixture.directory, 'input');
			await writeFile(input, 'data');
			await client.upload('sandbox', 'test-operation', 'input', input, 4);
			expect(await client.downloadArtifact('sandbox', 'test-operation', 'output', 4)).toEqual(Buffer.from('data'));
			await client.cancel('sandbox', 'test-operation');
			await client.destroy('sandbox', 'test-operation');
			expect(sockets.size).toBe(14);
			expect(paths).toHaveLength(14);
			expect(paths.filter(path => path.endsWith('/tool-requests/request'))).toHaveLength(1);
		} finally { await fixture.close(); }
	});
	it('fails closed on polling and completion resets without retrying either operation', async () => {
		const paths: string[] = [];
		const fixture = await broker(request => { paths.push(request.url!); request.socket.destroy(); });
		try {
			await expect(fixture.client.nextToolRequest('sandbox', 'test-operation')).rejects.toMatchObject({ code: 'ECONNRESET' });
			await expect(fixture.client.completeToolRequest('sandbox', 'test-operation', 'request', { result: {} })).rejects.toMatchObject({ code: 'ECONNRESET' });
			expect(paths).toEqual(['/v1/sandboxes/sandbox/tool-requests/next', '/v1/sandboxes/sandbox/tool-requests/request']);
		} finally { await fixture.close(); }
	});
});
