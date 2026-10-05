import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { invokeTreeDxRelay, timingAwarenessContract } from '../../../src/sandbox/guest.ts';

vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn() }));
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
