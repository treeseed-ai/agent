import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sandboxAssignmentSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { clockRequest } from './architecture/clock-fixture.ts';
import { objectDigest } from '../../../src/kernel/handlers/model-verification.ts';
import { verificationCompletionInstructions } from '../../../src/activity-completion.ts';
import { invokeTreeDxRelay, runModelWorkload, timingAwarenessContract } from '../../../src/kernel/handlers/model-workload.ts';
import { run } from '../../../src/sandbox/process-runner.ts';
import type { CodexSdkTurn } from '../../../src/kernel/handlers/codex-sdk-session.ts';
import { codexUsageEvidence } from '../../../src/kernel/handlers/codex-sdk-session.ts';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), runTurn: vi.fn<(turn: CodexSdkTurn) => Promise<void>>() }));
vi.mock('../../../src/kernel/handlers/codex-sdk-session.ts', async original => ({ ...await original<object>(), CodexWorkloadSession: class {
	readonly id = null;
	constructor(options: unknown) { sdk.construct(options); }
	runTurn = sdk.runTurn;
} }));

vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('../../../src/sandbox/process-runner.ts', async original => ({ ...await original<typeof import('../../../src/sandbox/process-runner.ts')>(), run: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), createReadStream: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
	readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), stat: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readFile).mockResolvedValue(Buffer.from('fixture-ca')); });
afterEach(() => vi.useRealTimers());
const environment = { TREESEED_RELAY_URL: 'https://relay.invalid:7444', TREESEED_SANDBOX_ID: 'fixture-sandbox',
	TREESEED_GUEST_TOKEN: 'fixture-token', TREESEED_RELAY_CA: '/fixture/ca.pem' };

function response(body: string, statusCode = 200) {
	let options: Parameters<typeof request>[0]; const outgoing = new EventEmitter();
	vi.mocked(request).mockImplementation(((input: unknown, callback: (incoming: unknown) => void) => {
		options = input as typeof options;
		Object.assign(outgoing, { end: () => {
			const incoming = Object.assign(new EventEmitter(), { statusCode, setEncoding: vi.fn() });
			callback(incoming); incoming.emit('data', body); incoming.emit('end');
		} }); return outgoing;
	}) as typeof request);
	return () => options as import('node:https').RequestOptions;
}

it('reads the unchanged API clock through the existing authenticated tool relay', async () => {
	const clock = { startedAt: '2026-10-01T21:32:00Z', deadlineAt: '2026-10-01T21:32:30Z', remainingSeconds: 30 };
	const options = response(JSON.stringify(clock));
	expect(await invokeTreeDxRelay('treeseed_time_status', {}, environment, 20_000)).toEqual(clock);
	expect(options()).toMatchObject({ hostname: 'relay.invalid', path: '/v1/sandboxes/fixture-sandbox/tools/treedx', method: 'POST' });
	expect(readFile).toHaveBeenCalledWith('/fixture/ca.pem');
	// A trusted runtime read cannot manufacture the model's first/final clock receipt.
	expect(timingAwarenessContract([])).toMatchObject({ completedChecks: 0, firstToolCompliant: false, finalToolCompliant: false });
});

it('bounds the runtime clock request by its caller remaining execution window', async () => {
	const signal = new AbortController().signal;
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal); const options = response('{}');
	await invokeTreeDxRelay('treeseed_time_status', {}, environment, 370);
	expect(options().signal).toBe(signal); expect(timeout).toHaveBeenCalledWith(370);
	await expect(invokeTreeDxRelay('treeseed_time_status', {}, environment, 0)).rejects.toThrow('assignment_execution_budget_exhausted');
	expect(request).toHaveBeenCalledTimes(1); timeout.mockRestore();
});

it('does not fabricate clock authority from a denied relay response or malformed JSON', async () => {
	response(JSON.stringify({ error: 'Productive execution has not started.' }), 409);
	await expect(invokeTreeDxRelay('treeseed_time_status', {}, environment)).rejects.toThrow('Productive execution has not started.');
	response('not-json'); await expect(invokeTreeDxRelay('treeseed_time_status', {}, environment)).rejects.toThrow();
});

it('fails before opening a relay request when its private runtime environment is incomplete', async () => {
	await expect(invokeTreeDxRelay('treeseed_time_status', {}, {})).rejects.toThrow('relay environment is incomplete');
	expect(request).not.toHaveBeenCalled();
});

function suppliedGuestFiles(mode: string, duration = 30) {
		const { attempt, execution } = clockRequest(duration);
		const context = { identity: { manifest: {} }, canonicalAssignmentContext: { assignment: { ...attempt,
			workspace: { mode: 'read-only' }, effectiveProfile: { activity: 'chat', handler: 'writer' } }, context: mode === 'completed' ? [{ ref: attempt.sourceRef,
				value: { frontmatter: { executionPlan: { workItems: [{ id: attempt.workItemId }] } } } }] : [], predecessorResults: [] } };
		const bytes = Buffer.from(JSON.stringify(context)), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
		const assignment = sandboxAssignmentSchema.parse({ schemaVersion: 'treeseed.sandbox-assignment/v1', assignmentId: attempt.id,
			attempt: attempt.attempt, runnerId: 'supplied-unit', providerId: attempt.provider.providerId, teamId: attempt.teamId, projectId: attempt.projectId,
			profile: 'supplied-unit', guestImage: 'supplied-unit', guestImageDigest: digest, identityManifestDigest: objectDigest(context.identity.manifest),
			contextManifestDigest: digest, resources: { cpuCores: 1, memoryBytes: 536870912, diskBytes: 67108864, durationSeconds: duration, processLimit: 32, outputBytes: 1048576 },
			inputs: [{ id: 'execution-context', digest, bytes: bytes.length, disposition: 'copy-on-write', mediaType: 'application/json', targetPath: '/workspace/.treeseed/context.json' }],
			outputs: [], network: { defaultDeny: true, relayUrl: 'https://relay.invalid:7444', allowedServices: mode === 'completed' ? ['treedx'] : ['treedx', 'codex-subscription'] },
			modelPolicy: { provider: 'supplied-unit', model: 'not-a-real-model', capabilities: [] }, credentialHandles: [], treeDxHandleIds: [],
			leaseExpiresAt: attempt.deadline, signature: { keyId: 'supplied-unit', algorithm: 'Ed25519', value: 'supplied-not-issued' } });
		const root = '/run/treeseed-assignment/', privateRoot = '/workspace/.treeseed/codex/', suppliedAuth = Buffer.from('{"access_token":"supplied-unit-credential"}');
		const files = new Map<string, Buffer<ArrayBuffer>>([[`${root}assignment.json`, Buffer.from(JSON.stringify(assignment))], [`${root}input-execution-context`, bytes],
			['/workspace/.treeseed/context.json', bytes],
			['/workspace/.treeseed/model-request.json', Buffer.from(JSON.stringify({ prompt: 'Controlled unit instructions.' }))],
			[`${root}sandbox-id`, Buffer.from('supplied-unit')], [`${root}operation-token`, Buffer.from('supplied-unit-token')],
			['/workspace/.treeseed/relay-ca.crt', Buffer.from('supplied-ca')]]);
		if (mode === 'invalid-context') files.set(`${root}codex-auth.json`, suppliedAuth);
		const held = new Map(files);
		return { files, held, execution, root, privateRoot, suppliedAuth };
}
function mockGuestFiles(files: Map<string, Buffer<ArrayBuffer>>) {
		vi.mocked(readFile).mockImplementation(async (path, options) => {
			const value = files.get(String(path)); if (!value) throw Object.assign(new Error('missing supplied input'), { code: 'ENOENT' });
			return options === 'utf8' ? value.toString('utf8') : value;
		});
		vi.mocked(writeFile).mockImplementation(async (path, data) => { files.set(String(path), Buffer.from(String(data))); });
		vi.mocked(mkdir).mockResolvedValue(undefined);
		vi.mocked(rm).mockImplementation(async path => { files.delete(String(path)); });
		vi.mocked(stat).mockImplementation(async path => { const value = files.get(String(path));
			if (!value) throw Object.assign(new Error('missing supplied input'), { code: 'ENOENT' });
			return { dev: 0, ino: 0, mode: 0o600, nlink: 1, uid: 0, gid: 0, rdev: 0, size: value.length, blksize: 4096, blocks: 1,
				atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
				isFile: () => true, isDirectory: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
				isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false }; });
		vi.mocked(createReadStream).mockImplementation(path => Object.assign(Readable.from([files.get(String(path))]), { path: String(path), pending: false, bytesRead: 0, close() {} }));
}

async function suppliedGuestExecution(providerFailure?: Error, incompleteClock = false, closeoutFailure = false, correction = false, documentedPreparation = false, invalidPreparation = false) {
	const f = suppliedGuestFiles('completed', correction ? 120 : 30);
	if (closeoutFailure || documentedPreparation) {
		const context = JSON.parse(f.files.get('/workspace/.treeseed/context.json')!.toString());
		context.canonicalAssignmentContext.assignment.effectiveProfile.activity = 'acting';
		f.files.set('/workspace/.treeseed/context.json', Buffer.from(JSON.stringify(context)));
		const assignment = JSON.parse(f.files.get(f.root + 'assignment.json')!.toString());
		assignment.contextManifestDigest = `sha256:${createHash('sha256').update(f.files.get('/workspace/.treeseed/context.json')!).digest('hex')}`;
		assignment.inputs[0].digest = assignment.contextManifestDigest;
		f.files.set(f.root + 'assignment.json', Buffer.from(JSON.stringify(assignment)));
		f.held.set('/workspace/.treeseed/context.json', f.files.get('/workspace/.treeseed/context.json')!);
		f.held.set(f.root + 'assignment.json', f.files.get(f.root + 'assignment.json')!);
		if (closeoutFailure) vi.mocked(run).mockRejectedValue(Object.assign(new Error('/bin/sh exited 127: Python: not found'), { code: 'subprocess_nonzero_exit', exitCode: 127, stdout: '', stderr: 'Python: not found' }));
		else vi.mocked(run).mockResolvedValue({ stdout: 'v24.0.0\n', stderr: '' });
	}
	f.files.set('/proc/version', Buffer.from('Controlled unit kernel input.')); mockGuestFiles(f.files);
	// Supplied monotonic UNIT observations, not native elapsed time or usage.
	let observed = 0n; const monotonic = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => observed);
	const materializedRead = vi.mocked(readFile).getMockImplementation()!;
	vi.mocked(readFile).mockImplementation(async (path, options) => {
		const result = await materializedRead(path, options);
		if (String(path) === '/workspace/.treeseed/context.json') observed = 5_000_000_000n;
		return result;
	});
	response(JSON.stringify({ ...f.execution, observedAt: f.execution.startedAt, remainingSeconds: 30 }));
	let turns = 0;
	sdk.runTurn.mockImplementation(async (options) => {
		const turn = turns++;
		if (correction && turn === 0) options.onEvent({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' });
		if (correction && turn === 1) vi.mocked(run).mockResolvedValue({ stdout: 'v24.0.0\n', stderr: '' });
		expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ model: 'not-a-real-model', remainingMs: expect.any(Function) }));
		expect(options.timeoutMs).toBeGreaterThan(0);
		for (const [id, seconds] of [['original-first', 0], ['original-final', 2]] as const) {
			if (incompleteClock && id === 'original-final') continue;
			const value = { ...f.execution, observedAt: new Date(Date.parse(f.execution.startedAt) + (seconds + turn * 3) * 1_000).toISOString(), remainingSeconds: (correction ? 120 : 30) - seconds - turn * 3 };
			options.onEvent({ type: 'item.completed', usage: { input_tokens: 19, output_tokens: 3 }, item: {
				id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
				result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } });
		}
		observed = BigInt(7 + turn * 2) * 1_000_000_000n;
		if (correction) options.onEvent({ type: 'turn.completed', usage: { input_tokens: 19, output_tokens: 3 } });
		if (providerFailure) throw providerFailure;
		if (documentedPreparation) {
			expect(options.input).toBe('Controlled unit instructions.');
			expect(options.outputSchema).toMatchObject({ properties: { verification: { items: { properties: {
				commands: { description: verificationCompletionInstructions },
			} } } } });
			f.files.set(options.responsePath, Buffer.from(JSON.stringify({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'Controlled fixture describes git add and git commit as source preparation, not replayable checks.',
				contentOutput: null, reviewDisposition: null, verification: [{ status: 'passed', summary: 'Controlled standalone check', commands: ['node --version'] }] })));
			return;
		}
		f.files.set(options.responsePath, Buffer.from(closeoutFailure ? JSON.stringify({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'Controlled invalid closeout, not live work.', contentOutput: null, reviewDisposition: null, verification: [{ status: invalidPreparation && turn === 0 ? 'failed' : 'passed', summary: 'Claimed link check', commands: [correction && turn > 0 ? 'node --version' : invalidPreparation ? 'git commit -m "docs: define remote git ref operator contract"' : 'Python check of Markdown links in docs/runbooks/federated-query.md'] }] }) : 'Controlled unit response.'));
	});
	try {
		await runModelWorkload();
		const result = sandboxResultSchema.parse(JSON.parse(f.files.get('/run/treeseed-output/result.json')!.toString('utf8')));
		if (invalidPreparation) expect(result.status, result.summary).toBe('completed');
		expect(result.usage).toMatchObject({ activeSeconds: correction ? 4 : 2, elapsedSeconds: correction ? 9 : 7, input_tokens: correction ? 38 : 19, output_tokens: correction ? 6 : 3, provenance: 'execution-provider' });
		expect(result.timingAwareness).toMatchObject({ completedChecks: correction ? 4 : 2, firstToolCompliant: true, finalToolCompliant: true });
		for (const [path, value] of f.held) expect(f.files.get(path)).toEqual(value);
		expect(['auth.json', 'config.toml', 'activity-completion.schema.json'].filter(name => f.files.has(f.privateRoot + name))).toEqual([]);
		return result;
	} finally { monotonic.mockRestore(); }
}
it('measures active guest preparation model tools and closeout separately from infrastructure materialization without moving the original execution clock', async () => {
	expect((await suppliedGuestExecution()).status).toBe('completed');
});
it('delivers one shared completion contract to the guest model and schema while replaying only the reported standalone check', async () => {
	const result = await suppliedGuestExecution(undefined, false, false, false, true);
	expect(result.status, result.summary).toBe('completed'); expect(sdk.runTurn).toHaveBeenCalledTimes(1);
	expect(result.diagnostics.verificationRecords).toEqual([expect.objectContaining({ command: 'node --version', status: 'passed', exitCode: 0 })]);
	expect(vi.mocked(run).mock.calls.every(([command, argv]) => !`${command} ${argv.join(' ')}`.includes('git commit'))).toBe(true);
});
it('publishes original failed provider measurements and complete raw clocks as a failed sandbox result without manufacturing a successful response or an incomplete receipt', async () => {
	const result = await suppliedGuestExecution(new Error('Original controlled provider exit 23.'));
	expect(result.status).toBe('failed'); expect(result.summary).toBe('Codex execution failed: Original controlled provider exit 23.');
	expect(result.responseMarkdown).toBeUndefined();
	expect(result.diagnostics.providerEvents).toHaveLength(2);
	await expect(suppliedGuestExecution(new Error('Original controlled provider exit 23.'), true)).rejects.toThrow('Agent timing-awareness contract requires');
});

it('retains observed SDK usage and transcript when real closeout command validation rejects a reported description', async () => {
	const result = await suppliedGuestExecution(undefined, false, true);
	expect(result.status).toBe('failed');
	expect(result.summary).toContain('Runner-observed verification failed');
	expect(result.responseMarkdown).toBeUndefined();
	expect(result.diagnostics.providerEvents).toHaveLength(2);
});

it('corrects the rejected completion in one original SDK session with fresh clocks and summed actual turn usage', async () => {
 const result = await suppliedGuestExecution(undefined, false, true, true);
 expect(result.status).toBe('completed'); expect(sdk.construct).toHaveBeenCalledTimes(1); expect(sdk.runTurn).toHaveBeenCalledTimes(2);
 const feedback = JSON.parse(sdk.runTurn.mock.calls[1]![0].input);
 expect(feedback).toMatchObject({ type: 'activity-completion-rejected', validationFailure: { code: 'activity_verification_failed' } });
 expect(sdk.runTurn.mock.calls[1]![0].timeoutMs).toBeLessThan(sdk.runTurn.mock.calls[0]![0].timeoutMs);
 expect(result.diagnostics.closeoutFailures).toEqual([expect.objectContaining({ message: expect.stringContaining('exit 127') })]);
 expect(result.diagnostics.verificationRecords).toEqual([expect.objectContaining({ command: 'node --version', status: 'passed', exitCode: 0 })]);
});

it('returns rejected source-preparation metadata to the same guest model without replaying mutation or moving its deadline', async () => {
	const result = await suppliedGuestExecution(undefined, false, true, true, false, true);
	expect(sdk.construct).toHaveBeenCalledTimes(1); expect(sdk.runTurn).toHaveBeenCalledTimes(2);
	const feedback = JSON.parse(sdk.runTurn.mock.calls[1]![0].input);
	expect(feedback).toMatchObject({ type: 'activity-completion-rejected', validationFailure: { code: 'activity_verification_report_invalid' } });
	expect(feedback.validationFailure.message).toContain('git commit');
	expect(result.diagnostics.closeoutFailures).toEqual([expect.objectContaining({ code: 'activity_verification_report_invalid', response: expect.stringContaining('git commit') })]);
	expect(result.diagnostics.verificationRecords).toEqual([expect.objectContaining({ command: 'node --version', status: 'passed', exitCode: 0 })]);
	expect(vi.mocked(run).mock.calls.every(([binary, args]) => !`${binary} ${args.join(' ')}`.includes('git commit'))).toBe(true);
	expect(sdk.runTurn.mock.calls[1]![0].timeoutMs).toBeLessThan(sdk.runTurn.mock.calls[0]![0].timeoutMs);
});

it('removes private guest configuration and supplied auth on preparation denial while retaining the protected credential return', async () => {
	const outcomes: Array<{ mode: string; privateFiles: string[] }> = [];
	for (const mode of ['invalid-context', 'missing-subscription']) {
		const { files, held, execution, privateRoot, suppliedAuth } = suppliedGuestFiles(mode); mockGuestFiles(files);
		response(JSON.stringify({ ...execution, observedAt: execution.startedAt, remainingSeconds: 30 }));
		await expect(runModelWorkload()).rejects.toThrow(mode === 'invalid-context' ? 'assignment_exact_proposal_context_required' : 'Authorized Codex subscription credential is missing');
		outcomes.push({ mode, privateFiles: ['config.toml', 'auth.json', 'activity-completion.schema.json'].filter(name => files.has(privateRoot + name)) });
		for (const [path, value] of held) expect(files.get(path)).toEqual(value);
		if (mode === 'invalid-context') expect(files.get('/run/treeseed-output/codex-auth.json')).toEqual(suppliedAuth);
		else expect(files.has('/run/treeseed-output/codex-auth.json')).toBe(false);
	}
	expect(outcomes, JSON.stringify(outcomes)).toEqual([{ mode: 'invalid-context', privateFiles: [] }, { mode: 'missing-subscription', privateFiles: [] }]);
	// Mocked filesystem/HTTPS INPUTS: cleanup UNIT, not native model/credential issuance.
});
