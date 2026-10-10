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
	vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => { calls.push({ method: request.method, path: request.url, body: JSON.parse(body) });
			response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: f.receipt })); });
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native controlled address required');
		const sdk = createRequire(import.meta.url).resolve('@treeseed/sdk/control-plane-client');
		const operations = createRequire(import.meta.url).resolve('@treeseed/sdk/operator-contracts');
		const helper = new URL('../../acceptance/campaign.ts', import.meta.url).href;
		const code = `import{ControlPlaneClient,defaultLocalControlPlaneServer}from ${JSON.stringify(sdk)};
import{controlPlaneOperation}from ${JSON.stringify(operations)};
import{retainCampaignWorkdayStart}from ${JSON.stringify(helper)};
const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:${JSON.stringify(`http://127.0.0.1:${address.port}`)}}),accessToken:'controlled-native-input'});
const response=await client.invoke(controlPlaneOperation('workdays.start'),{path:{teamId:'controlled-team'},query:{},body:${JSON.stringify({ preflightId: f.receipt.preflightId, preflightDigest: f.receipt.preflightDigest, idempotencyKey: `golden-start:${f.receipt.preflightId}` })}});
retainCampaignWorkdayStart(response.data,${JSON.stringify(f.path)},${JSON.stringify(f.freeze)});
process.stdout.write(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID);`;
		const execute = promisify(execFile), options = { cwd: new URL('../../../', import.meta.url), timeout: 5_000, maxBuffer: 131_072, env: { ...process.env }, killSignal: 'SIGKILL' as const };
		const first = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], options);
		expect(first.stdout).toBe(f.receipt.workdayId); expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe('');
		const second = await execute(process.execPath, ['--input-type=module', '-e', `import{readFileSync}from'node:fs';process.stdout.write(readFileSync(${JSON.stringify(f.retained)},'utf8'));`], options);
		expect(JSON.parse(second.stdout)).toEqual(f.receipt); expect(readFileSync(f.path)).toEqual(f.bytes);
		expect(calls).toEqual([{ method: 'POST', path: '/v1/teams/controlled-team/workdays/start', body: { preflightId: f.receipt.preflightId,
			preflightDigest: f.receipt.preflightDigest, idempotencyKey: `golden-start:${f.receipt.preflightId}` } }]);
		// Real SDK/HTTP and isolated native processes; API admission is controlled.
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		f.close();
	}
	expect(server.listening).toBe(false); expect(existsSync(f.root)).toBe(false);
}, 30_000);
