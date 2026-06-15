import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageRoot } from './package-tools.ts';

const require = createRequire(import.meta.url);
const dockerContextRoot = resolve(packageRoot, '.treeseed', 'docker');
const sdkTarballPath = resolve(dockerContextRoot, 'treeseed-sdk.tgz');
const runtimeRoot = resolve(dockerContextRoot, 'runtime');
const prepareOnly = process.argv.includes('--prepare-only');
const imageTag = process.env.TREESEED_AGENT_IMAGE_TAG || 'local';
const roleImages = {
	api: process.env.TREESEED_AGENT_API_IMAGE || `treeseed/agent-api:${imageTag}`,
	manager: process.env.TREESEED_AGENT_MANAGER_IMAGE || `treeseed/agent-manager:${imageTag}`,
	runner: process.env.TREESEED_AGENT_RUNNER_IMAGE || `treeseed/agent-runner:${imageTag}`,
} as const;

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

function resolveSdkPackageRoot() {
	const siblingRoot = resolve(packageRoot, '..', 'sdk');
	if (existsSync(resolve(siblingRoot, 'package.json'))) {
		return siblingRoot;
	}
	let current = dirname(require.resolve('@treeseed/sdk', { paths: [packageRoot] }));
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
	let lastCandidate: string | null = null;
	while (true) {
		const candidate = resolve(current, 'node_modules');
		if (existsSync(candidate)) {
			lastCandidate = candidate;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (!lastCandidate) {
		throw new Error('Missing node_modules. Run npm install before building the capacity provider image.');
	}
	return lastCandidate;
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
	const runtimePackages = runtimePackageFilter();
	rmSync(runtimeRoot, { recursive: true, force: true });
	mkdirSync(runtimeRoot, { recursive: true });
	copyFileSync(resolve(packageRoot, 'package.json'), resolve(runtimeRoot, 'package.json'));
	copyFileSync(resolve(packageRoot, 'package-lock.json'), resolve(runtimeRoot, 'package-lock.json'));
	cpSync(installedNodeModules, resolve(runtimeRoot, 'node_modules'), {
		recursive: true,
		filter(source) {
			const relativePath = source.slice(installedNodeModules.length).replace(/^[/\\]/u, '');
			if (!relativePath) return true;
			if (relativePath === '.bin' || relativePath.startsWith(`.bin${process.platform === 'win32' ? '\\' : '/'}`)) return false;
			if (relativePath === '.vite' || relativePath.startsWith(`.vite${process.platform === 'win32' ? '\\' : '/'}`)) return false;
			if (relativePath === '@treeseed' || relativePath.startsWith(`@treeseed${process.platform === 'win32' ? '\\' : '/'}`)) return false;
			return runtimePackages(relativePath);
		},
	});
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
	pruneExtraneousDependenciesFromRuntimeTree();
	pruneDevDependenciesFromRuntimeTree();
}

function runtimePackageFilter() {
	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, { dev?: boolean }>;
	};
	const allowed = new Set<string>();
	const allowedScopes = new Set<string>();
	for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
		if (!packagePath.startsWith('node_modules/') || metadata.dev === true) continue;
		const packageName = topLevelPackageName(packagePath.slice('node_modules/'.length));
		if (!packageName) continue;
		allowed.add(packageName);
		if (packageName.startsWith('@')) allowedScopes.add(packageName.split('/')[0] ?? '');
	}
	return (relativePath: string) => {
		const packageName = topLevelPackageName(relativePath);
		if (!packageName) return false;
		if (packageName.startsWith('@') && !packageName.includes('/')) return allowedScopes.has(packageName);
		return allowed.has(packageName);
	};
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

function pruneExtraneousDependenciesFromRuntimeTree() {
	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, unknown>;
	};
	const allowed = new Set<string>();
	for (const packagePath of Object.keys(lockfile.packages ?? {})) {
		if (!packagePath.startsWith('node_modules/')) continue;
		const parts = packagePath.slice('node_modules/'.length).split('/');
		if (parts[0]?.startsWith('@')) {
			if (parts.length >= 2) allowed.add(`${parts[0]}/${parts[1]}`);
		} else if (parts[0]) {
			allowed.add(parts[0]);
		}
	}
	allowed.add('@treeseed/sdk');
	const nodeModulesRoot = resolve(runtimeRoot, 'node_modules');
	for (const entry of readdirSync(nodeModulesRoot)) {
		const entryPath = resolve(nodeModulesRoot, entry);
		if (!entry.startsWith('@')) {
			if (!allowed.has(entry)) rmSync(entryPath, { recursive: true, force: true });
			continue;
		}
		for (const scopedEntry of readdirSync(entryPath)) {
			const packageName = `${entry}/${scopedEntry}`;
			if (!allowed.has(packageName)) {
				rmSync(resolve(entryPath, scopedEntry), { recursive: true, force: true });
			}
		}
		try {
			if (readdirSync(entryPath).length === 0) {
				rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {
		}
	}
}

function pruneDevDependenciesFromRuntimeTree() {
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

run('npm', ['run', 'build:dist'], packageRoot);
const installedSdkRoot = packSdk();
prepareRuntimeDependencies(installedSdkRoot);
if (prepareOnly) {
	console.log(`Prepared capacity provider Docker context at ${dockerContextRoot}.`);
	process.exit(0);
}
run('docker', ['build', '--target', 'agent-api', '-t', roleImages.api, '.'], packageRoot);
run('docker', ['build', '--target', 'agent-manager', '-t', roleImages.manager, '.'], packageRoot);
run('docker', ['build', '--target', 'agent-runner', '-t', roleImages.runner, '.'], packageRoot);
if (!process.env.TREESEED_CAPACITY_PROVIDER_IMAGE) {
	run('docker', ['tag', roleImages.api, 'capacity-provider:local'], packageRoot);
} else {
	run('docker', ['tag', roleImages.api, process.env.TREESEED_CAPACITY_PROVIDER_IMAGE], packageRoot);
}
console.log(`Built ${roleImages.api}, ${roleImages.manager}, and ${roleImages.runner} from ${packageRoot}.`);
