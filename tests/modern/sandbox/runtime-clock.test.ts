import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, Stats } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { sandboxAssignmentSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { clockRequest } from './architecture/clock-fixture.ts';
import { objectDigest } from '../../../src/sandbox/verification.ts';
import { invokeTreeDxRelay, runSandboxGuest, timingAwarenessContract } from '../../../src/sandbox/guest.ts';

vi.mock('node:https', () => ({ request: vi.fn() }));
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

it('removes private guest configuration and supplied auth on preparation denial while retaining the protected credential return', async () => {
	for (const mode of ['invalid-context', 'missing-subscription']) {
		const { attempt, execution } = clockRequest();
		const context = { identity: { manifest: {} }, canonicalAssignmentContext: { assignment: { ...attempt,
			workspace: { mode: 'read-only' }, effectiveProfile: { activity: 'chat', handler: 'writer' } }, context: [], predecessorResults: [] } };
		const bytes = Buffer.from(JSON.stringify(context)), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
		const assignment = sandboxAssignmentSchema.parse({ schemaVersion: 'treeseed.sandbox-assignment/v1', assignmentId: attempt.id,
			attempt: attempt.attempt, runnerId: 'supplied-unit', providerId: attempt.provider.providerId, teamId: attempt.teamId, projectId: attempt.projectId,
			profile: 'supplied-unit', guestImage: 'supplied-unit', guestImageDigest: digest, identityManifestDigest: objectDigest(context.identity.manifest),
			contextManifestDigest: digest, resources: { cpuCores: 1, memoryBytes: 536870912, diskBytes: 67108864, durationSeconds: 30, processLimit: 32, outputBytes: 1048576 },
			inputs: [{ id: 'execution-context', digest, bytes: bytes.length, disposition: 'copy-on-write', mediaType: 'application/json', targetPath: '/workspace/.treeseed/context.json' }],
			outputs: [], network: { defaultDeny: true, relayUrl: 'https://relay.invalid:7444', allowedServices: ['treedx', 'codex-subscription'] },
			modelPolicy: { provider: 'supplied-unit', model: 'not-a-real-model', capabilities: [] }, credentialHandles: [], treeDxHandleIds: [],
			leaseExpiresAt: attempt.deadline, signature: { keyId: 'supplied-unit', algorithm: 'Ed25519', value: 'supplied-not-issued' } });
		const root = '/run/treeseed-assignment/', privateRoot = '/workspace/.treeseed/codex/', suppliedAuth = Buffer.from('{"access_token":"supplied-unit-credential"}');
		const files = new Map<string, Buffer>([[`${root}assignment.json`, Buffer.from(JSON.stringify(assignment))], [`${root}input-execution-context`, bytes],
			[`${root}sandbox-id`, Buffer.from('supplied-unit')], [`${root}operation-token`, Buffer.from('supplied-unit-token')],
			['/workspace/.treeseed/relay-ca.crt', Buffer.from('supplied-ca')]]);
		if (mode === 'invalid-context') files.set(`${root}codex-auth.json`, suppliedAuth);
		const held = new Map(files);
		vi.mocked(readFile).mockImplementation(async (path, options) => {
			const value = files.get(String(path)); if (!value) throw Object.assign(new Error('missing supplied input'), { code: 'ENOENT' });
			return options === 'utf8' ? value.toString('utf8') : value;
		});
		vi.mocked(writeFile).mockImplementation(async (path, data) => { files.set(String(path), Buffer.from(String(data))); });
		vi.mocked(mkdir).mockResolvedValue(undefined);
		vi.mocked(rm).mockImplementation(async path => { files.delete(String(path)); });
		vi.mocked(stat).mockImplementation(async path => { const value = files.get(String(path));
			if (!value) throw Object.assign(new Error('missing supplied input'), { code: 'ENOENT' });
			return Object.assign(new Stats(), { size: value.length }); });
		vi.mocked(createReadStream).mockImplementation(path => Object.assign(Readable.from([files.get(String(path))]), { path: String(path), pending: false, close() {} }));
		response(JSON.stringify({ ...execution, observedAt: execution.startedAt, remainingSeconds: 30 }));
		await expect(runSandboxGuest()).rejects.toThrow(mode === 'invalid-context' ? 'assignment_exact_proposal_context_required' : 'Authorized Codex subscription credential is missing');
		for (const name of ['config.toml', 'auth.json', 'activity-completion.schema.json']) expect(files.has(privateRoot + name), `${mode}: ${name}`).toBe(false);
		for (const [path, value] of held) expect(files.get(path)).toEqual(value);
		if (mode === 'invalid-context') expect(files.get('/run/treeseed-output/codex-auth.json')).toEqual(suppliedAuth);
		else expect(files.has('/run/treeseed-output/codex-auth.json')).toBe(false);
	}
	// Mocked filesystem/HTTPS INPUTS: cleanup UNIT, not native model/credential issuance.
});
