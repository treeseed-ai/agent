import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
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
			'treeseed-agents': 'dist/scripts/agents/agents.js',
		});

		for (const [exportName, exportValue] of Object.entries(packageJson.exports)) {
			expect(exportValue.default, `${exportName} default export`).toMatch(/^\.\/dist\/.+\.js$/u);
			expect(exportValue.types, `${exportName} type export`).toMatch(/^\.\/dist\/.+\.d\.ts$/u);
			expect(existsSync(sourcePathForDistSpecifier(exportValue.default)), `${exportName} source file`).toBe(true);
		}

		for (const [binName, binPath] of Object.entries(packageJson.bin)) {
			expect(existsSync(sourcePathForBinSpecifier(binPath)), `${binName} source file`).toBe(true);
		}

			expect(packageJson.scripts.verify).toBe('TMPDIR=/tmp node --import tsx ./scripts/support/verify-driver.ts');
			expect(packageJson.scripts['verify:local']).toBe(
				'TREESEED_VERIFY_DRIVER=direct TMPDIR=/tmp node --import tsx ./scripts/support/verify-driver.ts',
			);
			expect(packageJson.scripts['verify:action']).toBe(
				'TREESEED_VERIFY_DRIVER=act TMPDIR=/tmp node --import tsx ./scripts/support/verify-driver.ts',
			);
			expect(Object.keys(packageJson.scripts).some((name) => name.includes('processing'))).toBe(false);
			expect(Object.values(packageJson.scripts).some((command) => command.includes('treeseed-processing'))).toBe(false);
			expect(packageJson.scripts).not.toHaveProperty('test:manager-worker');
			expect(packageJson.scripts).toHaveProperty('test:provider-runtime');
		});

	it('enforces the assignment-only kernel module boundary', () => {
		const kernelRoot = resolve(packageRoot, 'src/agents/kernel');
		const requiredModules = [
			'agents/agent-kernel.ts',
			'capacity/assignments/assignment-preflight.ts',
			'telemetry/activity-profile-resolver.ts',
			'execution/context-loader.ts',
			'execution/execution-dispatcher.ts',
			'validation/output-validator.ts',
			'artifacts/artifact-manifest.ts',
			'telemetry/telemetry.ts',
			'validation/failure-classifier.ts',
			'runtime/kernel-runtime.ts',
		];
		for (const module of requiredModules) {
			const source = readFileSync(resolve(kernelRoot, module), 'utf8');
			expect(source.split(/\r?\n/u).length, `${module} line count`).toBeLessThanOrEqual(500);
			expect(source).not.toMatch(/@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu);
		}
		for (const retiredModule of ['trigger-resolver.ts', 'mode-scheduler.ts', 'queue-observer.ts', 'priority-resolver.ts']) {
			expect(existsSync(resolve(kernelRoot, retiredModule)), retiredModule).toBe(false);
		}
		const source = requiredModules.map((module) => readFileSync(resolve(kernelRoot, module), 'utf8')).join('\n');
		expect(source).not.toMatch(/\b(?:runAgent|runCycle|drainMessages|ModeScheduler|QueueObserver|PriorityResolver)\b/gu);
		expect(source.match(/\brunAssignment\s*\(/gu)).toHaveLength(1);
	});

	it('enforces the focused provider runner module boundary', () => {
		const providerRoot = resolve(packageRoot, 'src/provider');
		const requiredModules = [
			'operations/runner.ts',
			'operations/runner-contracts.ts',
			'operations/runner-lifecycle.ts',
			'execution/kernel-bridge.ts',
			'capacity/assignments/kernel-assignment.ts',
			'treedx/graph/treedx-context-adapter.ts',
			'execution/execution-lifecycle.ts',
			'execution/execution-support.ts',
			'capacity/providers/execution-provider-selection.ts',
			'capacity/assignments/assignment-result-reporter.ts',
			'capacity/assignments/assignment-tool-policy.ts',
			'commerce/catalog/assignment-tool-catalog.ts',
			'coordination/lease-client.ts',
			'reporting/mode-run-reporter.ts',
			'capacity/accounting/usage-reporter.ts',
		];
		for (const module of requiredModules) {
			const source = readFileSync(resolve(providerRoot, module), 'utf8');
			expect(source.split(/\r?\n/u).length, `${module} line count`).toBeLessThanOrEqual(500);
			expect(source).not.toMatch(/@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu);
			expect(source).not.toMatch(/\bany\b/gu);
		}
		const runner = readFileSync(resolve(providerRoot, 'operations/runner.ts'), 'utf8');
		expect(runner.match(/\brunProviderAssignment\s*\(/gu)).toHaveLength(1);
		expect(runner).not.toContain('createAssignmentTreeDxAdapter(input:');
		expect(runner).not.toContain('class LifecycleManagedExecutionProviderAdapter');
	});

	it('enforces focused TreeDX content, tool receipt, and artifact owners', () => {
		const requiredModules = [
			'agents/handlers/execution-content.ts',
			'agents/handlers/execution-content-artifacts.ts',
			'agents/handlers/execution-content-context.ts',
			'agents/handlers/execution-content-prompt.ts',
			'agents/tools/agent-tool-runtime.ts',
			'agents/tools/agent-tool-telemetry.ts',
			'agents/kernel/artifacts/artifact-manifest.ts',
			'agents/kernel/artifacts/artifact-receipts.ts',
		];
		for (const module of requiredModules) {
			const source = readFileSync(resolve(packageRoot, 'src', module), 'utf8');
			expect(source.split(/\r?\n/u).length, `${module} line count`).toBeLessThanOrEqual(500);
			expect(source).not.toMatch(/@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu);
		}
		expect(existsSync(resolve(packageRoot, 'src/agents/knowledge/pipeline.ts'))).toBe(false);
		const publicIndex = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8');
		expect(publicIndex).not.toMatch(/knowledge\/pipeline|buildKnowledgeDraft|buildResearchNote/gu);
		const manifest = readFileSync(resolve(packageRoot, 'src/agents/kernel/artifacts/artifact-manifest.ts'), 'utf8');
		expect(manifest).not.toMatch(/contentArtifactRefs|\bcontentRefs\b|\bcodeChanges\b|\btoolSummary\b/gu);
		const mutations = readFileSync(resolve(packageRoot, 'src/agents/adapters/tools/mutations.ts'), 'utf8');
		expect(mutations).toContain('Knowledge Hub content mutations require an assignment-scoped TreeDX tool receipt');
		const releaser = readFileSync(resolve(packageRoot, 'src/agents/handlers/releaser.ts'), 'utf8');
		expect(releaser).toContain('createExecutionContentHandler');
		expect(releaser).not.toMatch(/status:\s*['"]waiting['"]|releaseAttempted:\s*false/gu);
	});

	it('enforces focused specification and execution-provider modules', () => {
		const requiredModules = [
			'agents/support/spec-normalizer.ts',
			'agents/support/spec-normalizer-activities.ts',
			'agents/support/spec-normalizer-execution.ts',
			'agents/support/spec-normalizer-policy.ts',
			'agents/support/spec-normalizer-primitives.ts',
			'agents/adapters/codex/execution-codex.ts',
			'agents/adapters/codex/execution-codex-core.ts',
			'agents/adapters/codex/execution-codex-result.ts',
			'agents/adapters/reconciliation/execution-codex-adapter.ts',
			'agents/adapters/integrations/execution-jira.ts',
			'agents/adapters/reconciliation/execution-jira-adapter.ts',
			'agents/adapters/repositories/execution-github-issues.ts',
			'agents/adapters/reconciliation/execution-github-issues-adapter.ts',
			'agents/adapters/integrations/execution-discord.ts',
			'agents/adapters/reconciliation/execution-discord-adapter.ts',
			'api/projects/projects-core/project-routes.ts',
			'api/projects/projects-core/project-route-helpers.ts',
			'api/projects/projects-core/project-summary.ts',
			'api/auth/d1-store.ts',
			'api/auth/d1-store-core.ts',
			'api/auth/d1-user-store.ts',
		];
		for (const module of requiredModules) {
			const source = readFileSync(resolve(packageRoot, 'src', module), 'utf8');
			expect(source.split(/\r?\n/u).length, `${module} line count`).toBeLessThanOrEqual(500);
			expect(source).not.toMatch(/@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu);
		}
	});

	it('ships provider runtime entrypoint and support modules without source-mode temp artifacts', () => {
		const requiredRuntimeFiles = [
			'dist/provider/lifecycle/entrypoint.js',
			'dist/provider/configuration/config.js',
			'dist/provider/coordination/coordinator.js',
			'dist/provider/projects/projects-core/project-materialization.js',
			'dist/provider/operations/runner.js',
			'dist/provider/operations/runner-lifecycle.js',
			'dist/provider/treedx/graph/treedx-context-adapter.js',
			'dist/provider/execution/execution-lifecycle.js',
			'dist/provider/capacity/providers/execution-provider-selection.js',
			'dist/provider/execution/kernel-bridge.js',
			'dist/provider/capacity/assignments/assignment-result-reporter.js',
			'dist/provider/capacity/accounting/usage-reporter.js',
			'dist/provider/lifecycle/lifecycle.js',
			'dist/scripts/capacity/providers/build-capacity-provider-container.js',
			'dist/scripts/capacity/providers/test-capacity-provider-container.js',
			'dist/api/support/server.js',
				'dist/services/runtime-paths.js',
			'dist/agents/adapters/accounts/codex-auth.js',
			'dist/agents/adapters/codex/codex-readiness.js',
			'dist/agents/adapters/codex/execution-codex.js',
			'dist/agents/support/registry.js',
			'dist/agents/kernel/agents/agent-kernel.js',
			'dist/agents/kernel/capacity/assignments/assignment-preflight.js',
			'dist/agents/kernel/telemetry/activity-profile-resolver.js',
			'dist/agents/kernel/execution/context-loader.js',
			'dist/agents/kernel/execution/execution-dispatcher.js',
			'dist/agents/kernel/validation/output-validator.js',
			'dist/agents/kernel/artifacts/artifact-manifest.js',
			'dist/agents/kernel/artifacts/artifact-receipts.js',
			'dist/agents/kernel/telemetry/telemetry.js',
			'dist/agents/kernel/validation/failure-classifier.js',
			'dist/agents/handlers/writer.js',
			'dist/agents/handlers/actor.js',
			'dist/agents/handlers/estimate.js',
			'dist/agents/handlers/releaser.js',
			'dist/agents/handlers/reporter.js',
			'dist/agents/handlers/execution-content-context.js',
			'dist/agents/tools/agent-tool-telemetry.js',
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
		const output = execFileSync('npm', ['pack', '--plan', '--json', '--ignore-scripts'], {
			cwd: packageRoot,
			encoding: 'utf8',
			env: {
				...process.env,
				TREESEED_SKIP_PACKAGE_PREPARE: '1',
			},
		});
		const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
		const paths = pack.files.map((entry) => entry.path);

		expect(paths).toContain('dist/provider/lifecycle/entrypoint.js');
		expect(paths).toContain('dist/provider/configuration/config.js');
		expect(paths).toContain('dist/provider/coordination/coordinator.js');
		expect(paths).toContain('dist/provider/projects/projects-core/project-materialization.js');
		expect(paths).toContain('dist/provider/operations/runner.js');
		expect(paths).toContain('dist/provider/lifecycle/lifecycle.js');
		expect(paths).toContain('dist/scripts/capacity/providers/build-capacity-provider-container.js');
		expect(paths).toContain('dist/scripts/capacity/providers/test-capacity-provider-container.js');
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
		const releaseVerify = readFileSync(resolve(packageRoot, 'scripts/packages/release-verify.ts'), 'utf8');
		const compose = readFileSync(resolve(packageRoot, 'compose.capacity-provider.yml'), 'utf8');
		const containerSmoke = readFileSync(resolve(packageRoot, 'scripts/capacity/providers/test-capacity-provider-container.ts'), 'utf8');
		const docs = readFileSync(resolve(packageRoot, 'docs/capacity-provider-runtime.md'), 'utf8');

		expect(dockerfile).not.toContain('FROM node-runtime AS agent-api');
		expect(dockerfile).toContain('FROM node:22-alpine AS agent-provider-base');
		expect(dockerfile).toContain('FROM agent-provider-base AS agent-runtime');
		expect(dockerfile).toContain('FROM agent-runtime AS agent-manager');
		expect(dockerfile).toContain('FROM agent-runtime AS agent-runner');
		expect(dockerfile).toContain('FROM agent-runner AS railway-runtime');
		expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]');
		expect(entrypoint).toContain('setpriv');
		expect(releaseVerify).toContain("[providerEntrypoint, 'plan', '--json']");
		expect(releaseVerify).not.toContain("[providerEntrypoint, 'register'");
		expect(releaseVerify).toContain('privateKeyRef: secret://capacity/packed-smoke-provider-identity');
		expect(releaseVerify).not.toContain('privateKeyRef: env:');
		expect(dockerfile).toContain('FROM node:22');
		expect(dockerfile).toContain('.treeseed/docker/runtime/shared/node_modules');
		expect(dockerfile).not.toContain('RUN npm ci');
		expect(dockerfile).not.toContain('COPY . .');
		expect(dockerfile).not.toContain('treeseed-processing');
		expect(dockerfile).not.toContain('packages/core');
		expect(compose).toContain('target: agent-manager');
		expect(compose).toContain('target: agent-runner');
		expect(compose.match(/soft: 0/gu)).toHaveLength(2);
		expect(compose.match(/hard: 0/gu)).toHaveLength(2);
		expect(compose.match(/^\s+TREESEED_PROVIDER_ASSIGNMENT_DISK_HEADROOM_BYTES:/gmu)).toHaveLength(2);
		expect(compose.match(/^\s+TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST:/gmu)).toHaveLength(2);
		expect(compose).not.toContain('treeseed/agent-api');
		expect(compose).toContain('treeseed/agent-manager');
		expect(compose).toContain('treeseed/agent-runner');
		expect(compose).toContain('TREESEED_PROVIDER_STARTUP_MODE');
		expect(compose).toContain('TREESEED_CAPACITY_PROVIDER_MANIFEST: /config/treeseed.capacity-provider.yaml');
		expect(compose).toContain(':/config/treeseed.capacity-provider.yaml:ro');
		expect(compose).toContain(':/run/treeseed-secrets/codex-auth.json:ro');
		expect(compose).not.toContain(':/data/codex/auth.json:ro');
		expect(compose.match(/TREESEED_PROVIDER_UID: \$\{TREESEED_PROVIDER_CONTAINER_UID:-65532\}/gu)).toHaveLength(2);
		expect(readFileSync(resolve(packageRoot, 'scripts/capacity/providers/build-capacity-provider-container.ts'), 'utf8')).not.toMatch(/rmSync\([^\n]+@github\/copilot/u);
		expect(compose.match(/TREESEED_PROVIDER_GID: \$\{TREESEED_PROVIDER_CONTAINER_GID:-65532\}/gu)).toHaveLength(2);
		expect(compose).not.toContain('TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN:');
		expect(compose).not.toContain('env_file');
		expect(compose).not.toMatch(/tscp_[A-Za-z0-9_]+|tsp_[A-Za-z0-9_]+|sk-[A-Za-z0-9_]+/u);
		expect(containerSmoke).toContain("'config', '--quiet'");
		expect(containerSmoke).not.toContain("projectName, 'config'],");
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
		expect(deployWorkflow).toContain('npm run capacity-provider:build -- --prepare-only');
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
		expect(readme).toContain('.github/workflows/publish.yml');
		expect(readme).toContain('active team allocation sets');
		expect(readme).not.toContain(staleWorkflowName);
		expect(readme).not.toContain(staleSmokePhrase);
		expect(packageSource).not.toContain(staleBudgetName);
		expect(packageSource).not.toContain('codex_subscription');
		expect(envRegistry).not.toContain('TREESEED_WORKDAY_TASK_CREDIT_BUDGET');
	});

	it('exposes one canonical selector per execution-provider adapter', () => {
		const factory = readFileSync(resolve(packageRoot, 'src/agents/adapters/execution/execution.ts'), 'utf8');
		const registry = readFileSync(resolve(packageRoot, 'src/agent-runtime.ts'), 'utf8');
		expect(existsSync(resolve(packageRoot, 'src/agents/adapters/execution-deterministic.ts'))).toBe(false);
		expect(existsSync(resolve(packageRoot, 'src/agents/adapters/execution-mock.ts'))).toBe(false);
		for (const id of ['codex', 'copilot', 'jira', 'github_issues', 'discord', 'workflow']) {
			expect(factory).toContain(`'${id}'`);
		}
		expect(registry).toContain('BUILT_IN_AGENT_EXECUTION_PROVIDER_IDS.map');
		expect(registry).toContain('createExecutionProviderAdapter(id, { repoRoot })');
		for (const removed of ['mock', 'deterministic', 'ci_mock', 'deterministic_mock', 'jira_issue_queue', 'human_issue_queue', 'github_issue_queue', 'issue_queue', 'discord_thread', 'workflow_operation', 'deterministic_workflow', 'github_actions_workflow']) {
			expect(factory).not.toContain(`configuredMode === '${removed}'`);
			expect(registry).not.toContain(`['${removed}'`);
		}
	});

	it('forbids provider-shaped test doubles across the agent package', () => {
		const roots = ['src', 'test', '.fixtures', 'guarantees']
			.map((directory) => resolve(packageRoot, directory))
			.filter(existsSync);
		const thisFile = fileURLToPath(import.meta.url);
		const providerDoubleFile = new RegExp(
			String.raw`(?:mock|fake|stub|synthetic).*(?:provider|execution)|(?:provider|execution).*(?:mock|fake|stub|synthetic)`,
			'iu',
		);
		const providerDoubleDeclaration = new RegExp(
			String.raw`\b(?:class|function|const|let|var)\s+(?:Mock|Fake|Stub|Synthetic)\w*(?:Provider|Execution)\w*`,
			'u',
		);

		for (const filePath of roots.flatMap(walkFiles)) {
			if (filePath === thisFile) continue;
			expect(providerDoubleFile.test(filePath), `provider double filename: ${filePath}`).toBe(false);
			if (!['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(filePath))) continue;
			const source = readFileSync(filePath, 'utf8');
			expect(providerDoubleDeclaration.test(source), `provider double declaration: ${filePath}`).toBe(false);
		}
	});
});
