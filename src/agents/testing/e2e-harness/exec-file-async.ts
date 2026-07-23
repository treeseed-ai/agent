import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';


export const execFileAsync = promisify(execFile);

export const require = createRequire(import.meta.url);

export function nowIso() {
	return new Date().toISOString();
}

export function resolveDocsRoot() {
	if (process.env.TREESEED_AGENT_FIXTURE_ROOT) {
		return path.resolve(process.env.TREESEED_AGENT_FIXTURE_ROOT);
	}

	const cwd = process.cwd();
	const workspaceSdkPackageRoot = path.resolve(cwd, '../sdk');
	const installedSdkPackageRoot = path.resolve(path.dirname(require.resolve('@treeseed/sdk/platform/tenant-config')), '../..');
	const candidates: string[] = [];
	let current = cwd;
	while (true) {
		candidates.push(
			path.resolve(current, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
			path.resolve(current, 'fixture'),
			path.resolve(current, 'fixtures', 'sites', 'working-site'),
		);
		const parent = path.resolve(current, '..');
		if (parent === current) {
			break;
		}
		current = parent;
	}
	candidates.push(
		path.resolve(workspaceSdkPackageRoot, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
		path.resolve(workspaceSdkPackageRoot, 'fixture'),
		path.resolve(installedSdkPackageRoot, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
		path.resolve(installedSdkPackageRoot, 'fixture'),
	);

	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, 'src', 'manifest.yaml'))) {
			return candidate;
		}
	}

	throw new Error(
		`Unable to resolve an agent smoke fixture root. Checked: ${candidates.join(', ')}`,
	);
}

export function resolveSharedNodeModules(startDir: string) {
	const requiredPackages = ['@treeseed/sdk'];
	const checked: string[] = [];
	let current = startDir;

	while (true) {
		const candidate = path.join(current, 'node_modules');
		checked.push(candidate);
		if (
			existsSync(candidate)
			&& requiredPackages.every((packageName) =>
				existsSync(path.join(candidate, ...packageName.split('/'))))
		) {
			return candidate;
		}

		const parent = path.resolve(current, '..');
		if (parent === current) {
			break;
		}
		current = parent;
	}

	throw new Error(
		`Unable to resolve a shared node_modules directory containing ${requiredPackages.join(', ')}. Checked: ${checked.join(', ')}`,
	);
}

export async function resolveWranglerBin() {
	if (process.env.TREESEED_AGENT_WRANGLER_BIN) {
		return path.resolve(process.env.TREESEED_AGENT_WRANGLER_BIN);
	}

	try {
		const wranglerPackageRoot = path.resolve(path.dirname(require.resolve('wrangler/package.json')));
		const packageJson = JSON.parse(await readFile(path.join(wranglerPackageRoot, 'package.json'), 'utf8'));
		const relativeBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.wrangler;
		if (!relativeBin) {
			throw new Error('Unable to resolve wrangler binary path from package.json.');
		}
		return path.resolve(wranglerPackageRoot, relativeBin);
	} catch {
		const packageLocal = path.resolve(resolveDocsRoot(), 'node_modules', '.bin', 'wrangler');
		await access(packageLocal);
		return packageLocal;
	}
}

export async function runCommand(command: string, args: string[], cwd: string) {
	await execFileAsync(command, args, {
		cwd,
		env: process.env,
		maxBuffer: 10 * 1024 * 1024,
	});
}

export async function linkWorkspaceNodeModules(sharedNodeModules: string, repoRoot: string, localAgentPackageRoot: string) {
	const targetRoot = path.join(repoRoot, 'node_modules');
	await mkdir(targetRoot, { recursive: true });

	const entries = await readdir(sharedNodeModules, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.name === '@treeseed') {
			const scopedSource = path.join(sharedNodeModules, entry.name);
			const scopedTarget = path.join(targetRoot, entry.name);
			await mkdir(scopedTarget, { recursive: true });
			const scopedEntries = await readdir(scopedSource, { withFileTypes: true }).catch(() => []);
			for (const scopedEntry of scopedEntries) {
				const sourcePath = path.join(scopedSource, scopedEntry.name);
				const targetPath = path.join(scopedTarget, scopedEntry.name);
				if (scopedEntry.name === 'agent') {
					continue;
				}
				await symlink(sourcePath, targetPath, scopedEntry.isDirectory() ? 'dir' : 'file').catch(() => undefined);
			}
			continue;
		}

		const sourcePath = path.join(sharedNodeModules, entry.name);
		const targetPath = path.join(targetRoot, entry.name);
		await symlink(sourcePath, targetPath, entry.isDirectory() ? 'dir' : 'file').catch(() => undefined);
	}

	const installedAgentRoot = path.join(targetRoot, '@treeseed', 'agent');
	await rm(installedAgentRoot, { recursive: true, force: true });
	await mkdir(installedAgentRoot, { recursive: true });
	await cp(path.join(localAgentPackageRoot, 'dist'), path.join(installedAgentRoot, 'dist'), { recursive: true });
	await writeFile(
		path.join(installedAgentRoot, 'package.json'),
		JSON.stringify({
			name: '@treeseed/agent',
			type: 'module',
			exports: {
				'.': './dist/index.js',
				'./runtime-types': './dist/agents/runtime-types.js',
				'./contracts/messages': './dist/agents/contracts/messages.js',
				'./contracts/run': './dist/agents/contracts/run.js',
			},
		}, null, 2),
		'utf8',
	);
}

export async function walkFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				return walkFiles(fullPath);
			}
			return [fullPath];
		}),
	);
	return nested.flat();
}

export function jsonResponse(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

export function treeDxPatternMatches(pattern: string, candidate: string) {
	const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\/+/u, '');
	const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/^\/+/u, '');
	const contentRelativePattern = normalizedPattern.includes('/src/content/')
		? normalizedPattern.slice(normalizedPattern.lastIndexOf('/src/content/') + '/src/content/'.length)
		: normalizedPattern;
	const contentRelativeCandidate = normalizedCandidate.includes('/src/content/')
		? normalizedCandidate.slice(normalizedCandidate.lastIndexOf('/src/content/') + '/src/content/'.length)
		: normalizedCandidate;
	if (contentRelativePattern.endsWith('/**')) {
		const prefix = contentRelativePattern.slice(0, -3);
		return contentRelativeCandidate.startsWith(prefix) || normalizedCandidate.includes(`/src/content/${prefix}`);
	}
	return contentRelativePattern === contentRelativeCandidate
		|| contentRelativeCandidate.startsWith(`${contentRelativePattern}/`)
		|| normalizedCandidate.endsWith(`/src/content/${contentRelativePattern}`);
}

export async function readTreeDxRequest(init?: RequestInit) {
	if (!init?.body) return {};
	if (typeof init.body === 'string') return JSON.parse(init.body) as Record<string, unknown>;
	if (init.body instanceof Uint8Array) return JSON.parse(Buffer.from(init.body).toString('utf8')) as Record<string, unknown>;
	return {};
}

export async function createFixtureTreeDxFetch(repoRoot: string): Promise<typeof fetch> {
	return async (input, init) => {
		const url = new URL(String(input));
		const body = await readTreeDxRequest(init);
		const paths = Array.isArray(body.paths)
			? body.paths.map(String)
			: typeof body.path === 'string'
				? [body.path]
				: ['src/content/**'];
		const files = (await walkFiles(repoRoot))
			.map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
			.filter((filePath) => /\.(md|mdx)$/iu.test(filePath))
			.filter((filePath) => paths.some((pattern) => treeDxPatternMatches(pattern, filePath)))
			.sort();

		if (url.pathname.endsWith('/paths/list')) {
			return jsonResponse({
				ok: true,
				entries: files.map((filePath) => ({ path: filePath, kind: 'file' })),
			});
		}

		if (url.pathname.endsWith('/files/read')) {
			const requested = Array.isArray(body.paths)
				? body.paths.map(String)
				: typeof body.path === 'string'
					? [body.path]
					: [];
			const readable = requested.length ? requested : files;
			const result = await Promise.all(readable.map(async (filePath) => {
				const content = await readFile(path.join(repoRoot, filePath), 'utf8');
				const parsed = parseFrontmatterDocument(content);
				return {
					path: filePath,
					content,
					frontmatter: parsed.frontmatter,
					body: parsed.body,
				};
			}));
			return jsonResponse({ ok: true, file: result[0] ?? null, files: result });
		}

		if (url.pathname.endsWith('/files/search')) {
			const limit = typeof body.limit === 'number' ? body.limit : files.length;
			const result = await Promise.all(files.slice(0, limit).map(async (filePath) => {
				const content = await readFile(path.join(repoRoot, filePath), 'utf8');
				const parsed = parseFrontmatterDocument(content);
				return {
					path: filePath,
					content,
					frontmatter: parsed.frontmatter,
					body: parsed.body,
				};
			}));
			return jsonResponse({ ok: true, results: result });
		}

		return jsonResponse({
			ok: false,
			error: {
				code: 'unhandled_fixture_treedx_route',
				message: `Unhandled fixture TreeDX route ${url.pathname}`,
			},
		}, 404);
	};
}
