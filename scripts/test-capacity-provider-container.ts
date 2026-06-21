import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { packageRoot } from './package-tools.ts';

const composeFile = resolve(packageRoot, 'compose.capacity-provider.yml');
const projectName = `treeseed-capacity-provider-test-${process.pid}`;

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

async function waitForOk(url: string, expectedJson?: Record<string, unknown>) {
	const deadline = Date.now() + 90_000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				if (expectedJson) {
					const payload = await response.json().catch(() => null);
					if (!payload || typeof payload !== 'object') {
						throw new Error(`${url} did not return JSON.`);
					}
					for (const [key, value] of Object.entries(expectedJson)) {
						if ((payload as Record<string, unknown>)[key] !== value) {
							throw new Error(`${url} returned unexpected ${key}.`);
						}
					}
				}
				return;
			}
			lastError = new Error(`${url} returned ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
	}
	throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

function resetTempRootOwnership(path: string) {
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	run('docker', [
		'run',
		'--rm',
		'--user',
		'0',
		'-v',
		`${path}:/cleanup`,
		'node:22-bookworm-slim',
		'sh',
		'-c',
		`chown -R ${uid}:${gid} /cleanup && chmod -R u+rwX /cleanup`,
	], { allowFailure: true });
}

function removeTempRoot(path: string) {
	try {
		resetTempRootOwnership(path);
		rmSync(path, { recursive: true, force: true });
		return;
	} catch {
		const parent = resolve(path, '..');
		const name = basename(path);
		run('docker', [
			'run',
			'--rm',
			'--user',
			'0',
			'-v',
			`${parent}:/cleanup-parent`,
			'node:22-bookworm-slim',
			'sh',
			'-c',
			`rm -rf /cleanup-parent/${name}`,
		], { allowFailure: true });
		rmSync(path, { recursive: true, force: true });
	}
}

const dockerInfo = capture('docker', ['info']);
if (dockerInfo.status !== 0) {
	throw new Error('Docker is required for capacity provider container smoke in Phase I verification.');
}

if (!existsSync(composeFile)) {
	throw new Error(`Missing ${composeFile}.`);
}

run('npm', ['run', 'capacity-provider:build', '--', '--roles', 'api', '--no-cache']);

const tempParent = resolve(packageRoot, '.treeseed', 'tmp');
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(join(tempParent, 'treeseed-capacity-provider-container-'));
const hostDataDir = resolve(tempRoot, 'data');
mkdirSync(hostDataDir, { recursive: true });
chmodSync(hostDataDir, 0o777);
writeFileSync(resolve(hostDataDir, '.writable-probe'), 'ok\n', 'utf8');

const apiPort = String(await findFreePort());
const composeEnv = {
	...process.env,
	TREESEED_MARKET_URL: 'http://127.0.0.1:3000',
	TREESEED_MARKET_ID: 'local',
	TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_diagnostic_container_key',
	TREESEED_PROVIDER_HOST_DATA_DIR: hostDataDir,
	TREESEED_PROVIDER_CHOWN_DATA: '0',
	TREESEED_PROVIDER_HOST_API_PORT: apiPort,
	TREESEED_PROVIDER_API_PORT: '3100',
	TREESEED_PROVIDER_ENVIRONMENT: 'local',
	TREESEED_PROVIDER_STARTUP_MODE: 'diagnostic',
};
let smokePassed = false;

try {
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'down', '-v', '--remove-orphans'], { env: composeEnv, allowFailure: true });
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'up', '-d', 'api'], { env: composeEnv });
	await waitForOk(`http://127.0.0.1:${apiPort}/healthz`, { ok: true, service: 'capacity-provider', role: 'api' });
	await waitForOk(`http://127.0.0.1:${apiPort}/readyz`, { ok: true, ready: true });
	writeFileSync(resolve(hostDataDir, '.writable-probe-after-up'), 'ok\n', 'utf8');
	smokePassed = true;
	console.log(`Capacity provider diagnostic container smoke passed on port ${apiPort}.`);
} finally {
	if (!smokePassed) {
		run('docker', ['compose', '-f', composeFile, '-p', projectName, 'ps'], { env: composeEnv, allowFailure: true });
		run('docker', ['compose', '-f', composeFile, '-p', projectName, 'logs', '--no-color', 'api'], { env: composeEnv, allowFailure: true });
	}
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'down', '-v'], { env: composeEnv, allowFailure: true });
	removeTempRoot(tempRoot);
}
