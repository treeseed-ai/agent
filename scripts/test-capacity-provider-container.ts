import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { packageRoot } from './package-tools.ts';

const composeFile = resolve(packageRoot, 'compose.capacity-provider.yml');
const projectName = 'treeseed-capacity-provider-test';

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		stdio: 'inherit',
		env: options.env ?? process.env,
	});
	if (!options.allowFailure && result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
	}
	return result.status ?? 1;
}

function capture(command: string, args: string[]) {
	return spawnSync(command, args, {
		cwd: packageRoot,
		stdio: 'pipe',
		encoding: 'utf8',
		env: process.env,
	});
}

async function findFreePort() {
	return await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 3199;
			server.close(() => resolvePort(port));
		});
	});
}

async function waitForOk(url: string) {
	const deadline = Date.now() + 45_000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
			lastError = new Error(`${url} returned ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
	}
	throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

const dockerInfo = capture('docker', ['info']);
if (dockerInfo.status !== 0) {
	console.log('Docker is not available; skipping capacity provider container smoke.');
	process.exit(0);
}

if (!existsSync(composeFile)) {
	throw new Error(`Missing ${composeFile}.`);
}

run('npm', ['run', 'capacity-provider:build']);

const tempRoot = mkdtempSync(join(tmpdir(), 'treeseed-capacity-provider-container-'));
const hostDataDir = resolve(tempRoot, 'data');
mkdirSync(hostDataDir, { recursive: true });
writeFileSync(resolve(hostDataDir, '.writable-probe'), 'ok\n', 'utf8');

const apiPort = String(await findFreePort());
const composeEnv = {
	...process.env,
	TREESEED_MARKET_URL: 'http://127.0.0.1:3000',
	TREESEED_MARKET_ID: 'local',
	TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_diagnostic_container_key',
	TREESEED_PROVIDER_HOST_DATA_DIR: hostDataDir,
	TREESEED_PROVIDER_HOST_API_PORT: apiPort,
	TREESEED_PROVIDER_API_PORT: '3100',
	TREESEED_PROVIDER_ENVIRONMENT: 'local',
	TREESEED_PROVIDER_STARTUP_MODE: 'diagnostic',
};

try {
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'up', '-d', 'api'], { env: composeEnv });
	await waitForOk(`http://127.0.0.1:${apiPort}/healthz`);
	await waitForOk(`http://127.0.0.1:${apiPort}/readyz`);
	writeFileSync(resolve(hostDataDir, '.writable-probe-after-up'), 'ok\n', 'utf8');
	console.log(`Capacity provider diagnostic container smoke passed on port ${apiPort}.`);
} finally {
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'down', '-v'], { env: composeEnv, allowFailure: true });
	rmSync(tempRoot, { recursive: true, force: true });
}
