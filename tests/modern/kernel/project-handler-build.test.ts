import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import type { Handler } from '../../../src/kernel/contracts.ts';
import type { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import { portableKernel } from './architecture/portable/portable-kernel-fixture.ts';
import { verifyCompiledProviderCode } from '../../acceptance/freeze-integrity.ts';
import ts from 'typescript';

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = fileURLToPath(new URL('../../fixtures/project-handlers.ts', import.meta.url));

function build(root: string, entry?: string) {
	const env = { ...process.env };
	delete env.TREESEED_AGENT_PROJECT_HANDLERS_ENTRY;
	if (entry) env.TREESEED_AGENT_PROJECT_HANDLERS_ENTRY = entry;
	const result = spawnSync(process.execPath, ['--import', 'tsx', './scripts/build/build-dist.ts'], {
		cwd: root, env, encoding: 'utf8', timeout: 120_000,
	});
	if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

async function artifactBytes(root: string): Promise<Map<string, Buffer>> {
	const bytes = new Map<string, Buffer>();
	const visit = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const name = join(prefix, entry.name), path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path, name);
			else { expect(entry.isFile()).toBe(true); bytes.set(name, await readFile(path)); }
		}
	};
	await visit(root, ''); return bytes;
}

describe('pinned project handler build', () => {
	it('public verification builds the exact provider declarations before strict complete test typing and retains one build before native tests', async () => {
		const manifest: { scripts: Record<string, string> } = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
		expect(manifest.scripts['release:verify']).toBe('npm run check:file-lengths && node --import tsx ./scripts/packages/release-verify.ts');
		expect(manifest.scripts.typecheck).toBe('tsc --noEmit');
		const file = ts.createSourceFile('release-verify.ts', await readFile(resolve(packageRoot, 'scripts/packages/release-verify.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
		const calls = file.statements.flatMap(statement => {
			if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
			const call = statement.expression;
			if (!ts.isIdentifier(call.expression) || call.expression.text !== 'run') return [];
			const [command, args] = call.arguments;
			if (!command || !ts.isStringLiteral(command) || !args || !ts.isArrayLiteralExpression(args)) throw new Error('Exact native verification command required');
			return [{ command: command.text, args: args.elements.map(argument => {
				if (!ts.isStringLiteral(argument)) throw new Error('Literal original verification argument required'); return argument.text;
			}) }];
		});
		expect(calls).toEqual([
			{ command: 'npm', args: ['run', 'build:dist', '--workspaces=false'] },
			{ command: 'npm', args: ['run', 'typecheck', '--workspaces=false'] },
			{ command: 'npm', args: ['run', 'test:modern', '--workspaces=false'] },
		]);
	});
	it('isolated original project build executes its compiled handler through the compiled Kernel and rejects missing duplicate and wrong-build selections without mutating held inputs', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'agent-project-build-')), clone = join(directory, 'package');
		let f: Awaited<ReturnType<typeof portableKernel>> | undefined;
		const inputs = new Map<string, Buffer>();
		const collect = async (root: string, prefix: string): Promise<void> => {
			for (const entry of await readdir(root, { withFileTypes: true })) {
				const path = join(root, entry.name), name = join(prefix, entry.name);
				if (entry.isDirectory()) await collect(path, name);
				else { expect(entry.isFile()).toBe(true); inputs.set(name, await readFile(path)); }
			}
		};
		try {
			await mkdir(clone);
			// Invoke ONLY the original compiler in an allocated copy. Original
			// source/dist/build lock remain untouched; no install or new compiler.
			for (const name of ['src', 'scripts', 'tests']) {
				await collect(resolve(packageRoot, name), name);
				await cp(resolve(packageRoot, name), join(clone, name), { recursive: true });
			}
			for (const name of ['package.json', 'tsconfig.json', 'tsconfig.dist.json', 'vitest.config.ts']) {
				const bytes = await readFile(resolve(packageRoot, name)); inputs.set(name, bytes);
				await mkdir(resolve(clone, name, '..'), { recursive: true }); await cp(resolve(packageRoot, name), resolve(clone, name));
			}
			await symlink(resolve(packageRoot, 'node_modules'), resolve(clone, 'node_modules'), 'dir');
			const env = { ...process.env, TREESEED_AGENT_PROJECT_HANDLERS_ENTRY: resolve(clone, 'tests/fixtures/project-handlers.ts') };
			const compilation = spawnSync(process.execPath, ['--import', 'tsx', './scripts/build/build-dist.ts'], {
				cwd: clone, env, encoding: 'utf8', timeout: 120_000,
			});
			expect(compilation.error).toBeUndefined(); expect(compilation.signal).toBeNull(); expect(compilation.status).toBe(0);
			const typing = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'], {
				cwd: clone, env, encoding: 'utf8', timeout: 120_000,
			});
			expect(typing.error).toBeUndefined(); expect(typing.signal).toBeNull(); expect(typing.status, `${typing.stdout}\n${typing.stderr}`).toBe(0);
			const selected: { projectHandlers: Handler[] } = await import(pathToFileURL(resolve(clone, 'dist/kernel/project-handlers.js')).href);
			const compiled: { executeKernelAssignment: typeof executeKernelAssignment } = await import(pathToFileURL(resolve(clone, 'dist/kernel/provider-kernel-executor.js')).href);
			expect(selected.projectHandlers.map(handler => handler.id)).toEqual(['sdk/fixture']);
			const moduleBytes = await readFile(resolve(clone, 'dist/kernel/project-handlers.js'));
			const kernelBytes = await readFile(resolve(clone, 'dist/kernel/provider-kernel-executor.js'));
			const built = new Map<string, Buffer>();
			const emitted = async (directory: string, prefix: string): Promise<void> => {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					if (entry.isDirectory()) await emitted(join(directory, entry.name), join(prefix, entry.name));
					else { expect(entry.isFile()).toBe(true); built.set(join(prefix, entry.name), await readFile(join(directory, entry.name))); }
				}
			};
			await emitted(resolve(clone, 'dist'), '');
			// Native ESM cache must retain the same actual compiled implementation;
			// do not use cache-busting URLs to conceal a changed selected generation.
			expect(await import(pathToFileURL(resolve(clone, 'dist/kernel/project-handlers.js')).href)).toBe(selected);
			expect(await import(pathToFileURL(resolve(clone, 'dist/kernel/provider-kernel-executor.js')).href)).toBe(compiled);
			f = await portableKernel(); const owner = f;
			owner.attempt.effectiveProfile.handler = 'sdk/fixture'; owner.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
			owner.attempt.workspace = { mode: 'read-only' }; owner.attempt.grant.sourceWrite = [];
			const before = structuredClone(owner.input.assignment);
			const run = (handlers: Handler[], buildId = owner.attempt.provider.runtimeBuild) => compiled.executeKernelAssignment({
				request: owner.input, executor: owner.executor, runtimeBuild: buildId, handlers,
			});
			const result = await run(selected.projectHandlers); expect(result.status).toBe('completed');
			const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult);
			expect(canonical).toMatchObject({ id: 'fixture-result', assignmentId: owner.attempt.id, status: 'completed',
				summary: 'Project-owned handler selected.', references: [], verification: [], usage: { elapsedSeconds: 0 }, diagnostics: [] });
			for (const handlers of [[], [...selected.projectHandlers, ...selected.projectHandlers]]) {
				const denied = await run(handlers); expect(denied.status).toBe('failed'); expect(denied.code).toBe('handler_unavailable');
				expect(denied.outputs?.assignmentResult).toBeUndefined(); expect(owner.input.assignment).toEqual(before);
			}
			const wrongBuild = await run(selected.projectHandlers, `sha256:${'f'.repeat(64)}`);
			expect(wrongBuild).toEqual({ status: 'failed', code: 'runtime_build_mismatch', summary: 'runtime_build_mismatch', retryable: false });
			expect(owner.requests).toEqual([]); expect(owner.begin).toEqual([]); expect(owner.git('rev-parse', 'HEAD')).toBe(owner.base);
			expect(owner.input.assignment).toEqual(before);
			expect(await readFile(resolve(clone, 'dist/kernel/project-handlers.js'))).toEqual(moduleBytes);
			expect(await readFile(resolve(clone, 'dist/kernel/provider-kernel-executor.js'))).toEqual(kernelBytes);
			for (const [name, bytes] of inputs) {
				expect(await readFile(resolve(clone, name))).toEqual(bytes); expect(await readFile(resolve(packageRoot, name))).toEqual(bytes);
			}
			await expect(readFile(resolve(clone, '.treeseed/build-dist.lock/owner'))).rejects.toMatchObject({ code: 'ENOENT' });
			const held = new Map(built); built.clear(); await emitted(resolve(clone, 'dist'), ''); verifyCompiledProviderCode(held, built);
		} finally { try { await f?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
	}, 30_000);
	it('compiles a project handler into the statically imported runner registry', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'agent-project-registry-')), clone = join(directory, 'package');
		const held = await artifactBytes(resolve(packageRoot, 'dist'));
		try {
			await mkdir(clone);
			for (const name of ['src', 'scripts']) await cp(resolve(packageRoot, name), join(clone, name), { recursive: true });
			for (const name of ['package.json', 'tsconfig.json', 'tsconfig.dist.json', 'tests/fixtures/project-handlers.ts']) {
				await mkdir(resolve(clone, name, '..'), { recursive: true }); await cp(resolve(packageRoot, name), resolve(clone, name));
			}
			await symlink(resolve(packageRoot, 'node_modules'), resolve(clone, 'node_modules'), 'dir');
			build(clone, resolve(clone, 'tests/fixtures/project-handlers.ts'));
			const registry = await import(pathToFileURL(resolve(clone, 'dist/kernel/project-handlers.js')).href);
			expect(registry.projectHandlers.map((handler: { id: string }) => handler.id)).toEqual(['sdk/fixture']);
			expect(new HandlerRegistry(registry.projectHandlers).resolve('sdk/fixture')).toBe(registry.projectHandlers[0]);
			const runnerSource = await import('node:fs/promises').then((fs) => fs.readFile(resolve(clone,
				'dist/provider/teams/multi-team-runtime.js'), 'utf8'));
			expect(runnerSource).toContain('project-handlers.js');
			expect(runnerSource).toContain('handlers: [...projectHandlers]');
			expect(await artifactBytes(resolve(packageRoot, 'dist'))).toEqual(held);
			build(clone);
			expect(await artifactBytes(resolve(packageRoot, 'dist'))).toEqual(held);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
