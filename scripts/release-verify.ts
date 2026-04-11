import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageRoot } from './package-tools.ts';

const require = createRequire(import.meta.url);
const corePackageRoot = resolve(dirname(require.resolve('@treeseed/core')), '..');
const sdkPackageRoot = resolve(dirname(require.resolve('@treeseed/sdk')), '..');
const npmCacheDir = resolve(tmpdir(), 'treeseed-npm-cache');
const textExtensions = new Set(['.js', '.ts', '.mjs', '.cjs', '.d.ts', '.json', '.md']);
const forbiddenPatterns = [
	/['"`]file:[^'"`\n]+['"`]/,
	/['"`]workspace:[^'"`\n]+['"`]/,
	/['"`](?:\.\.\/|\.\/)[^'"`\n]*src\/[^'"`\n]*\.(?:[cm]?js|ts|tsx|json|astro|css)['"`]/,
	/['"`][^'"`\n]*\/packages\/[^'"`\n]*\/src\/[^'"`\n]*['"`]/,
];

function run(command: string, args: string[], cwd = packageRoot, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: capture ? 'pipe' : 'inherit',
		encoding: 'utf8',
		env: {
			...process.env,
			npm_config_cache: npmCacheDir,
			NPM_CONFIG_CACHE: npmCacheDir,
		},
	});

	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${command} ${args.join(' ')} failed`);
	}

	return (result.stdout ?? '').trim();
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

run('npm', ['run', 'lint']);
scanDirectory(resolve(packageRoot, 'dist'));
run('npm', ['run', 'test:smoke']);

const stageRoot = mkdtempSync(join(tmpdir(), 'treeseed-agent-release-'));
const extractRoot = resolve(stageRoot, 'extract');
const installRoot = resolve(stageRoot, 'install');

try {
	mkdirSync(extractRoot, { recursive: true });
	const agentTarball = pack(packageRoot, 'treeseed-agent.tgz');

	installDependencyPackage(sdkPackageRoot, extractRoot, installRoot, 'sdk', 'treeseed-sdk.tgz');
	installDependencyPackage(corePackageRoot, extractRoot, installRoot, 'core', 'treeseed-core.tgz');
	installPackagedPackage(extractRoot, installRoot, agentTarball, 'agent');
	mirrorDependencies(installRoot);
	writeFileSync(resolve(installRoot, 'package.json'), `${JSON.stringify({ name: 'treeseed-agent-smoke', private: true, type: 'module' }, null, 2)}\n`, 'utf8');
	run(process.execPath, ['node_modules/@treeseed/agent/dist/scripts/treeseed-agents.js', '--help'], installRoot);
	console.log('Agent packed-install bin smoke passed.');
} finally {
	rmSync(stageRoot, { recursive: true, force: true });
}
