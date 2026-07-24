import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { dirname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveAgentRuntimeProviders } from '../../../src/agent-runtime.ts';

import {
	checkCodexProviderReadiness,
	resolveCodexProviderConfig,
} from '../../../src/agents/adapters/codex-readiness.ts';

import {
	codexClientEnvironment,
	materializeCodexAuthFromEnv,
	resolveCodexAuthFile,
} from '../../../src/agents/adapters/codex-auth.ts';

import {
	CodexExecutionProviderAdapter,
	buildCodexPrompt,
	codexExecutionTimeoutMs,
	missingCodexCompletionReceipts,
	runCodexTask,
	type CodexExecutionRequest,
} from '../../../src/agents/adapters/execution-codex.ts';

import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';

import type { ExecutionProviderInvocation } from '../../../src/agents/runtime-types.ts';

const baseRequest: CodexExecutionRequest = {
	taskId: 'task:codex-provider-skeleton',
	agentSlug: 'engineer',
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
	slug: 'engineer',
	handler: 'actor',
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
	tools: { allowed: [] },
};

function executionInvocation(input: {
	agent: AgentRuntimeSpec;
	runId: string;
	instructions: string;
	tools?: ExecutionProviderInvocation['tools'];
	metadata?: Record<string, unknown>;
	workPackageMetadata?: Record<string, unknown>;
}): ExecutionProviderInvocation {
	return {
		assignment: {
			id: input.runId,
			teamId: 'team-test',
			projectId: 'project-test',
			capacityProviderId: 'capacity-provider-test',
			projectAgentClassId: 'agent-class-test',
			mode: 'acting',
			status: 'leased',
			leaseState: 'leased',
			agentId: input.agent.slug,
			handlerId: input.agent.handler,
			capacityEnvelope: {} as AgentCapacityEnvelope,
			decisionInput: {} as DecisionExecutionInput,
		} as ProviderAssignment,
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: {} as DecisionExecutionInput,
		agent: input.agent,
		workPackage: {
			kind: 'implementation',
			title: 'Codex provider test',
			summary: 'Provider contract test.',
			instructions: input.instructions,
			context: {},
			expectedOutputs: [{ type: 'final_response', required: true }],
			constraints: {
				mode: 'acting',
				requiredCapabilities: ['repo_read'],
				allowedPaths: input.agent.execution.allowedPaths,
				forbiddenPaths: input.agent.execution.forbiddenPaths,
			},
			metadata: input.workPackageMetadata ?? {},
		},
		leaseToken: null,
		runnerId: 'test-runner',
		tools: input.tools,
		metadata: { runId: input.runId, ...(input.metadata ?? {}) },
	};
}
describe('codex execution provider', () => {
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

it('warns when local Codex config uses unsupported default service tier', () => {
		const readiness = checkCodexProviderReadiness({
			env: {
				TREESEED_EXECUTION_PROVIDER: 'codex',
				HOME: '/home/test',
			},
			nodeVersion: 'v24.0.0',
			resolvePackage: () => '/repo/node_modules/@openai/codex-sdk/dist/index.js',
			fileExists: (path) => path === '/home/test/.codex/auth.json' || path === '/home/test/.codex/config.toml',
			readFile: () => 'service_tier = "default"\n',
		});

		expect(readiness.ok).toBe(true);
		expect(readiness.warnings).toEqual(expect.arrayContaining([
			expect.stringContaining('service_tier=default'),
		]));
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

it('selects the canonical codex provider', () => {
		const readiness = checkCodexProviderReadiness({
			env: {
				TREESEED_EXECUTION_PROVIDER: 'codex',
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
			subscriptionPlan: 'business',
			approvalPolicy: 'on_request',
			sandboxMode: 'workspace_write',
			timeoutMs: 1200,
		});
	});

it('registers codex as the execution provider', () => {
		const runtime = resolveAgentRuntimeProviders('/repo', {
			execution: 'codex',
			mutation: 'local_branch',
			repository: 'git',
			verification: 'local',
			notification: 'sdk_message',
			research: 'project_graph',
		});

		expect(runtime.execution).toBeInstanceOf(CodexExecutionProviderAdapter);
	});

it('returns waiting for workspace-write requests missing worktree or allowed paths', async () => {
		const createCodexClient = vi.fn();

		const missingWorktree = await runCodexTask({
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

		const missingAllowedPaths = await runCodexTask({
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

it('rejects a prepared worktree that cannot prove the governed exact base ref', async () => {
		const adapter = new CodexExecutionProviderAdapter({
			repoRoot: '/repo',
			prepareWorktree: async () => ({
				branchName: 'agent/engineer/run-ref-mismatch',
				worktreeRoot: '/repo/.agent-worktrees/engineer/run-ref-mismatch',
				exactBaseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				created: true,
			}),
			env: { TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro', TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890' },
		});
		await expect(adapter.start(executionInvocation({
			agent, runId: 'run-ref-mismatch', instructions: 'Implement only from the governed ref.',
			metadata: { exactBaseRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
		}))).rejects.toMatchObject({ code: 'worktree_base_ref_mismatch', retryable: false });
	});
});
