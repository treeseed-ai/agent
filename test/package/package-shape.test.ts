import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
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

function sourcePathForDistSpecifier(specifier: string) {
	const withoutPrefix = specifier.replace(/^\.\/dist\//u, '').replace(/\.js$/u, '.ts');
	return resolve(packageRoot, 'src', withoutPrefix);
}

function sourcePathForBinSpecifier(specifier: string) {
	const withoutPrefix = specifier.replace(/^dist\/scripts\//u, '').replace(/\.js$/u, '.ts');
	return resolve(packageRoot, 'scripts', withoutPrefix);
}

describe('agent package shape', () => {
	it('keeps public exports and bins mapped to owned source files', () => {
		const packageJson = readJson<{
			bin: Record<string, string>;
			exports: Record<string, { default: string; types: string }>;
			scripts: Record<string, string>;
		}>(resolve(packageRoot, 'package.json'));

		expect(packageJson.bin).toEqual({
			'treeseed-agents': 'dist/scripts/treeseed-agents.js',
			'treeseed-agent-api': 'dist/scripts/treeseed-agent-api.js',
			'treeseed-agent-service': 'dist/scripts/treeseed-agent-service.js',
			'treeseed-processing': 'dist/scripts/treeseed-processing.js',
		});

		for (const [exportName, exportValue] of Object.entries(packageJson.exports)) {
			expect(exportValue.default, `${exportName} default export`).toMatch(/^\.\/dist\/.+\.js$/u);
			expect(exportValue.types, `${exportName} type export`).toMatch(/^\.\/dist\/.+\.d\.ts$/u);
			expect(existsSync(sourcePathForDistSpecifier(exportValue.default)), `${exportName} source file`).toBe(true);
		}

		for (const [binName, binPath] of Object.entries(packageJson.bin)) {
			expect(existsSync(sourcePathForBinSpecifier(binPath)), `${binName} source file`).toBe(true);
		}

		expect(packageJson.scripts.verify).toBe('node ./scripts/verify-driver.mjs');
		expect(packageJson.scripts['verify:local']).toContain('./scripts/verify-driver.mjs');
		expect(packageJson.scripts['verify:action']).toContain('./scripts/verify-driver.mjs');
	});

	it('ships processing runtime bins and support modules without source-mode temp artifacts', () => {
		const requiredRuntimeFiles = [
			'dist/scripts/treeseed-processing.js',
			'dist/scripts/treeseed-agent-api.js',
			'dist/scripts/treeseed-agent-service.js',
			'dist/api/server.js',
			'dist/services/manager.js',
			'dist/services/worker.js',
			'dist/services/workday-start.js',
			'dist/services/workday-report.js',
			'dist/services/processing-plan.js',
			'dist/services/processing-doctor.js',
			'dist/services/runtime-paths.js',
			'dist/services/common.js',
			'dist/agents/adapters/codex-auth.js',
			'dist/agents/adapters/codex-readiness.js',
			'dist/agents/adapters/execution-codex.js',
			'dist/agents/registry.js',
			'dist/agents/kernel/agent-kernel.js',
			'dist/agents/handlers/planner.js',
			'dist/agents/handlers/researcher.js',
			'dist/agents/handlers/knowledge-generator.js',
			'dist/agents/handlers/knowledge-optimizer.js',
			'dist/agents/handlers/reviewer.js',
			'dist/agents/handlers/engineer.js',
			'dist/agents/handlers/reporter.js',
			'dist/agents/handlers/releaser.js',
			'dist/templates/github/deploy-processing.workflow.yml',
		];

		for (const filePath of requiredRuntimeFiles) {
			expect(existsSync(resolve(packageRoot, filePath)), `${filePath} exists`).toBe(true);
		}

		const distFiles = walkFiles(resolve(packageRoot, 'dist'))
			.map((filePath) => filePath.slice(packageRoot.length + 1).replace(/\\/gu, '/'));
		expect(distFiles.filter((filePath) => /(^|\/)\.ts-run-/u.test(filePath))).toEqual([]);
	});

	it('packs runtime closure without source-mode temp artifacts', () => {
		const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: packageRoot,
			encoding: 'utf8',
			env: {
				...process.env,
				TREESEED_SKIP_PACKAGE_PREPARE: '1',
			},
		});
		const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
		const paths = pack.files.map((entry) => entry.path);

		expect(paths).toContain('dist/scripts/treeseed-processing.js');
		expect(paths).toContain('dist/services/manager.js');
		expect(paths).toContain('dist/services/worker.js');
		expect(paths).toContain('dist/services/processing-plan.js');
		expect(paths).toContain('dist/services/processing-doctor.js');
		expect(paths).toContain('dist/services/runtime-paths.js');
		expect(paths.filter((filePath) => /(^|\/)\.ts-run-/u.test(filePath))).toEqual([]);
	});

	it('does not import web/core runtime surfaces', () => {
		const importPattern = /(?:from\s+['"]|import\s*\(\s*['"]|export\s+\*\s+from\s+['"]|export\s+\{[^}]*\}\s+from\s+['"])([^'"]+)['"]/gu;
		const forbiddenSpecifiers = [
			/^@treeseed\/core(?:\/|$)/u,
			/^astro(?:\/|$)/u,
			/^@astrojs\/starlight(?:\/|$)/u,
		];

		for (const filePath of walkFiles(resolve(packageRoot, 'src'))) {
			if (!['.ts', '.mjs', '.js'].includes(extname(filePath))) continue;
			const source = readFileSync(filePath, 'utf8');
			for (const match of source.matchAll(importPattern)) {
				const specifier = match[1];
				expect(
					forbiddenSpecifiers.some((pattern) => pattern.test(specifier)),
					`${filePath} imports ${specifier}`,
				).toBe(false);
			}
		}
	});

	it('documents current workflows and registry-owned environment names', () => {
		const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');
		const envRegistry = readFileSync(resolve(packageRoot, 'src/env.yaml'), 'utf8');
		const staleBudgetName = ['TREESEED_WORKDAY', 'CAPACITY_BUDGET'].join('_');
		const staleWorkflowName = ['.github/workflows', 'ci.yml'].join('/');
		const staleSmokePhrase = ['legacy', 'smoke path'].join(' ');
		const packageSource = [
			readme,
			envRegistry,
			...walkFiles(resolve(packageRoot, 'src'))
				.filter((filePath) => ['.ts', '.yaml', '.yml'].includes(extname(filePath)))
				.map((filePath) => readFileSync(filePath, 'utf8')),
		].join('\n');

		expect(readme).toContain('.github/workflows/verify.yml');
		expect(readme).toContain('templates/github/deploy-processing.workflow.yml');
		expect(readme).toContain('TREESEED_WORKDAY_TASK_CREDIT_BUDGET');
		expect(readme).not.toContain(staleWorkflowName);
		expect(readme).not.toContain(staleSmokePhrase);
		expect(packageSource).not.toContain(staleBudgetName);
		expect(envRegistry).toContain('TREESEED_WORKDAY_TASK_CREDIT_BUDGET');
	});
});
