import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_PACK_TEST_TIMEOUT_MS = 30_000;

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

			expect(packageJson.scripts.verify).toBe('TMPDIR=/tmp node --import tsx ./scripts/verify-driver.ts');
			expect(packageJson.scripts['verify:local']).toBe(
				'TREESEED_VERIFY_DRIVER=direct TMPDIR=/tmp node --import tsx ./scripts/verify-driver.ts',
			);
			expect(packageJson.scripts['verify:action']).toBe(
				'TREESEED_VERIFY_DRIVER=act TMPDIR=/tmp node --import tsx ./scripts/verify-driver.ts',
			);
			expect(Object.keys(packageJson.scripts).some((name) => name.includes('processing'))).toBe(false);
			expect(Object.values(packageJson.scripts).some((command) => command.includes('treeseed-processing'))).toBe(false);
		});

	it('ships provider runtime entrypoint and support modules without source-mode temp artifacts', () => {
		const requiredRuntimeFiles = [
			'dist/scripts/treeseed-agent-service.js',
			'dist/provider/entrypoint.js',
			'dist/provider/config.js',
			'dist/provider/registration.js',
			'dist/provider/heartbeat.js',
			'dist/provider/portfolio.js',
			'dist/provider/portfolio-processing.js',
			'dist/provider/runner.js',
			'dist/provider/lifecycle.js',
			'dist/scripts/build-capacity-provider-container.js',
			'dist/scripts/test-capacity-provider-container.js',
				'dist/api/server.js',
				'dist/services/manager.js',
				'dist/services/workday-start.js',
				'dist/services/workday-report.js',
				'dist/services/runtime-paths.js',
			'dist/services/common.js',
			'dist/agents/adapters/codex-auth.js',
			'dist/agents/adapters/codex-readiness.js',
			'dist/agents/adapters/execution-codex.js',
			'dist/agents/registry.js',
			'dist/agents/kernel/agent-kernel.js',
			'dist/agents/handlers/plan.js',
			'dist/agents/handlers/research.js',
			'dist/agents/handlers/act.js',
			'dist/agents/handlers/review.js',
			'dist/agents/handlers/report.js',
			'dist/templates/github/deploy-capacity-provider.workflow.yml',
			'dist/templates/railway/capacity-provider.yml',
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

		expect(paths).toContain('dist/provider/entrypoint.js');
		expect(paths).toContain('dist/provider/config.js');
		expect(paths).toContain('dist/provider/registration.js');
		expect(paths).toContain('dist/provider/heartbeat.js');
		expect(paths).toContain('dist/provider/portfolio.js');
		expect(paths).toContain('dist/provider/portfolio-processing.js');
		expect(paths).toContain('dist/provider/runner.js');
		expect(paths).toContain('dist/provider/lifecycle.js');
		expect(paths).toContain('dist/scripts/build-capacity-provider-container.js');
		expect(paths).toContain('dist/scripts/test-capacity-provider-container.js');
		expect(paths).toContain('dist/services/manager.js');
		expect(paths).toContain('dist/services/runtime-paths.js');
		expect(paths).toContain('Dockerfile');
		expect(paths).toContain('docker-entrypoint.sh');
		expect(paths).toContain('compose.capacity-provider.yml');
		expect(paths).toContain('treeseed.package.yaml');
		expect(paths).toContain('docs/capacity-provider-runtime.md');
		expect(paths).toContain('templates/github/deploy-capacity-provider.workflow.yml');
		expect(paths).toContain('templates/railway/capacity-provider.yml');
		expect(paths.filter((filePath) => /(^|\/)\.ts-run-/u.test(filePath))).toEqual([]);
	}, PACKAGE_PACK_TEST_TIMEOUT_MS);

	it('ships secure package-owned container assets', () => {
		const dockerfile = readFileSync(resolve(packageRoot, 'Dockerfile'), 'utf8');
		const entrypoint = readFileSync(resolve(packageRoot, 'docker-entrypoint.sh'), 'utf8');
		const compose = readFileSync(resolve(packageRoot, 'compose.capacity-provider.yml'), 'utf8');
		const docs = readFileSync(resolve(packageRoot, 'docs/capacity-provider-runtime.md'), 'utf8');

		expect(dockerfile).not.toContain('FROM node-runtime AS agent-api');
		expect(dockerfile).toContain('FROM node-runtime AS manager-runtime');
		expect(dockerfile).toContain('FROM manager-runtime AS agent-manager');
		expect(dockerfile).toContain('FROM manager-runtime AS agent-runner');
		expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "/usr/local/bin/treeseed-agent-entrypoint"]');
		expect(entrypoint).toContain('setpriv');
		expect(dockerfile).toContain('FROM node:22');
		expect(dockerfile).not.toContain('COPY . .');
		expect(dockerfile).not.toContain('treeseed-processing');
		expect(dockerfile).not.toContain('packages/core');
		expect(compose).toContain('target: agent-manager');
		expect(compose).toContain('target: agent-runner');
		expect(compose).not.toContain('treeseed/agent-api');
		expect(compose).toContain('treeseed/agent-manager');
		expect(compose).toContain('treeseed/agent-runner');
		expect(compose).toContain('TREESEED_PROVIDER_STARTUP_MODE');
		expect(compose).toContain('TREESEED_CAPACITY_PROVIDER_API_KEY: ${TREESEED_CAPACITY_PROVIDER_API_KEY:-}');
		expect(compose).not.toContain('env_file');
		expect(compose).not.toMatch(/tscp_[A-Za-z0-9_]+|tsp_[A-Za-z0-9_]+|sk-[A-Za-z0-9_]+/u);
		expect(docs).toContain('trsd config');
		expect(docs).toContain('Do not create plaintext `.env` files');
		const railwayTemplate = readFileSync(resolve(packageRoot, 'templates/railway/capacity-provider.yml'), 'utf8');
		const deployWorkflow = readFileSync(resolve(packageRoot, 'templates/github/deploy-capacity-provider.workflow.yml'), 'utf8');
		expect(railwayTemplate).not.toContain('api:');
		expect(railwayTemplate).toContain('manager:');
		expect(railwayTemplate).toContain('runner:');
		expect(railwayTemplate).not.toContain('node ./dist/provider/entrypoint.js api');
		expect(railwayTemplate).not.toMatch(/tscp_[A-Za-z0-9_]+|tsp_[A-Za-z0-9_]+|sk-[A-Za-z0-9_]+/u);
		expect(deployWorkflow).toContain('Build package-owned provider role images');
		expect(deployWorkflow).not.toContain('placeholder');
	});

	it('does not import web/core runtime surfaces', () => {
		const importPattern = /(?:from\s+['"]|import\s*\(\s*['"]|export\s+\*\s+from\s+['"]|export\s+\{[^}]*\}\s+from\s+['"])([^'"]+)['"]/gu;
		const forbiddenSpecifiers = [
			/^@treeseed\/core(?:\/|$)/u,
			/^astro(?:\/|$)/u,
			/^@astrojs\/starlight(?:\/|$)/u,
		];

		for (const filePath of walkFiles(resolve(packageRoot, 'src'))) {
			if (!['.ts', '.js'].includes(extname(filePath))) continue;
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
		expect(readme).toContain('.github/workflows/dev-image.yml');
		expect(readme).toContain('.github/workflows/publish.yml');
		expect(readme).toContain('TREESEED_WORKDAY_TASK_CREDIT_BUDGET');
		expect(readme).not.toContain(staleWorkflowName);
		expect(readme).not.toContain(staleSmokePhrase);
		expect(packageSource).not.toContain(staleBudgetName);
		expect(envRegistry).toContain('TREESEED_WORKDAY_TASK_CREDIT_BUDGET');
	});
});
