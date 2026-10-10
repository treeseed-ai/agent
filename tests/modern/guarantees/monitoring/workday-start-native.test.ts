import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { workdayStartFixture } from './workday-start-fixture.ts';

afterEach(() => vi.unstubAllEnvs());
it('native public SDK start and independent child preserve the exact API receipt across process isolation without replaying admission', async () => {
	const f = workdayStartFixture(), calls: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
	let mode = 'exact'; const failed: unknown[] = [];
	vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => { calls.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : undefined });
			response.setHeader('content-type', 'application/json');
			if (request.method === 'POST') { response.end(JSON.stringify({ data: f.receipt })); return; }
			if (mode === 'denied') { failed.push({ mode, status: 403 }); response.writeHead(403).end(JSON.stringify({ status: 403, code: 'controlled-read-denied', title: 'Controlled denial' })); return; }
			if (mode === 'interrupted') { failed.push({ mode }); request.socket.destroy(); return; }
			const run = structuredClone(f.run);
			if (mode === 'foreign-team') run.teamId = 'foreign'; if (mode === 'foreign-workday') run.id = 'workday-22222222-2222-4222-8222-222222222222';
			if (mode === 'changed-clock') run.startedAt = '2026-10-10T20:00:01.000Z';
			if (mode !== 'exact') failed.push({ mode, run: structuredClone(run) });
			response.end(JSON.stringify({ data: { run } })); });
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native controlled address required');
		const sdk = createRequire(import.meta.url).resolve('@treeseed/sdk/control-plane-client');
		const operations = createRequire(import.meta.url).resolve('@treeseed/sdk/operator-contracts');
		const helper = new URL('../../../acceptance/campaign.ts', import.meta.url).href;
		const code = `import{ControlPlaneClient,defaultLocalControlPlaneServer}from ${JSON.stringify(sdk)};
import{controlPlaneOperation}from ${JSON.stringify(operations)};
import{retainCampaignWorkdayStart}from ${JSON.stringify(helper)};
const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:${JSON.stringify(`http://127.0.0.1:${address.port}`)}}),accessToken:'controlled-native-input'});
const response=await client.invoke(controlPlaneOperation('workdays.start'),{path:{teamId:'controlled-team'},query:{},body:${JSON.stringify({ preflightId: f.receipt.preflightId, preflightDigest: f.receipt.preflightDigest, idempotencyKey: `golden-start:${f.receipt.preflightId}` })}});
retainCampaignWorkdayStart(response.data,${JSON.stringify(f.path)},${JSON.stringify(f.freeze)});
process.stdout.write(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID);`;
		const execute = promisify(execFile), options = { cwd: new URL('../../../../', import.meta.url), timeout: 5_000, maxBuffer: 131_072, env: { ...process.env }, killSignal: 'SIGKILL' as const };
		const first = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], options);
		expect(first.stdout).toBe(f.receipt.workdayId); expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe('');
		const held = readFileSync(f.retained);
		const duplicate = `import{retainCampaignWorkdayStart}from ${JSON.stringify(helper)};retainCampaignWorkdayStart(${JSON.stringify(f.receipt)},${JSON.stringify(f.path)},${JSON.stringify(f.freeze)});`;
		await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', duplicate], options)));
		expect(readFileSync(f.retained)).toEqual(held);
		// A terminated writer cannot erase the captured authority or re-admit a run.
		await expect(execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
			`${duplicate}process.kill(process.pid,'SIGKILL');`], options)).rejects.toMatchObject({ signal: 'SIGKILL' });
		expect(readFileSync(f.retained)).toEqual(held);
		const publicRead = `import{ControlPlaneClient,defaultLocalControlPlaneServer}from ${JSON.stringify(sdk)};
import{controlPlaneOperation}from ${JSON.stringify(operations)};
const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:${JSON.stringify(`http://127.0.0.1:${address.port}`)}}),accessToken:'controlled-native-input'});
const observed=await client.invoke(controlPlaneOperation('workdays.show'),{path:{teamId:'controlled-team',runId:${JSON.stringify(f.receipt.workdayId)}},query:{},body:undefined});`;
		const consume = `${publicRead}
import assert from'node:assert/strict';
import{campaignWorkdayId}from ${JSON.stringify(helper)};
const id=campaignWorkdayId((args,team)=>{assert.deepEqual(args,['workdays','show',${JSON.stringify(f.receipt.workdayId)}]);assert.equal(team,'controlled-team');
return observed.data;},'controlled-team',{TREESEED_ACCEPTANCE_FREEZE_PATH:${JSON.stringify(f.path)}});process.stdout.write(id);`;
		const observe = () => execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', consume], options);
		expect((await observe()).stdout).toBe(f.receipt.workdayId);
		for (const denied of ['foreign-team', 'foreign-workday', 'changed-clock', 'denied', 'interrupted']) {
			mode = denied; await expect(observe(), denied).rejects.toThrow(); expect(readFileSync(f.retained)).toEqual(held);
		}
		const originalFailures = structuredClone(failed); mode = 'exact'; expect((await observe()).stdout).toBe(f.receipt.workdayId);
		expect(failed).toEqual(originalFailures); expect(failed).toHaveLength(5); expect(readFileSync(f.path)).toEqual(f.bytes);
		expect(calls).toEqual([{ method: 'POST', path: '/v1/teams/controlled-team/workday-runs', body: { preflightId: f.receipt.preflightId,
			preflightDigest: f.receipt.preflightDigest, idempotencyKey: `golden-start:${f.receipt.preflightId}` } },
			...Array.from({ length: 7 }, () => ({ method: 'GET', path: `/v1/teams/controlled-team/workday-runs/${f.receipt.workdayId}`, body: undefined }))]);
		// Real SDK/HTTP and isolated native processes; API admission is controlled.
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		f.close();
	}
	expect(server.listening).toBe(false); expect(existsSync(f.root)).toBe(false);
}, 30_000);
