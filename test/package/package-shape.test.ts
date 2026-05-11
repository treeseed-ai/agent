import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
