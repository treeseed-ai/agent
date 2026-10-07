import { expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { sandboxAssignmentSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider';
import { SandboxBrokerClient } from '../../../../src/provider/execution/sandbox-broker-client.ts';
import { createMicrovmExecutor } from '../../../../src/provider/execution/microvm-executor.ts';
import { createManagedProviderManifestV5 } from '../../../../src/provider/configuration/managed-manifest.ts';
import { initializeCapacityProviderIdentity } from '../../../../src/provider/accounts/identity.ts';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';
import { request as executionRequest, timingAwareness, digest } from '../../kernel/provider-kernel-fixture.ts';

export async function broker(handle: (request: IncomingMessage, response: ServerResponse) => void) {
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
export async function microvmBroker() {
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
					const clock = (id: string, remainingSeconds: number) => { const value = { ...window, remainingSeconds,
						observedAt: new Date(Date.parse(window.deadlineAt) - remainingSeconds * 1_000).toISOString() }; return {
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
		// The relay CA remains the required original native binding (a disposable
		// certificate on the CI runner). Only this fresh
		// fixture identity uses an allocated mode-0600 OS custody key; no host
		// provider secret is read, changed, or used as test authority.
		const relayBytes = await readFile('/etc/treeseed/sandbox/relay-ca.crt');
		const relayCertificate = new X509Certificate(relayBytes);
		expect(relayCertificate.ca).toBe(true);
		expect(relayCertificate.verify(relayCertificate.publicKey)).toBe(true);
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


