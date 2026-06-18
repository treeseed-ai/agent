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
		const decisionInput = context.capacity?.decisionInput?.input ?? {};
		return {
			runId: context.runId,
			mode: context.capacity?.mode ?? null,
			workspaceAccessMode: context.capacity?.workspaceAccessMode ?? null,
			workflowOperationHandleCount: context.capacity?.capabilityHandles?.workflowOperations?.length ?? 0,
			dispatchWorkflowOperation: decisionInput.dispatchWorkflowOperation ?? false,
			workflowOperationId: decisionInput.workflowOperationId ?? null,
			workflowOperationHandleId: decisionInput.workflowOperationHandleId ?? null,
		};
	},
	async execute(context, inputs) {
		let operationResult = null;
		if (inputs.dispatchWorkflowOperation) {
			operationResult = await context.operations.runOperation({
				request: {
					operation: 'verify',
					mode: 'mutating',
					taskId: context.capacity?.assignmentId ?? context.runId,
					agentSlug: context.agent.slug,
					agentRole: 'engineer',
					projectId: context.capacity?.assignment?.projectId ?? 'project_123',
					environment: 'local',
					repoRoot: context.repoRoot,
					input: {
						workflowOperationId: inputs.workflowOperationId,
						workflowOperationHandleId: inputs.workflowOperationHandleId,
						inputs: { planId: 'plan-1' },
					},
				},
				grants: [],
			});
		}
		return { ...inputs, operationResult, summary: \`Project-owned provider planner completed in \${inputs.mode ?? 'unbounded'} mode.\` };
	},
	async emitOutputs(_context, result) {
		return { status: 'completed', summary: result.summary, metadata: { mode: result.mode, workspaceAccessMode: result.workspaceAccessMode, workflowOperationHandleCount: result.workflowOperationHandleCount, operationStatus: result.operationResult?.status ?? null } };
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
			id: 'agent_execution',
			agents: expect.arrayContaining(['*']),
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
			assignmentRequest: {
				capabilities: ['agent_execution'],
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
			async nextAssignment() {
				events.push({ method: 'nextAssignment' });
				return {
					ok: true,
					leaseToken: 'lease_1',
					payload: {
						id: 'task_1',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner' } },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'task_1', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'task_1', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, role: 'runner', assigned: 1, assignmentId: 'task_1' });
		expect(events.map((event) => event.method)).toEqual([
			'nextAssignment',
			'createAssignmentModeRun',
			'createAssignmentModeRun',
			'completeAssignment',
		]);
		expect(events.filter((event) => event.method === 'createAssignmentModeRun').map((event) => (event.body as Record<string, unknown>).status)).toEqual(['running', 'succeeded']);
		expect(events.find((event) => event.method === 'completeAssignment')?.body).toMatchObject({
			output: {
				dryRun: true,
				agentSlug: 'provider-planner',
				mode: 'planning',
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
			async nextAssignment() {
				events.push({ method: 'nextAssignment' });
				return {
					ok: true,
					leaseToken: 'lease_hosted',
					payload: {
						id: 'task_hosted',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner' } },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'task_hosted', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'task_hosted', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'task_hosted' });
		expect(events.map((event) => event.method)).toEqual([
			'nextAssignment',
			'portfolio',
			'createWorkday',
			'writeReport',
			'createAssignmentModeRun',
			'createAssignmentModeRun',
			'completeAssignment',
		]);
	});

	it('executes acting assignments through the kernel with acting mode telemetry', async () => {
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
			async nextAssignment() {
				events.push({ method: 'nextAssignment' });
				return {
					ok: true,
					leaseToken: 'lease_acting',
					payload: {
						id: 'assignment_acting',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'acting',
						decisionInput: {
							input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner' },
							metadata: {
								capacityPlanId: 'plan_acting',
								capacityPlanStatus: 'accepted',
								readiness: { executionReadiness: 'ready', planningInputsStatus: 'complete' },
							},
						},
						capacityEnvelope: {
							projectId: 'project_123',
							mode: 'acting',
							reservationId: 'reservation_acting',
							reservedCredits: 1,
							metadata: { capacityPlanId: 'plan_acting', capacityPlanStatus: 'accepted' },
						},
					},
				};
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'assignment_acting', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_acting', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_acting' });
		expect(events.filter((event) => event.method === 'createAssignmentModeRun').map((event) => (event.body as Record<string, unknown>).capacityEnvelope)).toEqual([
			expect.objectContaining({ mode: 'acting' }),
			expect.objectContaining({ mode: 'acting' }),
		]);
		expect(events.find((event) => event.method === 'completeAssignment')?.body).toMatchObject({
			output: {
				mode: 'acting',
				summary: 'Project-owned provider planner completed in acting mode.',
			},
		});
	});

	it('dispatches workflow operations only through assignment-scoped handles', async () => {
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
		const events: Array<{ method: string; assignmentId?: string; operationId?: string; body?: unknown }> = [];
		const client = {
			async nextAssignment() {
				events.push({ method: 'nextAssignment' });
				return {
					ok: true,
					leaseToken: 'lease_workflow',
					payload: {
						id: 'assignment_workflow',
						teamId: 'team_123',
						projectId: 'project_123',
						capacityProviderId: 'provider_123',
						agentId: 'provider-planner',
						mode: 'acting',
						synthesizedFrom: 'capacity_plan',
						decisionInput: {
							input: {
								dryRun: true,
								projectId: 'project_123',
								agentSlug: 'provider-planner',
								dispatchWorkflowOperation: true,
								workflowOperationId: 'verify-private-repo',
								workflowOperationHandleId: 'workflow-handle-1',
							},
							metadata: {
								capacityPlanId: 'plan_workflow',
								capacityPlanStatus: 'accepted',
								readiness: { executionReadiness: 'ready', planningInputsStatus: 'complete' },
							},
						},
						capacityEnvelope: {
							teamId: 'team_123',
							projectId: 'project_123',
							mode: 'acting',
							capacityProviderId: 'provider_123',
							reservationId: 'reservation_workflow',
							reservedCredits: 1,
							metadata: { capacityPlanId: 'plan_workflow', capacityPlanStatus: 'accepted' },
						},
						capabilityHandles: {
							workspaceAccessMode: 'full_workspace_no_credentials',
							workflowOperations: [{
								id: 'workflow-handle-1',
								kind: 'workflow_operation',
								teamId: 'team_123',
								projectId: 'project_123',
								assignmentId: 'assignment_workflow',
								status: 'active',
								workspaceAccessMode: 'full_workspace_no_credentials',
								operations: ['dispatch_workflow'],
								operationId: 'verify-private-repo',
								repository: 'treeseed/project',
								workflowFile: '.github/workflows/verify.yml',
								ref: 'refs/heads/main',
								secretBearing: true,
							}],
						},
					},
				};
			},
			async dispatchAssignmentWorkflowOperation(assignmentId: string, operationId: string, body: unknown) {
				events.push({ method: 'dispatchAssignmentWorkflowOperation', assignmentId, operationId, body });
				return { ok: true, payload: { dispatch: { id: 'dispatch-1', status: 'dispatched' } } };
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'assignment_workflow', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_workflow', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_workflow' });
		expect(events.find((event) => event.method === 'dispatchAssignmentWorkflowOperation')).toMatchObject({
			assignmentId: 'assignment_workflow',
			operationId: 'verify-private-repo',
			body: {
				leaseToken: 'lease_workflow',
				handleId: 'workflow-handle-1',
				inputs: { planId: 'plan-1' },
			},
		});
		expect(JSON.stringify(events)).not.toContain('ghs_');
		expect(events.filter((event) => event.method === 'createAssignmentModeRun').at(-1)?.body).toMatchObject({
			outputs: {
				metadata: {
					workspaceAccessMode: 'full_workspace_no_credentials',
					workflowOperationHandleCount: 1,
					operationStatus: 'completed',
				},
			},
		});
	});

	it('fails live claimed tasks when the provider has not synced project state', async () => {
		const config = resolveProviderConfig({ env: env() });
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async nextAssignment() {
				return {
					ok: true,
					leaseToken: 'lease_2',
					payload: {
						id: 'task_2',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						decisionInput: { input: {} },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: 'mode_run_1' } };
			},
			async completeAssignment() {
				events.push({ method: 'completeAssignment' });
				throw new Error('non-dry-run task must not complete');
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'task_2', status: 'failed' } };
			},
		};

		const result = await runProviderRunnerOnce({ config, client });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'task_2' });
		expect(events.map((event) => event.method)).toEqual(['failAssignment']);
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			code: 'provider_project_not_synced',
		});
	});
});
