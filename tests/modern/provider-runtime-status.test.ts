import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { writeProviderRuntimeStatus } from '../../src/provider/runtime/runtime-status.ts';

it('never marks a failed aggregate operation as a healthy loop', async () => {
	const root = await mkdtemp(join(tmpdir(), 'provider-status-'));
	try {
		const result = { ok: false, connections: [{ ok: false, status: 'error', error: 'session exchange rejected' }] };
		const payload = await writeProviderRuntimeStatus(root, { role: 'manager', ok: true, result });
		expect(payload.ok).toBe(false);
		expect(JSON.parse(await readFile(join(root, 'runtime/manager.json'), 'utf8'))).toMatchObject({ ok: false, result });
		expect((await writeProviderRuntimeStatus(root, { role: 'manager', ok: true, result: { ok: true } })).ok).toBe(true);
		expect((await writeProviderRuntimeStatus(root, { role: 'runner', ok: false, result: { ok: true } })).ok).toBe(false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
