import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
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
	CodexExecutionProviderAdapter,
	buildCodexPrompt,
	codexExecutionTimeoutMs,
	missingCodexCompletionReceipts,
	runCodexTask,
	type CodexExecutionRequest,
} from '../../src/agents/adapters/execution-codex.ts';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

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
	it('makes verify and checkpoint receipts explicit completion gates', () => {
		const prompt = buildCodexPrompt({
			...baseRequest,
			sandboxMode: 'workspace_write',
			worktreeRoot: '/repo/.agent-worktrees/tester',
			tools: [
				{
					kind: 'agent_tool',
					id: 'treeseed.verify',
					name: 'Verify',
					description: 'Verify',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'read',
				},
				{
					kind: 'agent_tool',
					id: 'treeseed.checkpoint',
					name: 'Checkpoint',
					description: 'Checkpoint',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'worktree_write',
				},
				{
					kind: 'agent_tool',
					id: 'treeseed.review_decision',
					name: 'Review decision',
					description: 'Review decision',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'shared_state_write',
				},
			],
		});
		expect(prompt).toContain('successful verification_completed receipt');
		expect(prompt).toContain('successful source_checkpoint_committed receipt containing commitSha');
		expect(prompt).toContain('successful review_decision_recorded receipt');
		expect(prompt).toContain('final response is not completion');
	});

	it('identifies required completion receipts from granted tools and the assigned deliverable', () => {
		const tools = [
			{ id: 'treeseed.verify' },
			{ id: 'treeseed.checkpoint' },
			{ id: 'treeseed.status' },
		] as ExecutionProviderInvocation['tools'];
		expect(missingCodexCompletionReceipts(tools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'verification_completed' }],
		}], 'failing_test_proof')).toEqual(['source_checkpoint_committed']);
		expect(missingCodexCompletionReceipts(tools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'verification_completed' }],
		}], 'passing_verification')).toEqual([]);
		const researchTools = [{ id: 'research.fetch_source' }] as ExecutionProviderInvocation['tools'];
		expect(missingCodexCompletionReceipts([], [], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_fetch_tool_available']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_independent_publishers:2']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/b' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_independent_publishers:2']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://two.test/b' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual([]);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/dummy.mdx' } }],
		}], 'revision_verification')).toEqual(['content_subject_linked:notes/dummy.mdx']);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/dummy.mdx' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'content_updated', contentRef: { model: 'note', path: 'notes/dummy.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'revision_verification')).toEqual([]);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'question', path: 'questions/context.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'implementation_change', null, 2, true)).toEqual(['content_artifact_kind:implementation_change']);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/implementation.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'implementation_change', null, 2, true)).toEqual([]);
	});

	it('instructs research assignments with the callable MCP name rather than only the policy id', () => {
		const prompt = buildCodexPrompt({
			...baseRequest,
			metadata: {
				workPackage: {
					metadata: { researchStage: 'independent-source-fetch' },
				},
			},
			tools: [{
				kind: 'agent_tool',
				id: 'research.fetch_source',
				name: 'Fetch governed research source',
				description: 'Fetch a governed source.',
				inputSchema: {},
				outputSchema: {},
				executionTarget: 'provider_runner',
				mutability: 'read',
			}],
		});
		expect(prompt).toContain('callName research_fetch_source');
		expect(prompt).toContain('Search for and invoke the callName, not the dotted policy id.');
	});

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
		const compose = await readFile(resolve(testDir, '../../compose.capacity-provider.yml'), 'utf8');
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
