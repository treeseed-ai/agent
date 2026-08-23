import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageRoot } from '../../packages/package-tools.ts';

const require = createRequire(import.meta.url);
const dockerContextRoot = resolve(packageRoot, '.treeseed', 'docker');
const sdkTarballPath = resolve(dockerContextRoot, 'treeseed-sdk.tgz');
const prepareOnly = process.argv.includes('--prepare-only');
const selectedRoles = parseSelectedRoles();
const noCache = process.argv.includes('--no-cache') || process.env.TREESEED_AGENT_BUILD_NO_CACHE === '1';
const imageTag = process.env.TREESEED_AGENT_IMAGE_TAG || 'local';
const dockerBuildAttempts = Number(process.env.TREESEED_AGENT_DOCKER_BUILD_ATTEMPTS ?? 3);
const roleImages = {
	manager: process.env.TREESEED_AGENT_MANAGER_IMAGE || `treeseed/agent-manager:${imageTag}`,
	runner: process.env.TREESEED_AGENT_RUNNER_IMAGE || `treeseed/agent-runner:${imageTag}`,
} as const;
type RoleName = keyof typeof roleImages;

function sharedRuntimeRoot() {
	return resolve(dockerContextRoot, 'runtime', 'shared');
}

function parseSelectedRoles(): Set<RoleName> {
	const rolesFlagIndex = process.argv.indexOf('--roles');
	const rawRoles = rolesFlagIndex >= 0 ? process.argv[rolesFlagIndex + 1] : process.env.TREESEED_AGENT_BUILD_ROLES;
	const allRoles: RoleName[] = ['manager', 'runner'];
	if (!rawRoles) return new Set(allRoles);
	const selected = new Set<RoleName>();
	for (const rawRole of rawRoles.split(',').map((role) => role.trim()).filter(Boolean)) {
		if (rawRole !== 'manager' && rawRole !== 'runner') {
			throw new Error(`Unsupported capacity provider image role: ${rawRole}`);
		}
		selected.add(rawRole);
	}
	if (selected.size === 0) throw new Error('At least one capacity provider image role must be selected.');
	return selected;
}

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
	}
}

function runCapture(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'pipe',
		encoding: 'utf8',
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} ${args.join(' ')} failed`);
	}
	return (result.stdout ?? '').trim();
}

function sleepSync(ms: number) {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientDockerBuildFailure(output: string) {
	return /registry-1\.docker\.io|failed to resolve source metadata|failed to do request|lookup .* no such host|i\/o timeout|TLS handshake timeout|network is unreachable|temporary failure|connection reset|connection refused/iu.test(output);
}

function runDockerBuildWithRetry(args: string[], cwd: string) {
	const attempts = Number.isFinite(dockerBuildAttempts) && dockerBuildAttempts > 0
		? Math.floor(dockerBuildAttempts)
		: 1;
	let lastOutput = '';
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = spawnSync('docker', args, {
			cwd,
			stdio: 'pipe',
			encoding: 'utf8',
			env: process.env,
		});
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
		lastOutput = output.trim();
		if (output) {
			process.stdout.write(output);
			if (!output.endsWith('\n')) process.stdout.write('\n');
		}
		if (result.status === 0) return;
		if (attempt >= attempts || !isTransientDockerBuildFailure(output)) {
			throw new Error(`docker ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
		}
		const delayMs = Math.min(30_000, 2_000 * attempt);
		process.stderr.write(`Docker build failed with a transient registry/network error; retrying attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s.\n`);
		sleepSync(delayMs);
	}
	throw new Error(lastOutput || `docker ${args.join(' ')} failed`);
}

function resolveSdkPackageRoot() {
	const siblingRoot = resolve(packageRoot, '..', 'sdk');
	if (existsSync(resolve(siblingRoot, 'package.json'))) {
		return siblingRoot;
	}
	let current = dirname(require.resolve('@treeseed/sdk/standards', { paths: [packageRoot] }));
	while (true) {
		const candidate = resolve(current, 'package.json');
		if (existsSync(candidate)) {
			try {
				const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
				if (pkg.name === '@treeseed/sdk') {
					return current;
				}
			} catch {
				// Continue walking upward; package root discovery is best-effort.
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error('Unable to resolve @treeseed/sdk package root.');
}

function resolveInstalledNodeModulesRoot() {
	let current = packageRoot;
	while (true) {
		const candidate = resolve(current, 'node_modules');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error('Missing node_modules. Run npm install before building the capacity provider image.');
}

function packSdk() {
	const sdkRoot = resolveSdkPackageRoot();
	if (existsSync(resolve(sdkRoot, 'src'))) {
		run('npm', ['run', 'build:dist'], sdkRoot);
	} else {
		return sdkRoot;
	}
	mkdirSync(dockerContextRoot, { recursive: true });
	rmSync(sdkTarballPath, { force: true });
	const output = runCapture('npm', ['pack', '--ignore-scripts', '--pack-destination', dockerContextRoot], sdkRoot);
	const filename = output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!filename) {
		throw new Error('npm pack did not report an SDK tarball filename.');
	}
	const packedPath = resolve(dockerContextRoot, filename);
	if (packedPath !== sdkTarballPath) {
		renameSync(packedPath, sdkTarballPath);
	}
	return null;
}

function prepareRuntimeDependencies(installedSdkRoot: string | null) {
	const installedNodeModules = resolveInstalledNodeModulesRoot();
	const runtimePackages = runtimePackageNames(installedNodeModules);
	const runtimeRoot = sharedRuntimeRoot();
	rmSync(runtimeRoot, { recursive: true, force: true });
	mkdirSync(runtimeRoot, { recursive: true });
	copyFileSync(resolve(packageRoot, 'package.json'), resolve(runtimeRoot, 'package.json'));
	copyFileSync(resolve(packageRoot, 'package-lock.json'), resolve(runtimeRoot, 'package-lock.json'));
	mkdirSync(resolve(runtimeRoot, 'node_modules'), { recursive: true });
	for (const packageName of runtimePackages) {
		if (packageName === '@treeseed/sdk') continue;
		copyRuntimePackage(installedNodeModules, packageName, runtimeRoot);
	}
	mkdirSync(resolve(runtimeRoot, 'node_modules', '@treeseed'), { recursive: true });
	if (installedSdkRoot) {
		cpSync(installedSdkRoot, resolve(runtimeRoot, 'node_modules', '@treeseed', 'sdk'), {
			recursive: true,
			filter(source) {
				const relativePath = source.slice(installedSdkRoot.length).replace(/^[/\\]/u, '');
				return !relativePath.startsWith(`node_modules${process.platform === 'win32' ? '\\' : '/'}`);
			},
		});
	} else {
		const extractRoot = resolve(dockerContextRoot, 'sdk-extract');
		rmSync(extractRoot, { recursive: true, force: true });
		mkdirSync(extractRoot, { recursive: true });
		run('tar', ['-xzf', sdkTarballPath, '-C', extractRoot], packageRoot);
		cpSync(resolve(extractRoot, 'package'), resolve(runtimeRoot, 'node_modules', '@treeseed', 'sdk'), { recursive: true });
		rmSync(extractRoot, { recursive: true, force: true });
	}
}

function runtimePackageNames(installedNodeModules: string) {
	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, { dev?: boolean }>;
	};
	const allowed = new Set<string>();
	const queue: string[] = [];
	for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
		if (!packagePath.startsWith('node_modules/') || metadata.dev === true) continue;
		const packageName = topLevelPackageName(packagePath.split('node_modules/').at(-1) ?? '');
		if (!packageName) continue;
		if (!allowed.has(packageName)) {
			allowed.add(packageName);
			queue.push(packageName);
		}
	}
	for (let index = 0; index < queue.length; index += 1) {
		const packageName = queue[index];
		if (!packageName) continue;
		for (const dependencyName of installedPackageDependencies(installedNodeModules, packageName)) {
			if (allowed.has(dependencyName)) continue;
			allowed.add(dependencyName);
			queue.push(dependencyName);
		}
	}
	return [...allowed].sort();
}

function installedPackageDependencies(installedNodeModules: string, packageName: string) {
	const packageJsonPath = resolve(installedNodeModules, packageName, 'package.json');
	if (!existsSync(packageJsonPath)) return [];
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		return [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.optionalDependencies ?? {}),
		];
	} catch {
		return [];
	}
}

function copyRuntimePackage(installedNodeModules: string, packageName: string, runtimeRoot: string) {
	let source = resolve(installedNodeModules, packageName);
	if (!existsSync(source)) {
		const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as { packages?: Record<string, unknown> };
		const packagePath = Object.keys(lockfile.packages ?? {}).filter((candidate) => candidate.endsWith(`node_modules/${packageName}`)).sort((left, right) => left.length - right.length).find((candidate) => existsSync(resolve(packageRoot, candidate)));
		if (packagePath) source = resolve(packageRoot, packagePath);
	}
	if (!existsSync(source)) return;
	const target = resolve(runtimeRoot, 'node_modules', packageName);
	mkdirSync(target, { recursive: true });
	run('cp', ['-a', `${source}/.`, target], packageRoot);
}

function topLevelPackageName(relativePath: string) {
	const normalized = relativePath.replace(/\\/gu, '/').replace(/^\/+/u, '');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length === 0) return null;
	if (parts[0]?.startsWith('@')) {
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
	}
	return parts[0] ?? null;
}

function pruneDevDependenciesFromRuntimeTree(runtimeRoot: string) {
	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, { dev?: boolean }>;
	};
	for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
		if (!packagePath.startsWith('node_modules/') || metadata.dev !== true) continue;
		const target = resolve(runtimeRoot, packagePath);
		rmSync(target, { recursive: true, force: true });
	}
	const nodeModulesRoot = resolve(runtimeRoot, 'node_modules');
	for (const scopeName of readdirSync(nodeModulesRoot)) {
		if (!scopeName.startsWith('@')) continue;
		const scopePath = resolve(nodeModulesRoot, scopeName);
		try {
			if (readdirSync(scopePath).length === 0) {
				rmSync(scopePath, { recursive: true, force: true });
			}
		} catch {
		}
	}
}

function pruneProviderRuntimeToolingFromRuntimeTree(runtimeRoot: string) {
	const nodeModulesRoot = resolve(runtimeRoot, 'node_modules');
	const commonTooling = [
		'@cloudflare',
		'@img',
		'miniflare',
		'playwright',
		'playwright-core',
		'wrangler',
		'workerd',
	];
	const packagePaths = commonTooling;
	for (const packagePath of packagePaths) {
		rmSync(resolve(nodeModulesRoot, packagePath), { recursive: true, force: true });
	}
	for (const scopeName of ['@cloudflare', '@github', '@img', '@openai']) {
		const scopePath = resolve(nodeModulesRoot, scopeName);
		try {
			if (readdirSync(scopePath).length === 0) rmSync(scopePath, { recursive: true, force: true });
		} catch {
		}
	}
}

run('npm', ['run', 'build:dist'], packageRoot);
const installedSdkRoot = packSdk();
rmSync(resolve(dockerContextRoot, 'runtime'), { recursive: true, force: true });
const runtimeRoot = sharedRuntimeRoot();
prepareRuntimeDependencies(installedSdkRoot);
pruneDevDependenciesFromRuntimeTree(runtimeRoot);
pruneProviderRuntimeToolingFromRuntimeTree(runtimeRoot);
if (prepareOnly) {
	console.log(`Prepared capacity provider Docker context at ${dockerContextRoot}.`);
	process.exit(0);
}
if (selectedRoles.has('manager')) {
	runDockerBuildWithRetry(['build', ...dockerBuildCacheArgs(), '--target', 'agent-manager', '-t', roleImages.manager, '.'], packageRoot);
}
if (selectedRoles.has('runner')) {
	runDockerBuildWithRetry(['build', ...dockerBuildCacheArgs(), '--target', 'agent-runner', '-t', roleImages.runner, '.'], packageRoot);
}
console.log(`Built capacity provider image roles ${[...selectedRoles].join(', ')} from ${packageRoot}.`);

function dockerBuildCacheArgs() {
	return noCache ? ['--no-cache'] : [];
}
