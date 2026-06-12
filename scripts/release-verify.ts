import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageRoot } from './package-tools.ts';

const require = createRequire(import.meta.url);
const npmCacheDir = resolve(tmpdir(), 'treeseed-npm-cache');
const textExtensions = new Set(['.js', '.ts', '.mjs', '.cjs', '.d.ts', '.json', '.md']);
const forbiddenPatterns = [
	/['"`]file:[^'"`\n]+['"`]/,
	/['"`]workspace:[^'"`\n]+['"`]/,
	/['"`](?:\.\.\/|\.\/)[^'"`\n]*src\/[^'"`\n]*\.(?:[cm]?js|ts|tsx|json|astro|css)['"`]/,
	/['"`][^'"`\n]*\/packages\/[^'"`\n]*\/src\/[^'"`\n]*['"`]/,
];

function resolveSdkPackageRoot() {
	try {
		return resolve(dirname(require.resolve('@treeseed/sdk')), '..');
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND')) {
			throw error;
		}
	}

	const siblingSdkRoot = resolve(packageRoot, '..', 'sdk');
	if (existsSync(resolve(siblingSdkRoot, 'package.json'))) {
		return siblingSdkRoot;
	}

	throw new Error('@treeseed/sdk must be installed or available as a sibling package checkout for release verification.');
}

const sdkPackageRoot = resolveSdkPackageRoot();

function ensureSdkRuntimeLink() {
	const linkPath = resolve(packageRoot, 'node_modules', '@treeseed', 'sdk');
	if (existsSync(linkPath)) {
		return;
	}
	mkdirSync(dirname(linkPath), { recursive: true });
	symlinkSync(sdkPackageRoot, linkPath, 'dir');
}

function run(command: string, args: string[], cwd = packageRoot, capture = false, extraEnv: Record<string, string> = {}) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: capture ? 'pipe' : 'inherit',
		encoding: 'utf8',
		env: {
			...process.env,
			...extraEnv,
			npm_config_cache: npmCacheDir,
			NPM_CONFIG_CACHE: npmCacheDir,
		},
	});

	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} ${args.join(' ')} failed`);
	}

	return (result.stdout ?? '').trim();
}

function runPackedProviderRuntimeSmoke(installRoot: string) {
	const dataRoot = resolve(installRoot, 'data');
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(resolve(installRoot, 'src/content/knowledge'), { recursive: true });
	mkdirSync(resolve(installRoot, 'src/content/workdays'), { recursive: true });
	mkdirSync(resolve(installRoot, 'src/content/agents'), { recursive: true });
	writeFileSync(resolve(installRoot, 'src/manifest.yaml'), [
		'siteConfigPath: treeseed.site.yaml',
		'content:',
		'  docs: src/content/knowledge',
		'  agents: src/content/agents',
		'',
	].join('\n'), 'utf8');
	writeFileSync(resolve(installRoot, 'treeseed.site.yaml'), [
		'name: Treeseed Agent Packed Smoke',
		'slug: treeseed-agent-packed-smoke',
		'siteUrl: https://example.com',
		'contactEmail: hello@example.com',
		'cloudflare:',
		'  workerName: treeseed-agent-packed-smoke',
		'providers:',
		'  agents:',
		'    execution: stub',
		'    mutation: local_branch',
		'    repository: stub',
		'    verification: stub',
		'    notification: stub',
		'    research: stub',
		'',
	].join('\n'), 'utf8');
	const env = {
		TREESEED_PROCESSING_PARITY: '1',
		TREESEED_DATA_DIR: dataRoot,
		TREESEED_RUNNER_VOLUME_ROOT: dataRoot,
		TREESEED_MANAGER_MODE: 'reconcile',
		TREESEED_ENVIRONMENT: 'local',
		TREESEED_DEPLOY_ENVIRONMENT: 'local',
		TREESEED_PROJECT_ID: 'treeseed-agent-packed-smoke',
		TREESEED_TEAM_ID: 'treeseed-agent-packed-smoke',
		TREESEED_TENANT_ROOT: installRoot,
	};
	const providerEntrypoint = 'node_modules/@treeseed/agent/dist/provider/entrypoint.js';
	run(process.execPath, [providerEntrypoint, 'version'], installRoot, false, env);
	run(process.execPath, [providerEntrypoint, 'healthcheck'], installRoot, false, env);
	run(process.execPath, [providerEntrypoint, 'register', '--dry-run'], installRoot, false, env);
	run(process.execPath, [providerEntrypoint, 'manager', '--dry-run', '--json'], installRoot, false, env);
	run(process.execPath, [providerEntrypoint, 'runner', '--dry-run', '--json'], installRoot, false, env);
	run(process.execPath, ['--input-type=module', '-e', [
		"const modules = await Promise.all([",
		"  import('./node_modules/@treeseed/agent/dist/provider/config.js'),",
		"  import('./node_modules/@treeseed/agent/dist/provider/registration.js'),",
		"  import('./node_modules/@treeseed/agent/dist/provider/lifecycle.js'),",
			"  import('./node_modules/@treeseed/agent/dist/api/provider-app.js'),",
			"  import('./node_modules/@treeseed/agent/dist/services/manager.js'),",
			"  import('./node_modules/@treeseed/agent/dist/services/worker.js'),",
			"  import('./node_modules/@treeseed/agent/dist/services/runtime-paths.js'),",
			"  import('./node_modules/@treeseed/agent/dist/agents/registry.js'),",
			"]);",
		"const registry = modules.at(-1);",
		"if (registry.listRegisteredAgentHandlers().length < 7) throw new Error('built-in handler registry is incomplete');",
		"if (typeof modules[0].resolveProviderConfig !== 'function') throw new Error('provider config import missing resolveProviderConfig');",
		"if (typeof modules[1].buildProviderRegistrationRequest !== 'function') throw new Error('provider registration import missing buildProviderRegistrationRequest');",
		"if (typeof modules[2].buildProviderPlan !== 'function') throw new Error('provider lifecycle import missing buildProviderPlan');",
			"if (typeof modules[3].createCapacityProviderApp !== 'function') throw new Error('provider app import missing createCapacityProviderApp');",
			"if (typeof modules[4].runManagerAction !== 'function') throw new Error('manager runtime import missing runManagerAction');",
			"if (typeof modules[5].runWorkerCycle !== 'function') throw new Error('worker runtime import missing runWorkerCycle');",
			"if (typeof modules[6].resolveRunnerRepositoryPaths !== 'function') throw new Error('runtime-paths import missing resolveRunnerRepositoryPaths');",
	].join('\n')], installRoot, false, env);
}

function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkFiles(fullPath));
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

function scanDirectory(root: string) {
	for (const filePath of walkFiles(root)) {
		if (!textExtensions.has(extname(filePath))) continue;
		const source = readFileSync(filePath, 'utf8');
		for (const pattern of forbiddenPatterns) {
			if (pattern.test(source)) {
				throw new Error(`${filePath} contains forbidden publish reference matching ${pattern}.`);
			}
		}
	}
}

function assertNoLocalDependencyLinks() {
	const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
	for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const [dependencyName, version] of Object.entries(packageJson[sectionName] ?? {})) {
			if (version.startsWith('workspace:') || version.startsWith('file:')) {
				throw new Error(`package.json ${sectionName}.${dependencyName} must not use local dependency specifiers: ${version}`);
			}
		}
	}

	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, { resolved?: string; link?: boolean }>;
	};
	for (const [entryKey, entryValue] of Object.entries(lockfile.packages ?? {})) {
		if (entryKey.startsWith('../') || entryKey.includes('/../')) {
			throw new Error(`package-lock.json contains forbidden local package entry: ${entryKey}`);
		}
		if (entryValue.link) {
			throw new Error(`package-lock.json contains forbidden linked dependency entry: ${entryKey}`);
		}
		const resolved = entryValue.resolved ?? '';
		if (
			resolved.startsWith('../')
			|| resolved.startsWith('./')
			|| resolved.startsWith('file:')
			|| resolved.startsWith('workspace:')
		) {
			throw new Error(`package-lock.json contains forbidden local resolution for ${entryKey}: ${resolved}`);
		}
	}
}

function resolveNodeModulesRoot() {
	let lastCandidate: string | null = null;
	let current = packageRoot;
	while (true) {
		const candidate = resolve(current, 'node_modules');
		try {
			readdirSync(candidate);
			lastCandidate = candidate;
		} catch {
		}

		const parent = resolve(current, '..');
		if (parent === current) break;
		current = parent;
	}

	if (lastCandidate) {
		return lastCandidate;
	}

	throw new Error(`Unable to locate node_modules for ${packageRoot}.`);
}

function mirrorDependencies(tempRoot: string) {
	const sharedNodeModules = resolveNodeModulesRoot();
	for (const entry of readdirSync(sharedNodeModules, { withFileTypes: true })) {
		if (entry.name === '.bin' || entry.name === '@treeseed') {
			continue;
		}

		const targetPath = resolve(tempRoot, 'node_modules', entry.name);
		mkdirSync(dirname(targetPath), { recursive: true });
		symlinkSync(resolve(sharedNodeModules, entry.name), targetPath, 'dir');
	}
}

function pack(root: string, fallbackName: string) {
	const output = run('npm', ['pack', '--ignore-scripts', '--cache', npmCacheDir], root, true);
	const filename = output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1)
		?? readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
			.at(-1)
		?? fallbackName;
	return resolve(root, filename);
}

function installPackagedPackage(extractRoot: string, tempRoot: string, tarballPath: string, folderName: string) {
	mkdirSync(resolve(tempRoot, 'node_modules', '@treeseed'), { recursive: true });
	run('tar', ['-xzf', tarballPath, '-C', extractRoot]);
	run('cp', ['-R', resolve(extractRoot, 'package'), resolve(tempRoot, 'node_modules', '@treeseed', folderName)]);
	rmSync(resolve(extractRoot, 'package'), { recursive: true, force: true });
}

function isInstalledDependencyPackage(root: string) {
	return root.includes(`${process.platform === 'win32' ? '\\' : '/'}node_modules${process.platform === 'win32' ? '\\' : '/'}`);
}

function installDependencyPackage(root: string, extractRoot: string, tempRoot: string, folderName: string, fallbackName: string) {
	if (isInstalledDependencyPackage(root) && existsSync(resolve(root, 'dist')) && existsSync(resolve(root, 'package.json'))) {
		const targetRoot = resolve(tempRoot, 'node_modules', '@treeseed', folderName);
		mkdirSync(resolve(tempRoot, 'node_modules', '@treeseed'), { recursive: true });
		cpSync(root, targetRoot, {
			recursive: true,
			filter(source) {
				const relativePath = source.slice(root.length).replace(/^[/\\]/, '');
				if (!relativePath) {
					return true;
				}
				return !(
					relativePath === 'node_modules'
					|| relativePath.startsWith(`node_modules${process.platform === 'win32' ? '\\' : '/'}`)
				);
			},
		});
		return;
	}

	const tarballPath = pack(root, fallbackName);
	installPackagedPackage(extractRoot, tempRoot, tarballPath, folderName);
}

assertNoLocalDependencyLinks();
ensureSdkRuntimeLink();
run('npm', ['run', 'lint']);
scanDirectory(resolve(packageRoot, 'dist'));
run('npm', ['run', 'test:unit']);
run('npm', ['run', 'test:smoke']);

const stageRoot = mkdtempSync(join(tmpdir(), 'treeseed-agent-release-'));
const extractRoot = resolve(stageRoot, 'extract');
const installRoot = resolve(stageRoot, 'install');

try {
	mkdirSync(extractRoot, { recursive: true });
	const agentTarball = pack(packageRoot, 'treeseed-agent.tgz');

	installDependencyPackage(sdkPackageRoot, extractRoot, installRoot, 'sdk', 'treeseed-sdk.tgz');
	installPackagedPackage(extractRoot, installRoot, agentTarball, 'agent');
	mirrorDependencies(installRoot);
	writeFileSync(resolve(installRoot, 'package.json'), `${JSON.stringify({ name: 'treeseed-agent-smoke', private: true, type: 'module' }, null, 2)}\n`, 'utf8');
	run(process.execPath, ['node_modules/@treeseed/agent/dist/scripts/treeseed-agents.js', '--help'], installRoot);
	runPackedProviderRuntimeSmoke(installRoot);
	console.log('Agent packed-install provider runtime smoke passed.');
} finally {
	rmSync(stageRoot, { recursive: true, force: true });
}
