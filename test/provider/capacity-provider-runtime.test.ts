import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapacityProviderPortfolioManifest } from '@treeseed/sdk/capacity-provider';
import { resolveProviderConfig } from '../../src/provider/config.ts';
import { buildProviderPlan, runManagerSkeleton, runRunnerSkeleton } from '../../src/provider/lifecycle.ts';
import { buildProviderRegistrationRequest } from '../../src/provider/registration.ts';
import { processProviderPortfolio } from '../../src/provider/portfolio-processing.ts';
import { runProviderRunnerOnce } from '../../src/provider/runner.ts';
import type { ExecutionProviderAdapter } from '../../src/agents/runtime-types.ts';

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

function listMarkdownFiles(root: string, relativeDir: string): Array<{ path: string; content: string }> {
	const absoluteDir = resolve(root, relativeDir);
	if (!existsSync(absoluteDir)) return [];
	return readdirSync(absoluteDir).flatMap((entry) => {
		const absolutePath = resolve(absoluteDir, entry);
		const relativePath = `${relativeDir.replace(/\/$/u, '')}/${entry}`.replace(/\\/g, '/');
		if (statSync(absolutePath).isDirectory()) {
			return listMarkdownFiles(root, relativePath);
		}
		if (!/\.(md|mdx)$/iu.test(entry)) return [];
		return [{ path: relativePath, content: readFileSync(absolutePath, 'utf8') }];
	});
}

function fakeTreeDxFetch(repoRoot: string): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/repos')) {
			return new Response(JSON.stringify({
				ok: true,
				repos: [{
					repoId: 'repo-project-123',
					name: 'treeseed-market',
					repositoryName: 'treeseed-market',
					defaultRef: 'refs/heads/main',
					status: 'registered',
				}],
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		if (url.pathname.endsWith('/paths/list')) {
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
			const root = typeof body.path === 'string' ? body.path : 'src/content/agents';
			const paths = listMarkdownFiles(repoRoot, root).map((file) => file.path);
			return new Response(JSON.stringify({ ok: true, paths }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		if (url.pathname.endsWith('/files/read')) {
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
			const filePath = typeof body.path === 'string' ? body.path : '';
			const absolutePath = resolve(repoRoot, filePath);
			if (!filePath || !existsSync(absolutePath)) {
				return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: `File ${filePath} not found.` } }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({
				ok: true,
				file: {
					path: filePath,
					content: readFileSync(absolutePath, 'utf8'),
					encoding: 'utf8',
					source: 'base',
				},
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		if (url.pathname.endsWith('/files/search') || url.pathname.endsWith('/search/files')) {
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
			const paths = Array.isArray(body.paths) ? body.paths.map(String) : ['src/content/agents/**'];
			const files = paths.flatMap((pattern) => {
				const root = pattern.replace(/\/\*\*.*$/u, '').replace(/\/$/u, '');
				return listMarkdownFiles(repoRoot, root);
			});
			return new Response(JSON.stringify({ ok: true, files }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response(JSON.stringify({ ok: false, error: { message: `Unhandled fake TreeDX route ${url.pathname}` } }), {
			status: 404,
			headers: { 'content-type': 'application/json' },
		});
	};
}

function fakeTreeDxOptions(repoRoot: string) {
	return {
		baseUrl: 'https://treedx.test',
		token: 'test-token',
		repoId: 'repo-project-123',
		ref: 'main',
		fetchImpl: fakeTreeDxFetch(repoRoot),
	};
}

function createProjectRepository() {
	const root = tempDir();
	mkdirSync(resolve(root, 'src/agents'), { recursive: true });
	mkdirSync(resolve(root, 'src/content/agents'), { recursive: true });
	mkdirSync(resolve(root, 'src/content/agent-tests/fixtures'), { recursive: true });
	writeFileSync(resolve(root, 'src/agents/plan.ts'), `export const planHandler = {
	kind: 'plan',
	async resolveInputs(context) {
		const decisionInput = context.capacity?.decisionInput?.input ?? {};
		return {
			runId: context.runId,
			mode: context.capacity?.mode ?? null,
			workspaceAccessMode: context.capacity?.workspaceAccessMode ?? null,
			workflowOperationHandleCount: context.capacity?.capabilityHandles?.workflowOperations?.length ?? 0,
			dispatchWorkflowOperation: decisionInput.dispatchWorkflowOperation ?? false,
			useExecutionProvider: decisionInput.useExecutionProvider ?? false,
			workflowOperationId: decisionInput.workflowOperationId ?? null,
			workflowOperationHandleId: decisionInput.workflowOperationHandleId ?? null,
		};
	},
	async execute(context, inputs) {
		if (inputs.useExecutionProvider) {
			const snapshot = await context.execution.start({
				assignment: context.capacity.assignment,
				capacityEnvelope: context.capacity.envelope,
				decisionInput: context.capacity.decisionInput,
				agent: context.agent,
				workPackage: {
					kind: 'planning',
					title: 'Async provider runtime test',
					summary: 'Exercise execution provider lifecycle polling.',
					instructions: 'Run the async provider test work package.',
					context: {},
					expectedOutputs: [{ type: 'final_response', required: true }],
					constraints: {
						mode: context.capacity.mode,
						requiredCapabilities: ['planning'],
					},
				},
				leaseToken: null,
				runnerId: 'test-runner',
				projectAgentClass: context.capacity.projectAgentClass,
				workspace: null,
				metadata: { runId: context.capacity.assignmentId },
			});
			return { ...inputs, executionSnapshot: snapshot, summary: snapshot.summary };
		}
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
		if (result.executionSnapshot) {
			return {
				status: result.executionSnapshot.status === 'completed'
					? 'completed'
					: result.executionSnapshot.status === 'failed' || result.executionSnapshot.status === 'cancelled'
						? 'failed'
						: 'waiting',
				summary: result.executionSnapshot.summary,
				metadata: {
					mode: result.mode,
					executionStatus: result.executionSnapshot.status,
					externalRef: result.executionSnapshot.externalRef ?? null,
					externalUrl: result.executionSnapshot.externalUrl ?? null,
					code: result.executionSnapshot.code ?? null,
					artifacts: result.executionSnapshot.artifacts ?? [],
					usage: result.executionSnapshot.usage ?? [],
				},
			};
		}
		return { status: 'completed', summary: result.summary, metadata: { mode: result.mode, workspaceAccessMode: result.workspaceAccessMode, workflowOperationHandleCount: result.workflowOperationHandleCount, operationStatus: result.operationResult?.status ?? null } };
	},
};
`, 'utf8');
	writeFileSync(resolve(root, 'src/content/agent-tests/fixtures/input.json'), '{}\n', 'utf8');
	writeFileSync(resolve(root, 'src/content/agents/provider-planner.mdx'), `---
slug: provider-planner
handler: plan
projectAgentClassId: planning
projectAgentClassSlug: planning
enabled: true
systemPrompt: Plan provider dry runs.
persona: Planner.
triggers:
  - type: startup
permissions:
  - model: message
    operations: [create]
tools:
  allowed:
    - treedx.build_context
    - treedx.read_repository_files
    - treedx.search_workspace
    - treedx.read_workspace_file
    - treedx.write_workspace_file
    - treedx.commit_workspace
    - treeseed.status
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
			architecture: {
				topology: 'single_repository_site',
				rootPath: '.',
				sitePath: 'docs',
				contentPath: 'src/content',
				contentRuntimeSource: 'r2_published_manifest',
				localContentMaterialization: 'none',
				contentPublishTarget: { kind: 'cloudflare_r2', prefix: 'packages/market' },
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

class FakeAsyncExecutionProviderAdapter implements ExecutionProviderAdapter {
	polls = 0;
	lastStartInput: Parameters<ExecutionProviderAdapter['start']>[0] | null = null;

	constructor(
		private readonly terminal: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'poll_failed' | 'never_completed' = 'completed',
		private readonly options: {
			prepareRejected?: boolean;
			prepareRetryable?: boolean;
		} = {},
	) {}

	async describe() {
		return {
			id: `fake_async_${this.terminal}`,
			kind: 'human_issue_queue' as const,
			capabilities: ['planning'],
			nativeUnit: 'issue',
			quotaVisibility: 'partial' as const,
			maxConcurrentAssignments: 1,
			supportsAsync: true,
			supportsCancel: true,
			supportsResume: true,
			supportsUsage: true,
			supportsArtifacts: true,
		};
	}

	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'normal' as const,
			activeAssignmentCount: 0,
		};
	}

	async prepare() {
		if (this.options.prepareRejected) {
			return {
				accepted: false,
				summary: this.options.prepareRetryable === false
					? 'Fake async provider prepare rejected terminally.'
					: 'Fake async provider prepare rejected retryably.',
				retryable: this.options.prepareRetryable,
				code: 'fake_prepare_rejected',
			};
		}
		return {
			accepted: true,
			summary: 'Fake async provider accepted preparation.',
		};
	}

	async start(input: Parameters<ExecutionProviderAdapter['start']>[0]) {
		this.lastStartInput = input;
		if (this.terminal === 'blocked') {
			return {
				status: 'blocked' as const,
				summary: 'Fake async provider is blocked.',
				runId: 'fake-run-1',
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
				retryable: true,
				code: 'human_provider_blocked',
				metadata: { provider: 'fake_async' },
			};
		}
		if (this.terminal === 'failed') {
			return {
				status: 'failed' as const,
				summary: 'Fake async provider failed terminally.',
				runId: 'fake-run-1',
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
				retryable: false,
				code: 'external_issue_deleted',
				metadata: { provider: 'fake_async' },
			};
		}
		if (this.terminal === 'cancelled') {
			return {
				status: 'cancelled' as const,
				summary: 'Fake async provider was cancelled.',
				runId: 'fake-run-1',
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
				retryable: false,
				code: 'human_provider_cancelled',
				metadata: { provider: 'fake_async' },
			};
		}
		return {
			status: 'waiting' as const,
			summary: 'Fake async provider accepted work.',
			runId: 'fake-run-1',
			externalRef: 'ISSUE-1',
			externalUrl: 'https://issues.example.test/ISSUE-1',
			metadata: { provider: 'fake_async' },
		};
	}

	async poll() {
		if (this.terminal === 'poll_failed') {
			throw new Error('Fake async provider poll failed.');
		}
		this.polls += 1;
		if (this.terminal === 'never_completed') {
			return {
				status: 'running' as const,
				summary: 'Fake async provider is still running.',
				runId: 'fake-run-1',
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
			};
		}
		if (this.polls < 2) {
			return {
				status: 'running' as const,
				summary: 'Fake async provider is running.',
				runId: 'fake-run-1',
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
			};
		}
		return {
			status: 'completed' as const,
			summary: 'Fake async provider completed.',
			runId: 'fake-run-1',
			externalRef: 'ISSUE-1',
			externalUrl: 'https://issues.example.test/ISSUE-1',
			outputs: { finalResponse: 'done' },
		};
	}

	async collectUsage() {
		return [{ kind: 'issue_time', unit: 'wall_minute', amount: 3, source: 'fake_async' }];
	}

	async collectArtifacts() {
		return [{ kind: 'external_issue', name: 'ISSUE-1', externalUrl: 'https://issues.example.test/ISSUE-1' }];
	}
}

async function runAsyncExecutionProviderScenario(input: {
	adapter: ExecutionProviderAdapter;
	assignmentId: string;
	runnerId: string;
	renewFailsAfter?: number;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
}) {
	const sourceRepo = createProjectRepository();
	const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
				client: {
			async portfolio() { return portfolio(sourceRepo); },
			async createWorkday(body: unknown) { return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } }; },
			async writeReport() { return { ok: true, report: { id: 'report_1' } }; },
		},
	});
	const events: Array<{ method: string; body?: unknown }> = [];
	let renewCount = 0;
	const client = {
		async nextAssignment() {
			events.push({ method: 'nextAssignment' });
			return {
				ok: true,
				leaseToken: `lease_${input.assignmentId}`,
				leaseSeconds: 1,
				payload: {
					id: input.assignmentId,
					projectId: 'project_123',
					agentId: 'provider-planner',
					mode: 'planning',
					decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner', useExecutionProvider: true } },
					capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
				},
			};
		},
		async renewAssignment(_assignmentId: string, body: unknown) {
			renewCount += 1;
			events.push({ method: 'renewAssignment', body });
			if (input.renewFailsAfter !== undefined && renewCount > input.renewFailsAfter) {
				throw new Error('fake lease renewal failure');
			}
			return { ok: true, payload: null };
		},
		async createAssignmentModeRun(_assignmentId: string, body: unknown) {
			events.push({ method: 'createAssignmentModeRun', body });
			return { ok: true, payload: { id: `mode_run_${events.length}` } };
		},
		async completeAssignment(_assignmentId: string, body: unknown) {
			events.push({ method: 'completeAssignment', body });
			return { ok: true, payload: { id: input.assignmentId, status: 'completed' } };
		},
		async returnAssignment(_assignmentId: string, body: unknown) {
			events.push({ method: 'returnAssignment', body });
			return { ok: true, payload: { id: input.assignmentId, status: 'returned' } };
		},
		async failAssignment(_assignmentId: string, body: unknown) {
			events.push({ method: 'failAssignment', body });
			return { ok: true, payload: { id: input.assignmentId, status: 'failed' } };
		},
	};
	const result = await runProviderRunnerOnce({
		config,
		client,
		executionAdapter: input.adapter,
		runnerId: input.runnerId,
		treeDx: fakeTreeDxOptions(sourceRepo),
		executionLifecycle: input.executionLifecycle,
	});
	return { events, result };
}

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

		expect(config.marketUrl).toBe('https://api.treeseed.dev');
		expect(config.marketId).toBe('local');
		expect(config.apiKey).toBe('tscp_secret_local_provider_key');
		expect(config.redactedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY).toContain('<redacted>');
		expect(config.redactedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY).not.toBe(config.apiKey);
	});

	it('resolves and redacts human issue queue execution provider credentials', () => {
		const config = resolveProviderConfig({
			env: env({
				TREESEED_JIRA_BASE_URL: 'https://treeseed.atlassian.net',
				TREESEED_JIRA_EMAIL: 'jira@example.test',
				TREESEED_JIRA_API_TOKEN: 'jira-secret-token',
				TREESEED_JIRA_PROJECT_KEY: 'TS',
				TREESEED_GITHUB_ISSUES_TOKEN: 'github-secret-token',
				TREESEED_GITHUB_ISSUES_REPOSITORY: 'treeseed-ai/work',
				TREESEED_DISCORD_BOT_TOKEN: 'discord-secret-token',
				TREESEED_DISCORD_CHANNEL_ID: '123',
				TREESEED_DISCORD_GUILD_ID: '456',
			}),
		});

		expect(config.jira).toMatchObject({ projectKey: 'TS' });
		expect(config.githubIssues).toMatchObject({ repository: 'treeseed-ai/work' });
		expect(config.discord).toMatchObject({ channelId: '123', guildId: '456' });
		expect(config.redactedEnv).toMatchObject({
			TREESEED_JIRA_API_TOKEN: '<redacted>',
			TREESEED_GITHUB_ISSUES_TOKEN: '<redacted>',
			TREESEED_GITHUB_ISSUES_REPOSITORY: 'treeseed-ai/work',
			TREESEED_DISCORD_BOT_TOKEN: '<redacted>',
			TREESEED_DISCORD_CHANNEL_ID: '123',
		});
		expect(JSON.stringify(config.redactedEnv)).not.toContain('jira-secret-token');
		expect(JSON.stringify(config.redactedEnv)).not.toContain('github-secret-token');
		expect(JSON.stringify(config.redactedEnv)).not.toContain('discord-secret-token');
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
		expect(config.marketUrl).toBe('https://api.treeseed.dev');
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

	it('uses Railway PORT for the hosted provider API listener when provider port is not explicit', () => {
		const config = resolveProviderConfig({
			env: env({
				PORT: '8080',
				TREESEED_PROVIDER_API_PORT: '',
			}),
		});

		expect(config.apiPort).toBe(8080);
		expect(config.env.TREESEED_PROVIDER_API_PORT).toBe('8080');
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

			const result = await processProviderPortfolio({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result.ok).toBe(true);
		expect(result.projects[0]).toMatchObject({
			projectId: 'project_123',
			architecture: {
				topology: 'single_repository_site',
				sitePath: 'docs',
				contentRuntimeSource: 'r2_published_manifest',
				workspaceAccess: {
					fullWorkspaceFiles: true,
					pushCredentials: false,
					contentSource: 'r2_published_manifest',
					localContentRequired: false,
				},
			},
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
			summary: {
				projectArchitecture: {
					topology: 'single_repository_site',
					workspaceAccess: { pushCredentials: false },
				},
			},
		});
		expect(calls.find((call) => call.method === 'writeReport')?.body).toMatchObject({
			body: {
				projects: [
					expect.objectContaining({
						architecture: expect.objectContaining({ topology: 'single_repository_site' }),
					}),
				],
			},
		});
		expect(JSON.stringify(result)).not.toContain('GH_TOKEN');
		expect(JSON.stringify(result)).not.toContain('TREESEED_GITHUB_TOKEN');
	});

	it('uses the mounted local workspace instead of cloning local portfolio projects', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({
			env: env({
				TREESEED_PROVIDER_WORKSPACE_ABSOLUTE_CONTAINER: sourceRepo,
			}),
		});
		const client = {
			async portfolio() {
				return portfolio('https://example.invalid/private/market.git');
			},
			async createWorkday(body: unknown) {
				return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } };
			},
			async writeReport() {
				return { ok: true, report: { id: 'report_1' } };
			},
		};

		const result = await processProviderPortfolio({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result.ok).toBe(true);
		expect(result.projects[0]?.repository).toMatchObject({
			ok: true,
			path: sourceRepo,
		});
		expect(existsSync(resolve(config.dataDir, 'repositories/project_123/repo/.git'))).toBe(false);
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
			architecture: {
				topology: 'single_repository_site',
				workspaceAccess: { pushCredentials: false },
			},
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
				treeDx: fakeTreeDxOptions(sourceRepo),
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

			const result = await runProviderRunnerOnce({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result).toMatchObject({ ok: true, role: 'runner', assigned: 1, assignmentId: 'task_1' });
			expect(events.map((event) => event.method)).toEqual(expect.arrayContaining([
				'nextAssignment',
				'createAssignmentModeRun',
				'completeAssignment',
			]));
			expect(events.at(-1)?.method).toBe('completeAssignment');
			const modeRunEvents = events.filter((event) => event.method === 'createAssignmentModeRun');
			expect(modeRunEvents.map((event) => (event.body as Record<string, unknown>).status)).toEqual(expect.arrayContaining(['running', 'succeeded']));
			expect(modeRunEvents[0]?.body).toMatchObject({
				outputs: {
					status: 'preparing',
					metadata: { source: 'provider_runner_assignment_leased' },
				},
			});
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

			const result = await runProviderRunnerOnce({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

			expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'task_hosted' });
			expect(events.map((event) => event.method)).toEqual(expect.arrayContaining([
				'nextAssignment',
				'portfolio',
				'createWorkday',
				'writeReport',
				'createAssignmentModeRun',
				'completeAssignment',
			]));
			expect(events.at(-1)?.method).toBe('completeAssignment');
	});

	it('executes acting assignments through the kernel with acting mode telemetry', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
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

			const result = await runProviderRunnerOnce({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

			expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_acting' });
			const actingModeRuns = events
				.filter((event) => event.method === 'createAssignmentModeRun')
				.map((event) => (event.body as Record<string, unknown>).capacityEnvelope)
				.filter((envelope) => (envelope as Record<string, unknown> | undefined)?.mode === 'acting');
			expect(actingModeRuns.length).toBeGreaterThanOrEqual(3);
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
				treeDx: fakeTreeDxOptions(sourceRepo),
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

			const result = await runProviderRunnerOnce({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

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

	it('selects workflow execution providers from assignment metadata and dispatches through scoped handles', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
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
					leaseToken: 'lease_workflow_provider',
					payload: {
						id: 'assignment_workflow_provider',
						teamId: 'team_123',
						projectId: 'project_123',
						capacityProviderId: 'provider_123',
						agentId: 'provider-planner',
						mode: 'acting',
						executionProviderKind: 'workflow',
						synthesizedFrom: 'capacity_plan',
						decisionInput: {
							input: {
								dryRun: false,
								projectId: 'project_123',
								agentSlug: 'provider-planner',
								useExecutionProvider: true,
								workflowOperationId: 'verify-private-repo',
								workflowOperationHandleId: 'workflow-handle-2',
								inputs: { planId: 'plan-2', token: 'opaque-input' },
							},
							metadata: {
								capacityPlanId: 'plan_workflow_provider',
								capacityPlanStatus: 'accepted',
								readiness: { executionReadiness: 'ready', planningInputsStatus: 'complete' },
							},
						},
						capacityEnvelope: {
							teamId: 'team_123',
							projectId: 'project_123',
							mode: 'acting',
							capacityProviderId: 'provider_123',
							reservationId: 'reservation_workflow_provider',
							reservedCredits: 1,
							metadata: { capacityPlanId: 'plan_workflow_provider', capacityPlanStatus: 'accepted' },
						},
						capabilityHandles: {
							workspaceAccessMode: 'full_workspace_no_credentials',
							workflowOperations: [{
								id: 'workflow-handle-2',
								kind: 'workflow_operation',
								teamId: 'team_123',
								projectId: 'project_123',
								assignmentId: 'assignment_workflow_provider',
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
				return {
					ok: true,
					payload: {
						dispatch: {
							id: 'workflow-run-2',
							status: 'success',
							htmlUrl: 'https://github.example.test/runs/workflow-run-2',
							logsUrl: 'https://github.example.test/runs/workflow-run-2/logs',
							artifactsUrl: 'https://github.example.test/runs/workflow-run-2/artifacts',
							runnerMinutes: 4,
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
				return { ok: true, payload: { id: 'assignment_workflow_provider', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_workflow_provider', status: 'failed' } };
			},
		};

			const result = await runProviderRunnerOnce({ config, client, treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_workflow_provider' });
		expect(events.find((event) => event.method === 'dispatchAssignmentWorkflowOperation')).toMatchObject({
			assignmentId: 'assignment_workflow_provider',
			operationId: 'verify-private-repo',
			body: {
				leaseToken: 'lease_workflow_provider',
				handleId: 'workflow-handle-2',
				inputs: expect.objectContaining({
					planId: 'plan-2',
					token: '<redacted>',
					workflow: {
						operationId: 'verify-private-repo',
						handle: expect.objectContaining({
							id: 'workflow-handle-2',
							secretBearing: true,
						}),
					},
				}),
			},
		});
		const adapterModeRun = events
			.filter((event) => event.method === 'createAssignmentModeRun')
			.map((event) => event.body as Record<string, any>)
			.find((body) => body.metadata?.source === 'execution_provider_adapter_lifecycle');
		expect(adapterModeRun).toMatchObject({
			status: 'succeeded',
			outputs: {
				status: 'completed',
				externalRef: 'workflow-run-2',
				artifacts: expect.arrayContaining([
					expect.objectContaining({ kind: 'workflow_logs', externalUrl: 'https://github.example.test/runs/workflow-run-2/logs' }),
					expect.objectContaining({ kind: 'workflow_artifacts', externalUrl: 'https://github.example.test/runs/workflow-run-2/artifacts' }),
				]),
				usage: expect.arrayContaining([
					expect.objectContaining({ kind: 'workflow_runner_time', amount: 4 }),
				]),
			},
			traceRefs: {
				externalRef: 'workflow-run-2',
			},
		});
		expect(events.find((event) => event.method === 'completeAssignment')?.body).toMatchObject({
			output: {
				metadata: {
					executionStatus: 'completed',
					externalRef: 'workflow-run-2',
					artifacts: expect.arrayContaining([
						expect.objectContaining({ kind: 'workflow_logs' }),
					]),
					usage: expect.arrayContaining([
						expect.objectContaining({ kind: 'workflow_runner_time' }),
					]),
				},
			},
		});
		expect(events.some((event) => event.method === 'failAssignment')).toBe(false);
		expect(JSON.stringify(events)).not.toContain('ghs_secret');
	});

	it('polls async execution providers and renews the assignment lease while waiting', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
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
					leaseToken: 'lease_async',
					leaseSeconds: 1,
					payload: {
						id: 'assignment_async',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
						decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner', useExecutionProvider: true } },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async renewAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'renewAssignment', body });
				return { ok: true, payload: { id: 'assignment_async', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } };
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'assignment_async', status: 'completed' } };
			},
			async returnAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'returnAssignment', body });
				return { ok: true, payload: { id: 'assignment_async', status: 'returned' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_async', status: 'failed' } };
			},
		};
		const adapter = new FakeAsyncExecutionProviderAdapter();

			const result = await runProviderRunnerOnce({ config, client, executionAdapter: adapter, runnerId: 'runner_async', treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_async' });
		expect(events.filter((event) => event.method === 'renewAssignment').length).toBeGreaterThanOrEqual(1);
		const adapterModeRuns = events
			.filter((event) => event.method === 'createAssignmentModeRun')
			.map((event) => event.body as Record<string, any>)
			.filter((body) => body.metadata?.source === 'execution_provider_adapter_lifecycle');
		const leasedHeartbeat = events
			.filter((event) => event.method === 'createAssignmentModeRun')
			.map((event) => event.body as Record<string, any>)
			.find((body) => body.metadata?.source === 'provider_runner_assignment_leased');
		const startingModeRun = events
			.filter((event) => event.method === 'createAssignmentModeRun')
			.map((event) => event.body as Record<string, any>)
			.find((body) => body.metadata?.source === 'execution_provider_starting');
		expect(leasedHeartbeat).toMatchObject({
			id: expect.stringContaining('assignment_async:planning:provider-planner:handler'),
			status: 'running',
			outputs: {
				status: 'preparing',
				metadata: {
					source: 'provider_runner_assignment_leased',
					runnerId: 'runner_async',
				},
			},
			traceRefs: {
				assignmentId: 'assignment_async',
				runnerId: 'runner_async',
				leaseToken: '<redacted>',
			},
		});
		expect(startingModeRun).toMatchObject({
			id: expect.stringContaining('assignment_async:planning:provider-planner:handler'),
			outputs: {
				metadata: {
					source: 'execution_provider_starting',
					redactedParameters: {
						assignmentId: 'assignment_async',
						projectId: 'project_123',
						mode: 'planning',
					},
				},
			},
		});
		expect(adapterModeRuns.map((body) => body.outputs?.status)).toEqual(['waiting', 'running', 'completed']);
		expect(adapterModeRuns.at(-1)).toMatchObject({
			status: 'succeeded',
			outputs: {
				externalRef: 'ISSUE-1',
				externalUrl: 'https://issues.example.test/ISSUE-1',
			},
			traceRefs: {
				externalRef: 'ISSUE-1',
			},
		});
		expect(events.some((event) => event.method === 'completeAssignment')).toBe(true);
		expect(events.some((event) => event.method === 'returnAssignment')).toBe(false);
		expect(events.some((event) => event.method === 'failAssignment')).toBe(false);
		expect(events.find((event) => event.method === 'completeAssignment')?.body).toMatchObject({
			output: {
				metadata: {
					executionStatus: 'completed',
					externalRef: 'ISSUE-1',
					artifacts: [{ kind: 'external_issue' }],
					usage: [{ kind: 'issue_time' }],
				},
			},
		});
	});

	it('times out assignment lease requests instead of occupying a runner slot forever', async () => {
		const previous = process.env.TREESEED_PROVIDER_LEASE_REQUEST_TIMEOUT_MS;
		process.env.TREESEED_PROVIDER_LEASE_REQUEST_TIMEOUT_MS = '1';
		try {
			const config = resolveProviderConfig({ env: env() });
			const events: Array<{ method: string; body?: unknown }> = [];
			const client = {
				async nextAssignment() {
					events.push({ method: 'nextAssignment' });
					return await new Promise<never>(() => {});
				},
				async createAssignmentModeRun(_assignmentId: string, body: unknown) {
					events.push({ method: 'createAssignmentModeRun', body });
					return { ok: true, payload: null };
				},
				async completeAssignment(_assignmentId: string, body: unknown) {
					events.push({ method: 'completeAssignment', body });
					return { ok: true, payload: null };
				},
				async failAssignment(_assignmentId: string, body: unknown) {
					events.push({ method: 'failAssignment', body });
					return { ok: true, payload: null };
				},
			};

			const result = await runProviderRunnerOnce({
				config,
				client,
				runnerId: 'runner_timeout',
			});

			expect(result).toMatchObject({
				ok: false,
				assigned: 0,
				error: {
					code: 'provider_assignment_lease_request_failed',
				},
			});
			expect(events.map((event) => event.method)).toEqual(['nextAssignment']);
		} finally {
			if (previous === undefined) {
				delete process.env.TREESEED_PROVIDER_LEASE_REQUEST_TIMEOUT_MS;
			} else {
				process.env.TREESEED_PROVIDER_LEASE_REQUEST_TIMEOUT_MS = previous;
			}
		}
	});

	it('passes redacted TreeDX proxy tool descriptors to execution providers', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
				client: {
				async portfolio() { return portfolio(sourceRepo); },
				async createWorkday(body: unknown) { return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } }; },
				async writeReport() { return { ok: true, report: { id: 'report_1' } }; },
			},
		});
		const events: Array<{ method: string; body?: unknown }> = [];
		const treedxProxyHandle = {
			id: 'tdx-handle-1',
			projectId: 'project_123',
			assignmentId: 'assignment_treedx_tools',
			repositoryId: 'repo-1',
			workspaceId: 'workspace-1',
			token: 'secret_should_not_leak',
			allowedOperations: ['files:read', 'files:search', 'files:write', 'git:commit'],
			allowedPaths: ['src/content/**'],
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const client = {
			async nextAssignment() {
				return {
					ok: true,
					leaseToken: 'lease_treedx',
					payload: {
						id: 'assignment_treedx_tools',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						treedxProxyHandle,
						capabilityHandles: {
							workspaceAccessMode: 'brokered_workspace',
						},
						decisionInput: {
							input: {
								dryRun: true,
								projectId: 'project_123',
								agentSlug: 'provider-planner',
								useExecutionProvider: true,
							},
						},
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
				return { ok: true, payload: { id: 'assignment_treedx_tools', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_treedx_tools', status: 'failed' } };
			},
		};
		const adapter = new FakeAsyncExecutionProviderAdapter();

			const result = await runProviderRunnerOnce({ config, client, executionAdapter: adapter, runnerId: 'runner_treedx', treeDx: fakeTreeDxOptions(sourceRepo) });

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_treedx_tools' });
		expect(adapter.lastStartInput?.tools?.[0]).toMatchObject({
			kind: 'agent_tool',
			executionTarget: 'treedx_proxy',
			projectId: 'project_123',
			assignmentId: 'assignment_treedx_tools',
			handleId: 'tdx-handle-1',
			repositoryId: 'repo-1',
			workspaceId: 'workspace-1',
			allowedOperations: ['files:read', 'files:search', 'files:write', 'git:commit'],
			allowedPaths: ['src/content/**'],
		});
		expect(JSON.stringify(adapter.lastStartInput?.tools)).not.toContain('secret_should_not_leak');
		expect(JSON.stringify(events)).not.toContain('secret_should_not_leak');
	});

	it('maps retryable blocked async provider snapshots to returned handler output', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
			await processProviderPortfolio({
				config,
				treeDx: fakeTreeDxOptions(sourceRepo),
				client: {
				async portfolio() { return portfolio(sourceRepo); },
				async createWorkday(body: unknown) { return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } }; },
				async writeReport() { return { ok: true, report: { id: 'report_1' } }; },
			},
		});
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async nextAssignment() {
				return {
					ok: true,
					leaseToken: 'lease_blocked',
					payload: {
						id: 'assignment_blocked',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner', useExecutionProvider: true } },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async renewAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'renewAssignment', body });
				return { ok: true, payload: null };
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'assignment_blocked', status: 'completed' } };
			},
			async returnAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'returnAssignment', body });
				return { ok: true, payload: { id: 'assignment_blocked', status: 'returned' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_blocked', status: 'failed' } };
			},
		};

			const result = await runProviderRunnerOnce({
				config,
				client,
				executionAdapter: new FakeAsyncExecutionProviderAdapter('blocked'),
				runnerId: 'runner_blocked',
				treeDx: fakeTreeDxOptions(sourceRepo),
			});

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_blocked' });
		expect(events.some((event) => event.method === 'returnAssignment')).toBe(true);
		expect(events.some((event) => event.method === 'failAssignment')).toBe(false);
		expect(events.find((event) => event.method === 'returnAssignment')?.body).toMatchObject({
			retryable: true,
			output: {
				status: 'waiting',
				summary: 'Fake async provider is blocked.',
				metadata: {
					executionStatus: 'blocked',
					externalRef: 'ISSUE-1',
				},
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).metadata?.source === 'execution_provider_adapter_lifecycle',
		)?.body).toMatchObject({
			fallbackReason: 'Fake async provider is blocked.',
			outputs: {
				externalRef: 'ISSUE-1',
			},
			metadata: {
				source: 'execution_provider_adapter_lifecycle',
				executionStatus: 'blocked',
			},
		});
	});

	it('maps terminal async provider failure to failed assignment', async () => {
		const sourceRepo = createProjectRepository();
		const config = resolveProviderConfig({ env: env() });
		await processProviderPortfolio({
			config,
			treeDx: fakeTreeDxOptions(sourceRepo),
			client: {
				async portfolio() { return portfolio(sourceRepo); },
				async createWorkday(body: unknown) { return { ok: true, workDay: { id: 'wd_provider_1', ...(body as Record<string, unknown>) } }; },
				async writeReport() { return { ok: true, report: { id: 'report_1' } }; },
			},
		});
		const events: Array<{ method: string; body?: unknown }> = [];
		const client = {
			async nextAssignment() {
				return {
					ok: true,
					leaseToken: 'lease_failed',
					payload: {
						id: 'assignment_failed',
						projectId: 'project_123',
						agentId: 'provider-planner',
						mode: 'planning',
						decisionInput: { input: { dryRun: true, projectId: 'project_123', agentSlug: 'provider-planner', useExecutionProvider: true } },
						capacityEnvelope: { projectId: 'project_123', mode: 'planning' },
					},
				};
			},
			async renewAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'renewAssignment', body });
				return { ok: true, payload: null };
			},
			async createAssignmentModeRun(_assignmentId: string, body: unknown) {
				events.push({ method: 'createAssignmentModeRun', body });
				return { ok: true, payload: { id: `mode_run_${events.length}` } };
			},
			async completeAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'completeAssignment', body });
				return { ok: true, payload: { id: 'assignment_failed', status: 'completed' } };
			},
			async failAssignment(_assignmentId: string, body: unknown) {
				events.push({ method: 'failAssignment', body });
				return { ok: true, payload: { id: 'assignment_failed', status: 'failed' } };
			},
		};

			const result = await runProviderRunnerOnce({
				config,
				client,
				executionAdapter: new FakeAsyncExecutionProviderAdapter('failed'),
				runnerId: 'runner_failed',
				treeDx: fakeTreeDxOptions(sourceRepo),
			});

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_failed' });
		expect(events.some((event) => event.method === 'completeAssignment')).toBe(false);
		expect(events.some((event) => event.method === 'failAssignment')).toBe(true);
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			output: {
				status: 'failed',
				summary: 'Fake async provider failed terminally.',
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).metadata?.source === 'execution_provider_adapter_lifecycle',
		)?.body).toMatchObject({
			status: 'failed',
			outputs: {
				externalRef: 'ISSUE-1',
				code: 'external_issue_deleted',
			},
			metadata: {
				source: 'execution_provider_adapter_lifecycle',
				executionStatus: 'failed',
			},
		});
	});

	it('maps cancelled async provider snapshots to failed assignment lifecycle without completing work', async () => {
		const { events, result } = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('cancelled'),
			assignmentId: 'assignment_cancelled',
			runnerId: 'runner_cancelled',
		});

		expect(result).toMatchObject({ ok: true, assigned: 1, assignmentId: 'assignment_cancelled' });
		expect(events.some((event) => event.method === 'completeAssignment')).toBe(false);
		expect(events.some((event) => event.method === 'failAssignment')).toBe(true);
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			output: {
				status: 'failed',
				metadata: {
					executionStatus: 'cancelled',
					externalRef: 'ISSUE-1',
				},
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).metadata?.source === 'execution_provider_adapter_lifecycle',
		)?.body).toMatchObject({
			status: 'cancelled',
			outputs: {
				status: 'cancelled',
				code: 'human_provider_cancelled',
			},
		});
	});

	it('fails assignment when async polling throws', async () => {
		const { events } = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('poll_failed'),
			assignmentId: 'assignment_poll_failed',
			runnerId: 'runner_poll_failed',
		});

		expect(events.some((event) => event.method === 'completeAssignment')).toBe(false);
		expect(events.some((event) => event.method === 'failAssignment')).toBe(true);
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			output: {
				status: 'failed',
				summary: 'Execution provider polling failed.',
				metadata: {
					executionStatus: 'failed',
					externalRef: 'ISSUE-1',
				},
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).outputs?.code === 'execution_provider_poll_failed',
		)?.body).toMatchObject({
			status: 'failed',
			outputs: {
				externalRef: 'ISSUE-1',
				code: 'execution_provider_poll_failed',
			},
		});
	});

	it('returns assignment when async polling reaches max polls without terminal completion', async () => {
		const { events } = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('never_completed'),
			assignmentId: 'assignment_poll_incomplete',
			runnerId: 'runner_poll_incomplete',
			executionLifecycle: {
				pollIntervalMs: 0,
				maxPolls: 1,
			},
		});

		expect(events.some((event) => event.method === 'returnAssignment')).toBe(true);
		expect(events.some((event) => event.method === 'completeAssignment')).toBe(false);
		expect(events.find((event) => event.method === 'returnAssignment')?.body).toMatchObject({
			retryable: true,
			output: {
				status: 'waiting',
				metadata: {
					executionStatus: 'waiting',
					externalRef: 'ISSUE-1',
				},
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).outputs?.code === 'execution_provider_poll_incomplete',
		)?.body).toMatchObject({
			outputs: {
				status: 'waiting',
				code: 'execution_provider_poll_incomplete',
			},
		});
	});

	it('fails assignment when lease renewal fails during async polling', async () => {
		const { events } = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('completed'),
			assignmentId: 'assignment_lease_failed',
			runnerId: 'runner_lease_failed',
			renewFailsAfter: 1,
		});

		expect(events.some((event) => event.method === 'failAssignment')).toBe(true);
		expect(events.some((event) => event.method === 'completeAssignment')).toBe(false);
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			output: {
				status: 'failed',
				summary: 'Assignment lease renewal failed after execution provider work was accepted.',
			},
		});
		expect(events.find((event) =>
			event.method === 'createAssignmentModeRun'
			&& (event.body as Record<string, any>).outputs?.code === 'assignment_lease_renewal_failed',
		)?.body).toMatchObject({
			outputs: {
				code: 'assignment_lease_renewal_failed',
				externalRef: 'ISSUE-1',
			},
		});
	});

	it('maps prepare rejection to returned or failed snapshots', async () => {
		const retryable = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('completed', { prepareRejected: true, prepareRetryable: true }),
			assignmentId: 'assignment_prepare_retryable',
			runnerId: 'runner_prepare_retryable',
		});
		expect(retryable.events.some((event) => event.method === 'returnAssignment')).toBe(true);
		expect(retryable.events.find((event) => event.method === 'returnAssignment')?.body).toMatchObject({
			retryable: true,
			code: 'assignment_waiting_for_external_completion',
			output: {
				metadata: {
					code: 'fake_prepare_rejected',
				},
			},
		});

		const terminal = await runAsyncExecutionProviderScenario({
			adapter: new FakeAsyncExecutionProviderAdapter('completed', { prepareRejected: true, prepareRetryable: false }),
			assignmentId: 'assignment_prepare_terminal',
			runnerId: 'runner_prepare_terminal',
		});
		expect(terminal.events.some((event) => event.method === 'failAssignment')).toBe(true);
		expect(terminal.events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			retryable: false,
			code: 'provider_assignment_failed',
			output: {
				metadata: {
					code: 'fake_prepare_rejected',
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
			expect(events.map((event) => event.method)).toEqual(expect.arrayContaining(['createAssignmentModeRun', 'failAssignment']));
			expect(events.at(-1)?.method).toBe('failAssignment');
			expect(events.find((event) => {
				const body = event.body as Record<string, unknown> | undefined;
				return event.method === 'createAssignmentModeRun' && body?.fallbackReason === 'provider_project_not_synced';
			})?.body).toMatchObject({
				mode: 'planning',
				status: 'failed',
				fallbackReason: 'provider_project_not_synced',
			metadata: expect.objectContaining({
				source: 'provider_runner_early_exit',
				projectId: 'project_123',
				agentSlug: 'provider-planner',
			}),
		});
		expect(events.find((event) => event.method === 'failAssignment')?.body).toMatchObject({
			code: 'provider_project_not_synced',
		});
	});
});
