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
it('resumes the same thread once to obtain missing completion receipts', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'treeseed-codex-receipt-'));
		const telemetryPath = resolve(root, 'events.jsonl');
		const run = vi.fn()
			.mockResolvedValueOnce({ finalResponse: 'Finished too early.', items: [], usage: { input_tokens: 4, output_tokens: 2 } })
			.mockImplementationOnce(async () => {
				await appendFile(telemetryPath, `${JSON.stringify({
					status: 'completed',
					derivedEvents: [
						{ type: 'verification_completed', status: 'passed' },
						{ type: 'source_checkpoint_committed', commitSha: 'abc123' },
						{ type: 'content_created', contentRef: { model: 'note', path: 'notes/implementation.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } },
					],
				})}\n`);
				return { finalResponse: 'Receipts complete.', items: [], usage: { input_tokens: 3, output_tokens: 1 } };
			});
		const startThread = vi.fn(() => ({ id: 'thread-receipts', run }));
		const resumeThread = vi.fn(() => ({ id: 'thread-receipts', run }));
		const cleanup = vi.fn(async () => undefined);
		const createCodexClient = vi.fn(async () => ({ startThread, resumeThread, cleanup }));
		const adapter = new CodexExecutionProviderAdapter({
			repoRoot: '/repo',
			prepareWorktree: async () => ({
				branchName: 'agent/tester/run-receipts',
				worktreeRoot: '/repo/.agent-worktrees/tester/run-receipts',
				exactBaseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				created: true,
			}),
			createCodexClient,
			env: { TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro', TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890' },
		});
		try {
			const result = await adapter.start(executionInvocation({
				agent,
				runId: 'run-receipts',
				instructions: 'Add the governed test.',
				workPackageMetadata: { artifactKind: 'implementation_change', requireContentArtifact: true },
				tools: [
					{
						kind: 'agent_tool', id: 'treeseed.verify', name: 'Verify', description: 'Verify',
						inputSchema: {}, outputSchema: {}, executionTarget: 'provider_runner', mutability: 'read',
					},
					{
						kind: 'agent_tool', id: 'treeseed.checkpoint', name: 'Checkpoint', description: 'Checkpoint',
						inputSchema: {}, outputSchema: {}, executionTarget: 'provider_runner', mutability: 'worktree_write',
					},
				],
				metadata: {
					exactBaseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					toolTelemetryPath: telemetryPath,
				},
			}));
			expect(startThread).toHaveBeenCalledTimes(1);
			expect(resumeThread).toHaveBeenCalledWith('thread-receipts', expect.any(Object));
			expect(createCodexClient).toHaveBeenCalledTimes(1);
			expect(run).toHaveBeenCalledTimes(2);
			expect(String(run.mock.calls[1]?.[0])).toContain('Missing required tool receipts');
			expect(String(run.mock.calls[1]?.[0])).toContain('content_artifact_kind:implementation_change');
			expect(result).toMatchObject({
				status: 'completed',
				summary: 'Receipts complete.',
				metadata: {
					codex: {
						usage: { inputTokens: 7, outputTokens: 3 },
					},
				},
			});
			expect(cleanup).toHaveBeenCalledTimes(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

it('caps activity runtime at the provider maximum while honoring shorter profiles', () => {
		expect(codexExecutionTimeoutMs(900_000, 1_800)).toBe(900_000);
		expect(codexExecutionTimeoutMs(900_000, 60)).toBe(60_000);
		expect(codexExecutionTimeoutMs(900_000, undefined)).toBe(900_000);
	});

it('keeps both capacity-provider services on the canonical Codex timeout default', async () => {
		const compose = await readFile(resolve(testDir, '../../../compose.capacity-provider.yml'), 'utf8');
		expect(compose.match(/TREESEED_CODEX_TIMEOUT_MS: \$\{TREESEED_CODEX_TIMEOUT_MS:-900000\}/gu)).toHaveLength(2);
	});

it('reports unavailable instead of advertising capacity when authentication is absent', async () => {
		const adapter = new CodexExecutionProviderAdapter({
			env: { TREESEED_CODEX_AUTH_FILE: '/missing/codex-auth.json' },
		});

		await expect(adapter.observe({} as never)).resolves.toMatchObject({
			available: false,
			pressure: 'exhausted',
			metadata: { authMode: 'missing' },
		});
	});

it('reports missing SDK as a warning for non-Codex selections and blocker for Codex defaults', () => {
		const missing = () => {
			throw new Error('missing');
		};

		const optional = checkCodexProviderReadiness({
			env: {
				TREESEED_AGENT_EXECUTION_PROVIDER: 'jira',
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
});
