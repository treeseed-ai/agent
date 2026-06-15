import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TREESEED_REMOTE_CONTRACT_HEADER } from '@treeseed/sdk';
import type { CapacityProviderPortfolioManifest } from '@treeseed/sdk/capacity-provider';
import { createCapacityProviderApp } from '../../src/api/provider-app.ts';
import { resolveProviderConfig } from '../../src/provider/config.ts';
import { buildProviderPlan, runManagerSkeleton, runRunnerSkeleton } from '../../src/provider/lifecycle.ts';
import { buildProviderRegistrationRequest } from '../../src/provider/registration.ts';
import { processProviderPortfolio } from '../../src/provider/portfolio-processing.ts';
import { runProviderRunnerOnce } from '../../src/provider/runner.ts';

const tempRoots: string[] = [];

function tempDir() {
	const root = mkdtempSync(join(tmpdir(), 'treeseed-provider-runtime-'));
	tempRoots.push(root);
	return root;
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		TREESEED_MARKET_URL: 'http://127.0.0.1:8787',
		TREESEED_MARKET_ID: 'local',
		TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_secret_local_provider_key',
		TREESEED_PROVIDER_DATA_DIR: tempDir(),
		TREESEED_PROVIDER_ENVIRONMENT: 'local',
		HOME: tempDir(),
		...overrides,
	};
}

function git(cwd: string, args: string[]) {
	execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'TreeSeed Test',
			GIT_AUTHOR_EMAIL: 'test@treeseed.local',
			GIT_COMMITTER_NAME: 'TreeSeed Test',
			GIT_COMMITTER_EMAIL: 'test@treeseed.local',
		},
		stdio: 'ignore',
	});
}

function createProjectRepository() {
	const root = tempDir();
	mkdirSync(resolve(root, 'src/agents'), { recursive: true });
	mkdirSync(resolve(root, 'src/content/agents'), { recursive: true });
	mkdirSync(resolve(root, 'src/content/agent-tests/fixtures'), { recursive: true });
	writeFileSync(resolve(root, 'src/agents/planner.ts'), `export const plannerHandler = {
	kind: 'planner',
	async resolveInputs(context) {
		return { runId: context.runId };
	},
	async execute(_context, inputs) {
		return { ...inputs, summary: 'Project-owned provider planner completed.' };
	},
	async emitOutputs(_context, result) {
		return { status: 'completed', summary: result.summary };
	},
};
`, 'utf8');
	writeFileSync(resolve(root, 'src/content/agent-tests/fixtures/input.json'), '{}\n', 'utf8');
	writeFileSync(resolve(root, 'src/content/agents/provider-planner.mdx'), `---
slug: provider-planner
handler: planner
enabled: true
systemPrompt: Plan provider dry runs.
persona: Planner.
triggers:
  - type: startup
permissions:
  - model: message
    operations: [create]
execution: {}
outputs: {}
---
Provider planner.
`, 'utf8');
	writeFileSync(resolve(root, 'src/content/agent-tests/provider-planner-basic.mdx'), `---
id: provider-planner-basic
agent: provider-planner
kind: dry-run
fixture: src/content/agent-tests/fixtures
---
Provider planner test.
`, 'utf8');
	git(root, ['init', '-b', 'main']);
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'seed project agents']);
	return root;
}

function portfolio(cloneUrl: string): CapacityProviderPortfolioManifest {
	return {
		team: { id: 'team_123', slug: 'treeseed', name: 'TreeSeed' },
		projects: [{
			id: 'project_123',
			slug: 'market',
			name: 'Market',
			repository: {
				provider: 'git',
				role: 'primary',
				owner: 'local',
				name: 'market',
				defaultBranch: 'main',
				cloneUrl,
				checkoutPath: '.',
			},
			agentSpecs: { root: 'src/content/agents', testsRoot: 'src/content/agent-tests' },
			workPolicy: { enabled: true, dailyCreditBudget: 10, maxRunners: 1 },
			metadata: { environment: 'local' },
		}],
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('capacity provider runtime', () => {
	it('resolves dry-run config without provider secrets and redacts secret display values', () => {
		const config = resolveProviderConfig({
			env: {
				TREESEED_PROVIDER_DATA_DIR: tempDir(),
				TREESEED_PROVIDER_ENVIRONMENT: 'local',
				TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_secret_local_provider_key',
			},
			requireConnection: false,
		});

		expect(config.marketUrl).toBe('https://api.treeseed.ai');
		expect(config.marketId).toBe('local');
		expect(config.apiKey).toBe('tscp_secret_local_provider_key');
		expect(config.redactedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY).toContain('<redacted>');
		expect(config.redactedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY).not.toBe(config.apiKey);
	});

	it('requires only the provider API key for connected roles', () => {
		expect(() => resolveProviderConfig({
			env: { TREESEED_MARKET_URL: 'http://127.0.0.1:8787' },
			requireConnection: true,
		})).toThrow(/TREESEED_CAPACITY_PROVIDER_API_KEY/u);

		const config = resolveProviderConfig({
			env: {
				TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_secret_local_provider_key',
				TREESEED_PROVIDER_DATA_DIR: tempDir(),
			},
			requireConnection: true,
		});
		expect(config.apiKey).toBe('tscp_secret_local_provider_key');
		expect(config.marketUrl).toBe('https://api.treeseed.ai');
		expect(config.marketId).toBe('local');
	});

	it('prefers central management API URL over market URL for startup registration', () => {
		const config = resolveProviderConfig({
			env: {
				TREESEED_MANAGEMENT_API_URL: 'https://api.example.test',
				TREESEED_MARKET_URL: 'http://127.0.0.1:8787',
				TREESEED_MARKET_ID: 'local',
				TREESEED_CAPACITY_PROVIDER_ID: 'provider-local',
				TREESEED_CAPACITY_PROVIDER_TEAM_ID: 'team-local',
				TREESEED_CAPACITY_PROVIDER_API_KEY: 'tscp_secret_local_provider_key',
				TREESEED_PROVIDER_DATA_DIR: tempDir(),
			},
			requireConnection: true,
		});
		expect(config.marketUrl).toBe('https://api.example.test');
		expect(config.env.TREESEED_CAPACITY_PROVIDER_ID).toBe('provider-local');
		expect(config.env.TREESEED_CAPACITY_PROVIDER_TEAM_ID).toBe('team-local');
	});

	it('uses the default Codex auth file when ~/.codex/auth.json exists', () => {
		const home = tempDir();
		mkdirSync(resolve(home, '.codex'), { recursive: true });
		writeFileSync(resolve(home, '.codex/auth.json'), JSON.stringify({ OPENAI_CODEX_LOGIN: 'test' }), 'utf8');

		const config = resolveProviderConfig({
			env: env({
				HOME: home,
				TREESEED_CODEX_AUTH_FILE: '',
				TREESEED_CODEX_AUTH_JSON_B64: '',
			}),
		});
		const request = buildProviderRegistrationRequest(config);

		expect(config.codexAuthFile).toBe(resolve(home, '.codex/auth.json'));
		expect(config.env.TREESEED_CODEX_AUTH_FILE).toBe(resolve(home, '.codex/auth.json'));
		expect(request.health.codexReady).toBe(true);
	});

	it('builds the package-owned registration request from SDK capacity provider contracts', () => {
		const config = resolveProviderConfig({ env: env() });
		const request = buildProviderRegistrationRequest(config);

		expect(request).toMatchObject({
			marketId: 'local',
			runtime: {
				package: '@treeseed/agent',
				entrypoint: 'packages/agent/dist/provider/entrypoint.js',
				roles: ['api', 'manager', 'runner'],
			},
			budgets: {
				maxConcurrentWorkdays: 1,
				maxConcurrentRunners: 4,
			},
			health: {
				dataDirWritable: true,
				codexReady: false,
			},
		});
		expect(request.capabilities[0]).toMatchObject({
			id: 'codex-docs-work',
			agents: expect.arrayContaining(['treeseed-docs-planner', 'treeseed-docs-engineer', 'treeseed-docs-reviewer']),
			operations: expect.arrayContaining(['plan', 'mutate', 'verify', 'report']),
		});
	});

	it('serves provider-local health endpoints with the TreeSeed contract header', async () => {
		const config = resolveProviderConfig({ env: env({ TREESEED_CAPACITY_PROVIDER_API_KEY: '' }) });
		const app = createCapacityProviderApp(config);

		const health = await app.fetch(new Request('http://provider.test/healthz'));
		expect(health.status).toBe(200);
		expect(health.headers.get(TREESEED_REMOTE_CONTRACT_HEADER)).toBeTruthy();
		await expect(health.json()).resolves.toMatchObject({ ok: true, service: 'capacity-provider', role: 'api' });

		const ready = await app.fetch(new Request('http://provider.test/readyz'));
		await expect(ready.json()).resolves.toMatchObject({
			ok: true,
			ready: false,
			marketConfigured: true,
			apiKeyConfigured: false,
		});
	});

	it('emits deterministic dry-run manager and runner lifecycle payloads', async () => {
		const config = resolveProviderConfig({ env: env({ TREESEED_CAPACITY_PROVIDER_API_KEY: '' }) });
		const plan = await buildProviderPlan(config, { dryRun: true });
		const manager = await runManagerSkeleton(config, { dryRun: true });
		const runner = await runRunnerSkeleton(config, { dryRun: true });

		expect(plan).toMatchObject({ ok: true, role: 'plan', dryRun: true, portfolio: null });
		expect(manager).toMatchObject({ ok: true, role: 'manager', action: 'portfolio-plan', dryRun: true });
		expect(runner).toMatchObject({
			ok: true,
			role: 'runner',
			dryRun: true,
			claimRequest: {
				limit: 1,
				capabilities: ['codex-docs-work'],
			},
		});
	});

	it('processes a provider portfolio by syncing repositories, validating specs, creating workdays, and writing reports', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
		const calls: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async portfolio() {
				calls.push({ method: 'portfolio' });
				return portfolio(sourceRepo);
			},
			async createWorkday(body: unknown) {
				calls.push({ method: 'createWorkday', body });
				return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } };
			},
			async writeReport(body: unknown) {
				calls.push({ method: 'writeReport', body });
				return { ok: true, report: { id: 'report_1' } };
			},
		};

		const result = await processProviderPortfolio({ config, client });

		expect(result.ok).toBe(true);
		expect(result.projects[0]).toMatchObject({
			projectId: 'project_123',
			repository: { ok: true, branch: 'main' },
			agents: { ok: true, count: 1, enabledCount: 1 },
			tests: { ok: true, count: 1 },
			workDay: { id: 'wd_provider_1' },
		});
		expect(existsSync(resolve(config.dataDir, 'repositories/project_123/repo/.git'))).toBe(true);
		expect(existsSync(result.reportPath)).toBe(true);
		expect(existsSync(result.indexPath)).toBe(true);
		expect(calls.map((call) => call.method)).toEqual(['portfolio', 'createWorkday', 'writeReport']);
		expect(calls.find((call) => call.method === 'createWorkday')?.body).toMatchObject({
			projectId: 'project_123',
			environment: 'local',
			kind: 'provider_portfolio_workday',
		});
	});

	it('skips disabled portfolio projects without cloning or creating workdays', async () => {
		const config = resolveProviderConfig({ env: env() });
		const disabled = portfolio('/no/such/repository');
		disabled.projects[0]!.workPolicy.enabled = false;
		const calls: string[] = [];
		const client = {
			async portfolio() {
				calls.push('portfolio');
				return disabled;
			},
			async createWorkday() {
				calls.push('createWorkday');
				throw new Error('disabled projects must not start workdays');
			},
			async writeReport() {
				calls.push('writeReport');
				throw new Error('disabled projects must not write workday reports without a workday');
			},
		};

		const result = await processProviderPortfolio({ config, client });

		expect(result.ok).toBe(true);
		expect(result.projects[0]).toMatchObject({
			enabled: false,
			repository: { ok: true },
			workDay: null,
		});
		expect(calls).toEqual(['portfolio']);
	});

	it('claims and completes only explicit dry-run project tasks through the provider runner', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
		await processProviderPortfolio({
			config,
			client: {
				async portfolio() { return portfolio(sourceRepo); },
				async createWorkday(body: unknown) { return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } }; },
				async writeReport() { return { ok: true, report: { id: 'report_1' } }; },
			},
		});
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async claimTask() {
				events.push({ method: 'claimTask' });
				return {
					ok: true,
					tasks: [{
						id: 'task_1',
						projectId: 'project_123',
						agentSlug: 'provider-planner',
						input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner' },
					}],
				};
			},
			async appendTaskEvent(_taskId: string, body: unknown) {
				events.push({ method: 'appendTaskEvent', body });
				return { ok: true, event: { id: `event_${events.length}` } };
			},
			async reportUsage(body: unknown) {
				events.push({ method: 'reportUsage', body });
				return { ok: true, usage: { id: 'usage_1' } };
			},
			async completeTask(_taskId: string, body: unknown) {
				events.push({ method: 'completeTask', body });
				return { ok: true, task: { id: 'task_1', status: 'completed' } };
			},
			async failTask(_taskId: string, body: unknown) {
				events.push({ method: 'failTask', body });
				return { ok: true, task: { id: 'task_1', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, role: 'runner', claimed: 1, taskId: 'task_1' });
		expect(events.map((event) => event.method)).toEqual([
			'claimTask',
			'appendTaskEvent',
			'appendTaskEvent',
			'reportUsage',
			'completeTask',
		]);
		expect(events.find((event) => event.method === 'completeTask')?.body).toMatchObject({
			output: {
				dryRun: true,
				agentSlug: 'provider-planner',
			},
		});
	});

	it('refreshes the portfolio index before running dry-run tasks when hosted runners start without shared state', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async portfolio() {
				events.push({ method: 'portfolio' });
				return portfolio(sourceRepo);
			},
			async createWorkday(body: unknown) {
				events.push({ method: 'createWorkday', body });
				return { ok: true, workDay: { id: 'wd_provider_hosted', ...(body as Record<string, unknown>) } };
			},
			async writeReport(body: unknown) {
				events.push({ method: 'writeReport', body });
				return { ok: true, report: { id: 'report_hosted' } };
			},
			async claimTask() {
				events.push({ method: 'claimTask' });
				return {
					ok: true,
					tasks: [{
						id: 'task_hosted',
						projectId: 'project_123',
						agentSlug: 'provider-planner',
						input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner' },
					}],
				};
			},
			async appendTaskEvent(_taskId: string, body: unknown) {
				events.push({ method: 'appendTaskEvent', body });
				return { ok: true, event: { id: `event_${events.length}` } };
			},
			async reportUsage(body: unknown) {
				events.push({ method: 'reportUsage', body });
				return { ok: true, usage: { id: 'usage_hosted' } };
			},
			async completeTask(_taskId: string, body: unknown) {
				events.push({ method: 'completeTask', body });
				return { ok: true, task: { id: 'task_hosted', status: 'completed' } };
			},
			async failTask(_taskId: string, body: unknown) {
				events.push({ method: 'failTask', body });
				return { ok: true, task: { id: 'task_hosted', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, claimed: 1, taskId: 'task_hosted' });
		expect(events.map((event) => event.method)).toEqual([
			'claimTask',
			'portfolio',
			'createWorkday',
			'writeReport',
			'appendTaskEvent',
			'appendTaskEvent',
			'reportUsage',
			'completeTask',
		]);
	});

	it('fails live claimed tasks when the provider has not synced project state', async () => {
		const config = resolveProviderConfig({ env: env() });
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async claimTask() {
				return {
					ok: true,
					tasks: [{ id: 'task_2', projectId: 'project_123', agentSlug: 'provider-planner', input: {} }],
				};
			},
			async appendTaskEvent(_taskId: string, body: unknown) {
				events.push({ method: 'appendTaskEvent', body });
				return { ok: true, event: { id: 'event_1' } };
			},
			async completeTask() {
				events.push({ method: 'completeTask' });
				throw new Error('non-dry-run task must not complete');
			},
			async failTask(_taskId: string, body: unknown) {
				events.push({ method: 'failTask', body });
				return { ok: true, task: { id: 'task_2', status: 'failed' } };
			},
			async reportUsage() {
				events.push({ method: 'reportUsage' });
				throw new Error('non-dry-run task must not report usage');
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, claimed: 1, taskId: 'task_2' });
		expect(events.map((event) => event.method)).toEqual(['appendTaskEvent', 'failTask']);
		expect(events.find((event) => event.method === 'failTask')?.body).toMatchObject({
			errorCode: 'provider_project_not_synced',
		});
	});
});
