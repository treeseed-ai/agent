import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from './package-tools.ts';

const composeFile = resolve(packageRoot, 'compose.capacity-provider.yml');
const projectName = `treeseed-capacity-provider-test-${process.pid}`;
const minimumDockerFreeKilobytes = 2 * 1024 * 1024;

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

function dockerStoragePath() {
	const info = capture('docker', ['info', '--format', '{{.DockerRootDir}}']);
	if (info.status === 0 && info.stdout.trim().length > 0) {
		return info.stdout.trim();
	}
	return '/var/lib/docker';
}

function ensureDockerStorageHeadroom() {
	const root = dockerStoragePath();
	const result = capture('df', ['-Pk', root]);
	if (result.status !== 0) return;
	const line = result.stdout.trim().split(/\r?\n/u).at(-1);
	const fields = line?.trim().split(/\s+/u) ?? [];
	const availableKilobytes = Number(fields[3] ?? Number.NaN);
	if (!Number.isFinite(availableKilobytes) || availableKilobytes >= minimumDockerFreeKilobytes) return;
	const availableGiB = (availableKilobytes / 1024 / 1024).toFixed(1);
	const requiredGiB = (minimumDockerFreeKilobytes / 1024 / 1024).toFixed(1);
	throw new Error([
		`Docker storage at ${root} has only ${availableGiB} GiB free; capacity-provider:test-local needs at least ${requiredGiB} GiB before building images.`,
		'Free Docker space explicitly, for example: docker system prune -a --volumes',
	].join('\n'));
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
ensureDockerStorageHeadroom();

if (!existsSync(composeFile)) {
	throw new Error(`Missing ${composeFile}.`);
}

run('npm', ['run', 'capacity-provider:build', '--', '--roles', 'manager,runner', '--no-cache']);

const tempParent = resolve(tmpdir(), 'treeseed-agent-container-smoke');
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(join(tempParent, 'treeseed-capacity-provider-container-'));
const hostDataDir = resolve(tempRoot, 'data');
mkdirSync(hostDataDir, { recursive: true });
chmodSync(hostDataDir, 0o777);
writeFileSync(resolve(hostDataDir, '.writable-probe'), 'ok\n', 'utf8');
const manifestPath = resolve(tempRoot, 'treeseed.capacity-provider.yaml');
writeFileSync(manifestPath, [
	'schemaVersion: 2',
	'identity:',
	'  displayName: Container diagnostic provider',
	'  privateKeyRef: file://secrets/provider-identity.json',
	'executionProviders:',
	'  - id: diagnostic',
	'    adapter: codex',
	'    nativeLimits:',
	'      maxConcurrentRunners: 1',
	'    capabilities: [engineering, research]',
	'connections: []',
	'',
].join('\n'), 'utf8');

const composeEnv = {
	...process.env,
	TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
	TREESEED_PROVIDER_HOST_DATA_DIR: hostDataDir,
	TREESEED_PROVIDER_CHOWN_DATA: '0',
	TREESEED_PROVIDER_ENVIRONMENT: 'local',
	TREESEED_PROVIDER_STARTUP_MODE: 'diagnostic',
};
let smokePassed = false;

try {
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'down', '-v', '--remove-orphans'], { env: composeEnv, allowFailure: true });
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'config'], { env: composeEnv });
	writeFileSync(resolve(hostDataDir, '.writable-probe-after-up'), 'ok\n', 'utf8');
	smokePassed = true;
	console.log('Capacity provider manager/runner image and compose smoke passed.');
} finally {
	if (!smokePassed) {
		run('docker', ['compose', '-f', composeFile, '-p', projectName, 'ps'], { env: composeEnv, allowFailure: true });
	}
	run('docker', ['compose', '-f', composeFile, '-p', projectName, 'down', '-v'], { env: composeEnv, allowFailure: true });
	removeTempRoot(tempRoot);
}
