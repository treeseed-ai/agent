import { createServer } from 'node:http';
import { expect } from 'vitest';
import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { runProviderAssignment } from '../../../../../src/provider/operations/runner.ts';
import { providerOperationPath } from '../../../../../src/provider/coordination/client.ts';
import { ProviderLocalCapacityStore } from '../../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { assignmentAttemptSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import type { AgentExecutionResult, AgentExecutor } from '../../../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../../../src/kernel/contracts.ts';
import { request, timingAwareness } from '../../provider-kernel-fixture.ts';

// Native public transport and original runner/Kernel/local custody. Upstream
// responses and executor counters remain controlled inputs, not native API
// authentication, generated provider charges or physical Kata closure.
export async function nativeCloseoutTransport(f: Pick<Awaited<ReturnType<typeof portableKernel>>, 'attempt' | 'input' | 'executor'>, directory: string, executionWindow = false) {
	const keys = ['assignment', 'startExecution', 'createEvent', 'reportUsage', 'settleAssignment', 'returnAssignment', 'startCloseout', 'completeAssignment', 'failAssignment'] as const;
	const paths = new Map(keys.map(key => [providerOperationPath(CONTROL_PLANE_OPERATIONS.providers[key], { assignmentId: f.attempt.id }), key]));
	const requests: Array<{ operation: string; body: Record<string, unknown>; key: string | undefined }> = [];
	let denied: 'reportUsage' | 'settleAssignment' | undefined, status = 503, fault = '';
	const server = createServer((request, response) => {
		let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
		request.on('end', () => {
			const operation = paths.get(new URL(request.url ?? '', 'http://127.0.0.1').pathname);
			if (!operation) { response.writeHead(500).end(JSON.stringify({ error: 'unexpected native operation' })); return; }
			const key = request.headers['idempotency-key'];
			requests.push({ operation, body: raw ? JSON.parse(raw) : {}, key: typeof key === 'string' ? key : undefined });
			if (operation === denied && fault === 'reset') { request.socket.destroy(); return; }
			response.statusCode = operation === denied ? status : 200; response.setHeader('content-type', 'application/json');
			if (operation === denied && fault === 'json') { response.end('{'); return; }
			response.end(JSON.stringify(operation === denied ? { type: 'about:blank', title: 'Original isolated denial', status, code: 'isolated_closeout_denied' }
				: { data: operation === 'assignment' ? { id: f.attempt.id, stateVersion: 7 }
					: operation === 'startExecution' ? { stateVersion: 8, ...(executionWindow ? { capacityEnvelope: { budget: { time: {
						executionStartedAt: f.attempt.createdAt, executionDeadlineAt: f.attempt.deadline } } } } : {}) }
					: operation === 'returnAssignment' ? { assignment: { id: f.attempt.id, status: 'returned' } } : { ok: true } }));
		});
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native closeout address required');
	const client = new ProviderProtocolClient({ controlPlaneUrl: `http://127.0.0.1:${address.port}`, accessToken: 'isolated-closeout-input' });
	const store = new ProviderLocalCapacityStore(directory);
	try {
		const claim = await store.claim({ connectionId: 'original-connection', globalLimit: 1, connectionLimit: 1 });
		if (!claim) throw new Error('Original local closeout slot required');
		const lease = { assignmentId: f.attempt.id, leaseToken: f.input.leaseToken, leaseExpiresAt: f.attempt.deadline,
			requestedSeconds: f.attempt.limits.maximumSeconds, dispatchEnvelope: { assignment: structuredClone(f.input.assignment) } };
		await store.attachLease(claim.id, lease); await store.claimDispatch(claim.id);
		return { client, requests, store, claim, lease,
			deny(operation?: typeof denied, code = 503, failure = '') { denied = operation; status = code; fault = failure; },
			run: () => runProviderAssignment({ client, executor: f.executor, assignment: f.input.assignment,
				treeDx: f.input.treeDx, leaseToken: f.input.leaseToken, runnerId: f.input.runnerId, runtimeBuild: f.attempt.provider.runtimeBuild,
				signal: f.input.signal,
				onActiveExecutionStarted: () => store.beginActiveExecution(claim.id).then(() => undefined),
				onActiveExecutionFinished: () => store.finishActiveExecution(claim.id).then(() => undefined),
				onCloseoutOutput: output => store.recordCloseoutOutput(claim.id, output).then(() => undefined) }),
			reopen: () => new ProviderLocalCapacityStore(directory),
			async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
				expect(server.listening).toBe(false); }
		};
	} catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
}

// Production Kernel, registry, handlers, grants, public schemas and native Git.
// The loopback executor replies are controlled inputs, NOT native model usage,
// Deployment isolation, API admission, live credentials or physical teardown.
export function portableProfile(name = 'renamed-boundary-agent', handler = 'actor') {
	const checked = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: configured/${name}
name: ${name}
agentClass: ${name}
purpose: Complete only the immutable assignment through the selected handler.
responsibilities: [Return exact governed references and preserve predecessor custody.]
capabilities: [code-change]
context: { include: [assignment-subject, predecessor-results] }
activityProfiles:
  acting:
    handler: ${handler}
    prompt: { system: Complete the configured task without changing authority., instructions: [Preserve exact predecessor evidence.] }
    parameters: { temperature: 0.25 }
    permissions: { content: { read: [proposal, decision], write: [] }, tools: [source.read, source.write] }
`));
	if (!checked.ok || !checked.data) throw new Error(JSON.stringify(checked.diagnostics));
	return checked.data;
}
export async function portableKernel(responseReady?: Promise<void>, originalMaximumSeconds?: number) {
	const directory = await mkdtemp(join(tmpdir(), 'agent-portable-kernel-'));
	const checkout = join(directory, 'work');
	const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	let server: ReturnType<typeof createServer> | undefined;
	try {
		await mkdir(checkout); git('init', '-b', 'fixture-base'); git('config', 'user.name', 'Isolated Kernel Fixture');
		git('config', 'user.email', 'kernel@example.invalid'); await mkdir(join(checkout, 'src'));
		await writeFile(join(checkout, 'src/output.txt'), 'original base\n'); git('add', '.'); git('commit', '-m', 'original governed base');
		const base = git('rev-parse', 'HEAD'), profile = portableProfile(), input = request();
		const original = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), selected = profile.activityProfiles.acting;
		if (!selected) throw new Error('Complete configured acting profile required');
		// Preserve the fresh input's original thirty-second phase deadline.
		// A shorter active allocation does not charge native preparation time;
		// neither clock is refreshed after admission or executor setup.
		const maximumSeconds = originalMaximumSeconds ?? original.limits.maximumSeconds;
		const createdAt = new Date().toISOString(), deadline = new Date(Date.parse(createdAt) + original.limits.maximumSeconds * 1000).toISOString();
		const attempt = assignmentAttemptSchema.parse({ ...original, createdAt, deadline, agentClass: profile.agentClass,
			limits: { ...original.limits, maximumSeconds }, estimate: { expectedSeconds: Math.min(original.estimate.expectedSeconds, maximumSeconds), maximumSeconds },
			effectiveProfile: { ...original.effectiveProfile, profileRef: { ...original.effectiveProfile.profileRef, id: profile.id },
				handler: selected.handler, prompt: selected.prompt, parameters: selected.parameters, permissionCeiling: selected.permissions },
			workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: base,
				branch: 'simulation/portable/workday/assignment-1', writablePaths: ['src'] },
			contextRefs: [{ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit: base }] });
		if (attempt.workspace.mode !== 'git') throw new Error('Git fixture required');
		const workspace = attempt.workspace;
		git('switch', '-c', workspace.branch);
		input.assignment = { ...input.assignment, assignmentAttempt: attempt, workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
		const requests: unknown[] = [], begin: unknown[] = [];
		let signalRequestArrived!: () => void;
		const requestArrived = new Promise<void>(resolve => { signalRequestArrived = resolve; });
		input.beginExecution = async () => { begin.push({ assignmentId: attempt.id, originalDeadline: attempt.deadline }); return {}; };
		let reply: AgentExecutionResult | undefined, code = 200, fault = '';
		server = createServer((req, res) => {
			let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
			req.on('end', async () => {
				requests.push(JSON.parse(body));
				signalRequestArrived();
				if (responseReady) await responseReady;
				if (fault === 'reset') { req.socket.destroy(); return; }
				res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(fault === 'json' ? '{' : JSON.stringify(reply));
			});
		});
		await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback fixture address required');
		const executor: AgentExecutor = { id: attempt.provider.executionProviderId, observe: async () => ({ available: true }),
			execute: async execution => {
				await execution.beginExecution?.();
				const response = await fetch(`http://127.0.0.1:${address.port}/execute`, { method: 'POST', signal: execution.signal,
					headers: { 'content-type': 'application/json' }, body: JSON.stringify(execution.assignment) });
				if (!response.ok) throw new Error(`Controlled executor denied ${response.status}`);
				return await response.json() as AgentExecutionResult;
			} };
		const candidate = async (paths = ['src/output.txt']) => {
			for (const path of paths) { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), 'exact candidate\n'); }
			git('add', '.'); git('commit', '-m', 'bounded candidate');
			const commit = git('rev-parse', 'HEAD');
			reply = { status: 'completed', summary: 'Exact configured candidate.', usage: [{ activeSeconds: 1, elapsedSeconds: 2, inputTokens: 7 }],
				outputs: { timingAwareness, changedPaths: paths, sourceReference: { kind: 'git', repository: workspace.repository,
					commit, branch: workspace.branch } } };
			return commit;
		};
		const close = async () => { server!.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); };
		return { input, attempt, profile, git, checkout, base, requests, requestArrived, begin, candidate, close, executor,
			setReply(value: AgentExecutionResult, status = 200, error = '') { reply = value; code = status; fault = error; },
			getReply() { if (!reply) throw new Error('Candidate response required'); return structuredClone(reply); },
			run: (handlers?: Handler[]) => executeKernelAssignment({ request: input, executor, runtimeBuild: original.provider.runtimeBuild, handlers }) };
	} catch (error) { server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); await rm(directory, { recursive: true, force: true }); throw error; }
}
