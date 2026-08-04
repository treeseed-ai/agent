import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { dirname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveAgentRuntimeProviders } from '../../../../../src/agent-runtime.ts';

import {
	checkCodexProviderReadiness,
	resolveCodexProviderConfig,
} from '../../../../../src/agents/adapters/codex/codex-readiness.ts';

import {
	codexClientEnvironment,
	materializeCodexAuthFromEnv,
	resolveCodexAuthFile,
} from '../../../../../src/agents/adapters/accounts/codex-auth.ts';

import {
	CodexExecutionProviderAdapter,
	buildCodexPrompt,
	codexExecutionTimeoutMs,
	missingCodexCompletionReceipts,
	runCodexTask,
	type CodexExecutionRequest,
} from '../../../../../src/agents/adapters/codex/execution-codex.ts';

import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';

import type { ExecutionProviderInvocation } from '../../../../../src/agents/runtime/runtime-types.ts';

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
it('requires TreeDX path discovery before Knowledge Hub batch reads', () => {
	const prompt = buildCodexPrompt({ ...baseRequest, tools: [{
		kind: 'agent_tool', id: 'treedx.read_repository_files', name: 'Read repository files',
		description: 'Read exact TreeDX paths.', inputSchema: {}, outputSchema: {},
		executionTarget: 'provider_runner', mutability: 'read',
	}] });
	expect(prompt).toContain('Do not infer or guess Knowledge Hub file paths.');
	expect(prompt).toContain('Batch file reads fail when any requested path is absent');
	expect(prompt).toContain('Never inspect src/content or docs/src/content with shell commands');
});

it('prepares an exact-ref worktree even when the agent sandbox is read-only', async () => {
		const readOnlyAgent = {
			...agent,
			execution: { ...agent.execution, sandboxMode: 'read_only' as const, allowedPaths: [] },
		};
		let prepared = false;
		const adapter = new CodexExecutionProviderAdapter({
			repoRoot: '/repo',
			prepareWorktree: async () => {
				prepared = true;
				return {
					branchName: 'agent/researcher/read-only-ref',
					worktreeRoot: '/repo/.agent-worktrees/researcher/read-only-ref',
					exactBaseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					created: true,
				};
			},
			env: { TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro', TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890' },
		});
		await expect(adapter.start(executionInvocation({
			agent: readOnlyAgent,
			runId: 'read-only-ref',
			instructions: 'Read only from the governed ref.',
			metadata: { exactBaseRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
		}))).rejects.toMatchObject({ code: 'worktree_base_ref_mismatch' });
		expect(prepared).toBe(true);
	});

it('keeps TreeDX source authority separate from the local execution worktree ref', async () => {
	const prepareWorktree = vi.fn(async (input: { exactBaseRef?: string }) => ({ branchName: 'agent/guide/acting', worktreeRoot: '/repo/.agent-worktrees/guide/acting', exactBaseRef: 'local-commit', created: true }));
	const run = vi.fn(async () => ({ finalResponse: 'Completed through TreeDX.', items: [], usage: { input_tokens: 2, output_tokens: 1 } }));
	const adapter = new CodexExecutionProviderAdapter({ repoRoot: '/repo', prepareWorktree: prepareWorktree as never,
		createCodexClient: async () => ({ startThread: () => ({ id: 'thread', run }), resumeThread: () => ({ id: 'thread', run }) }),
		env: { TREESEED_CODEX_SUBSCRIPTION_PLAN: 'pro', TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890' } });
	const result = await adapter.start(executionInvocation({ agent, runId: 'treedx-ref', instructions: 'Use TreeDX.', metadata: { exactBaseRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', contentAuthority: 'treedx' } }));
	expect(prepareWorktree).toHaveBeenCalledWith(expect.objectContaining({ exactBaseRef: undefined }));
	expect(result.metadata).toMatchObject({ baseRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
});

it('keeps provider code free of direct command invocation APIs', async () => {
		const files = [
			resolve(testDir, '../../../../../src/agents/adapters/codex/codex-readiness.ts'),
			resolve(testDir, '../../../../../src/agents/adapters/accounts/codex-auth.ts'),
			resolve(testDir, '../../../../../src/agents/adapters/codex/execution-codex.ts'),
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
