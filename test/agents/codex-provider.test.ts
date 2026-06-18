import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolveAgentRuntimeProviders } from '../../src/agent-runtime.ts';
import {
	checkCodexProviderReadiness,
	resolveCodexProviderConfig,
} from '../../src/agents/adapters/codex-readiness.ts';
import {
	codexClientEnvironment,
	materializeCodexAuthFromEnv,
	resolveCodexAuthFile,
} from '../../src/agents/adapters/codex-auth.ts';
import {
	CodexSubscriptionExecutionAdapter,
	runCodexSubscriptionTask,
	type CodexExecutionRequest,
} from '../../src/agents/adapters/execution-codex.ts';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

const baseRequest: CodexExecutionRequest = {
	taskId: 'task:codex-provider-skeleton',
	agentSlug: 'engineer-agent',
	repoRoot: '/repo',
	prompt: 'Inspect the provider boundary.',
	allowedPaths: [],
	forbiddenPaths: [],
	sandboxMode: 'read_only',
	approvalPolicy: 'never',
	metadata: {
		subscriptionPlan: 'pro',
	},
};
const testDir = dirname(fileURLToPath(import.meta.url));

const agent: AgentRuntimeSpec = {
	slug: 'engineer-agent',
	handler: 'engineer',
	enabled: true,
	systemPrompt: '',
	persona: '',
	cli: {},
	triggers: [],
	permissions: [],
	execution: {
		provider: 'codex',
		model: 'gpt-5.5',
		approvalPolicy: 'never',
		sandboxMode: 'workspace_write',
		reasoningEffort: 'medium',
		allowedPaths: ['docs/**'],
		forbiddenPaths: ['.git/**'],
		worktree: { enabled: true },
		maxConcurrency: 1,
		timeoutSeconds: 60,
		cooldownSeconds: 0,
		leaseSeconds: 60,
		retryLimit: 1,
		branchPrefix: 'agent/',
	},
	outputs: {
		messageTypes: [],
		modelMutations: [],
	},
};

describe('codex subscription provider skeleton', () => {
	it('reports missing SDK as a warning for non-Codex selections and blocker for Codex defaults', () => {
		const missing = () => {
			throw new Error('missing');
		};

		const optional = checkCodexProviderReadiness({
			env: {
				TREESEED_AGENT_EXECUTION_PROVIDER: 'stub',
			},
			nodeVersion: 'v24.0.0',
			resolvePackage: missing,
		});
		expect(optional).toMatchObject({
			ok: true,
			providerSelected: false,
			sdkInstalled: false,
			blockingIssues: [],
		});
		expect(optional.warnings).toEqual(expect.arrayContaining([
			expect.stringContaining('@openai/codex-sdk is not installed'),
		]));

		const selected = checkCodexProviderReadiness({
			env: {},
			nodeVersion: 'v24.0.0',
			resolvePackage: missing,
		});
		expect(selected).toMatchObject({
			ok: false,
			providerSelected: true,
			sdkInstalled: false,
		});
		expect(selected.blockingIssues).toEqual(expect.arrayContaining([
			expect.stringContaining('@openai/codex-sdk is required'),
		]));
	});

	it('reports installed SDK, selected profile, and auth hint', () => {
		const readiness = checkCodexProviderReadiness({
			env: {
				TREESEED_EXECUTION_PROVIDER: 'codex',
				TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro',
				HOME: '/home/test',
			},
			nodeVersion: 'v24.0.0',
			resolvePackage: () => '/repo/node_modules/@openai/codex-sdk/dist/index.js',
			fileExists: (path) => path === '/home/test/.codex/auth.json',
		});

		expect(readiness).toMatchObject({
			ok: true,
			providerSelected: true,
			sdkInstalled: true,
			nodeVersionOk: true,
			authDetected: true,
			authMode: 'codex_auth_json',
			authPath: '/home/test/.codex/auth.json',
			subscriptionPlan: 'pro',
			defaultModel: 'gpt-5.5',
			warnings: [],
			blockingIssues: [],
		});
	});

	it('uses TREESEED_CODEX_API_KEY as an API-billed fallback when auth.json is absent', () => {
		const readiness = checkCodexProviderReadiness({
			env: {
				TREESEED_EXECUTION_PROVIDER: 'codex',
				TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890',
				HOME: '/home/test',
			},
			nodeVersion: 'v24.0.0',
			resolvePackage: () => '/repo/node_modules/@openai/codex-sdk/dist/index.js',
			fileExists: () => false,
		});

		expect(readiness).toMatchObject({
			ok: true,
			authDetected: true,
			authMode: 'api_key',
			authPath: '/home/test/.codex/auth.json',
		});
	});

	it('resolves parity auth under /data/codex and materializes auth JSON secrets once', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-codex-auth-'));
		const authJson = JSON.stringify({ OPENAI_CODEX_LOGIN: 'test-login', refresh_token: 'test-refresh' });
		const env = {
			TREESEED_PROCESSING_PARITY: '1',
			TREESEED_DATA_DIR: root,
			TREESEED_CODEX_AUTH_JSON_B64: Buffer.from(authJson).toString('base64'),
		} as NodeJS.ProcessEnv;
		try {
			expect(resolveCodexAuthFile(env)).toBe(resolve(root, 'codex/auth.json'));
			const first = await materializeCodexAuthFromEnv(env);
			expect(first).toMatchObject({ materialized: true, reason: 'created' });
			expect(env.TREESEED_CODEX_AUTH_FILE).toBe(resolve(root, 'codex/auth.json'));
			expect(env.CODEX_HOME).toBe(resolve(root, 'codex'));
			expect(await readFile(resolve(root, 'codex/auth.json'), 'utf8')).toContain('test-refresh');

			const second = await materializeCodexAuthFromEnv({
				...env,
				TREESEED_CODEX_AUTH_JSON_B64: Buffer.from(JSON.stringify({ refresh_token: 'stale-copy' })).toString('base64'),
			} as NodeJS.ProcessEnv);
			expect(second).toMatchObject({ materialized: false, reason: 'exists' });
			expect(await readFile(resolve(root, 'codex/auth.json'), 'utf8')).toContain('test-refresh');
			expect(codexClientEnvironment(env)).toMatchObject({
				CODEX_HOME: resolve(root, 'codex'),
				TREESEED_CODEX_AUTH_FILE: resolve(root, 'codex/auth.json'),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('keeps the legacy codex_subscription selection working', () => {
		const readiness = checkCodexProviderReadiness({
			env: {
				TREESEED_EXECUTION_PROVIDER: 'codex_subscription',
				HOME: '/home/test',
			},
			nodeVersion: 'v24.0.0',
			resolvePackage: () => '/repo/node_modules/@openai/codex-sdk/dist/index.js',
			fileExists: (path) => path === '/home/test/.codex/auth.json',
		});

		expect(readiness).toMatchObject({
			ok: true,
			providerSelected: true,
			authMode: 'codex_auth_json',
		});
	});

	it('normalizes provider configuration from environment values', () => {
		const config = resolveCodexProviderConfig({
			TREESEED_CODEX_SUBSCRIPTION_PLAN: 'business',
			TREESEED_CODEX_APPROVAL_POLICY: 'on-request',
			TREESEED_CODEX_SANDBOX_MODE: 'workspace-write',
			TREESEED_CODEX_TIMEOUT_MS: '1200',
		});

		expect(config).toMatchObject({
			providerId: 'codex',
			legacyProviderIds: ['codex_subscription'],
			subscriptionPlan: 'business',
			approvalPolicy: 'on_request',
			sandboxMode: 'workspace_write',
			timeoutMs: 1200,
		});
	});

	it('registers codex and the legacy codex_subscription alias as execution providers', () => {
		const runtime = resolveAgentRuntimeProviders('/repo', {
			execution: 'codex',
			mutation: 'local_branch',
			repository: 'stub',
			verification: 'stub',
			notification: 'stub',
			research: 'stub',
		});

		expect(runtime.execution).toBeInstanceOf(CodexSubscriptionExecutionAdapter);
		expect(resolveAgentRuntimeProviders('/repo', {
			execution: 'codex_subscription',
			mutation: 'local_branch',
			repository: 'stub',
			verification: 'stub',
			notification: 'stub',
			research: 'stub',
		}).execution).toBeInstanceOf(CodexSubscriptionExecutionAdapter);
	});

	it('returns waiting for workspace-write requests missing worktree or allowed paths', async () => {
		const createCodexClient = vi.fn();

		const missingWorktree = await runCodexSubscriptionTask({
			...baseRequest,
			sandboxMode: 'workspace_write',
			allowedPaths: ['src/content/knowledge/**'],
		}, { createCodexClient });
		expect(missingWorktree).toMatchObject({
			status: 'waiting',
			error: {
				code: 'worktree_required',
			},
		});

		const missingAllowedPaths = await runCodexSubscriptionTask({
			...baseRequest,
			sandboxMode: 'workspace_write',
			worktreeRoot: '/repo/.agent-worktrees/task',
			allowedPaths: [],
		}, { createCodexClient });
		expect(missingAllowedPaths).toMatchObject({
			status: 'waiting',
			error: {
				code: 'allowed_paths_required',
			},
		});

		expect(createCodexClient).not.toHaveBeenCalled();
	});

	it('constructs a mocked SDK client and runs a thread through the boundary', async () => {
		const run = vi.fn(async () => ({
			items: [],
			finalResponse: 'Codex completed the planning task.',
			usage: null,
		}));
		const createCodexClient = vi.fn(() => ({
			startThread: vi.fn(() => ({ id: 'thread-1', run })),
			resumeThread: vi.fn(),
		}));

		const result = await runCodexSubscriptionTask(baseRequest, {
			createCodexClient,
			now: () => 1000,
		});

		expect(createCodexClient).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			provider: 'codex',
			threadId: 'thread-1',
			status: 'completed',
			finalResponse: 'Codex completed the planning task.',
			changedPaths: [],
		});
	});

	it('exposes a runtime adapter result with the normalized Codex envelope', async () => {
		const run = vi.fn(async () => ({
			items: [],
			finalResponse: 'Runtime adapter completed.',
			usage: null,
		}));
		const adapter = new CodexSubscriptionExecutionAdapter({
			repoRoot: '/repo',
			createCodexClient: () => ({
				startThread: () => ({ id: 'thread-runtime', run }),
				resumeThread: vi.fn(),
			}),
			prepareWorktree: async () => ({
				branchName: 'agent/engineer-agent/run-1',
				worktreeRoot: '/repo/.agent-worktrees/engineer-agent/run-1',
				created: true,
			}),
			env: {
				TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro',
				TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890',
			},
		});

		const result = await adapter.runTask({
			agent,
			runId: 'run-1',
			prompt: 'Plan a docs task.',
		});

		expect(result).toMatchObject({
			status: 'completed',
			stdout: 'Runtime adapter completed.',
			metadata: {
				codex: {
					provider: 'codex',
					status: 'completed',
					threadId: 'thread-runtime',
				},
			},
		});
	});

	it('keeps provider code free of direct command invocation APIs', async () => {
		const files = [
			resolve(testDir, '../../src/agents/adapters/codex-readiness.ts'),
			resolve(testDir, '../../src/agents/adapters/codex-auth.ts'),
			resolve(testDir, '../../src/agents/adapters/execution-codex.ts'),
		];
		const disallowed = [
			/node:child_process/,
			/child_process/,
			/\bspawn\s*\(/,
			/\bexec\s*\(/,
			/\bexeca\s*\(/,
			/codex\s+exec/,
			/npx\s+codex/,
		];

		for (const file of files) {
			const source = await readFile(file, 'utf8');
			for (const pattern of disallowed) {
				expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
			}
		}
	});
});
