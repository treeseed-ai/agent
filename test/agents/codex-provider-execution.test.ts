import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	buildCodexPrompt,
	codexTreeDxConfig,
	mapCodexThreadOptions,
	normalizeCodexRunResult,
	runCodexSubscriptionTask,
	type CodexExecutionRequest,
} from '../../src/agents/adapters/execution-codex.ts';

const request: CodexExecutionRequest = {
	taskId: 'task:codex-provider-execution',
	workDayId: 'workday-1',
	agentSlug: 'engineer-agent',
	repoRoot: '/repo',
	worktreeRoot: '/repo/.agent-worktrees/task-codex',
	prompt: 'Update the TreeSeed provider documentation.',
	allowedPaths: ['src/content/knowledge/**', 'docs/**'],
	forbiddenPaths: ['src/content/knowledge/private/**'],
	sandboxMode: 'workspace_write',
	approvalPolicy: 'never',
	model: 'gpt-5.5',
	reasoningEffort: 'high',
	timeoutMs: 60_000,
	metadata: {
		subscriptionPlan: 'pro',
		contextPackSummary: 'Runtime context pack summary.',
		workPackage: {
			id: 'task:codex-provider-execution',
			kind: 'implementation',
			operations: {
				handlerControlled: ['save', 'stage', 'merge_to_staging', 'close'],
			},
		},
	},
};

const treeDxTool = {
	kind: 'treedx_proxy' as const,
	id: 'treedx-proxy:handle-1',
	name: 'TreeDX assignment proxy',
	description: 'Assignment-scoped TreeDX content proxy.',
	operations: ['files:read', 'files:write', 'git:commit'],
	projectId: 'project-1',
	assignmentId: 'assignment-1',
	handleId: 'handle-1',
	repositoryId: 'repo-1',
	workspaceId: 'workspace-1',
	allowedOperations: ['files:read', 'files:write', 'git:commit'],
	allowedPaths: ['src/content/**'],
	routes: {
		buildContext: 'POST /v1/dx/projects/project-1/repos/repo-1/context/build',
		readRepositoryFiles: 'POST /v1/dx/projects/project-1/repos/repo-1/files/read',
		searchWorkspace: 'POST /v1/dx/projects/project-1/workspaces/workspace-1/search',
		readWorkspaceFile: 'GET /v1/dx/projects/project-1/workspaces/workspace-1/files?path=:path',
		writeWorkspaceFile: 'PUT /v1/dx/projects/project-1/workspaces/workspace-1/files?path=:path',
		commitWorkspace: 'POST /v1/dx/projects/project-1/workspaces/workspace-1/commit',
	},
	metadata: { token: 'secret_should_not_leak' },
};

function runResult() {
	return {
		finalResponse: 'Implemented docs provider execution.\n\nVerification: npm test',
		usage: {
			input_tokens: 10,
			cached_input_tokens: 0,
			output_tokens: 20,
			reasoning_output_tokens: 5,
		},
		items: [
			{
				id: 'cmd-1',
				type: 'command_execution',
				command: 'npm run test:unit',
				aggregated_output: 'ok',
				status: 'completed',
				exit_code: 0,
			},
			{
				id: 'cmd-2',
				type: 'command_execution',
				command: 'git status --short',
				aggregated_output: '',
				status: 'completed',
				exit_code: 0,
			},
			{
				id: 'patch-1',
				type: 'file_change',
				status: 'completed',
				changes: [
					{ path: './docs/provider.md', kind: 'update' },
					{ path: 'src/content/knowledge/developer/providers/codex.mdx', kind: 'add' },
				],
			},
		],
	};
}

describe('codex provider execution', () => {
	it('maps TreeSeed request options to Codex thread options', () => {
		expect(mapCodexThreadOptions(request)).toEqual({
			model: 'gpt-5.5',
			sandboxMode: 'workspace-write',
			workingDirectory: '/repo/.agent-worktrees/task-codex',
			skipGitRepoCheck: true,
			modelReasoningEffort: 'high',
			approvalPolicy: 'never',
		});
		expect(mapCodexThreadOptions({
			...request,
			sandboxMode: 'read_only',
			worktreeRoot: undefined,
			approvalPolicy: 'never',
		})).toMatchObject({
			sandboxMode: 'read-only',
			workingDirectory: '/repo',
			approvalPolicy: 'never',
		});
	});

	it('builds the strict TreeSeed prompt wrapper', () => {
		const prompt = buildCodexPrompt(request);

		expect(prompt).toContain('You are operating as a TreeSeed implementation agent.');
		expect(prompt).toContain('Goal:\nUpdate the TreeSeed provider documentation.');
		expect(prompt).toContain('Current permission stage:\napproved_worktree_mutation');
		expect(prompt).toContain('- src/content/knowledge/**');
		expect(prompt).toContain('- src/content/knowledge/private/**');
		expect(prompt).toContain('Assigned worktree root: /repo/.agent-worktrees/task-codex');
		expect(prompt).toContain('The handler controls save, stage, merge_to_staging, close, and release.');
		expect(prompt).toContain('Do not merge to staging directly.');
		expect(prompt).toContain('Runtime context pack summary.');
		expect(prompt).toContain('"kind": "implementation"');
	});

	it('includes assignment-scoped TreeDX tool guidance without credentials', () => {
		const prompt = buildCodexPrompt({
			...request,
			tools: [treeDxTool],
		});

		expect(prompt).toContain('TreeDX assignment tools:');
		expect(prompt).toContain('treedx_write_workspace_file');
		expect(prompt).toContain('Content writes must use treedx_write_workspace_file');
		expect(prompt).toContain('src/content/**');
		expect(prompt).not.toContain('secret_should_not_leak');
	});

	it('passes TreeDX MCP servers using Codex CLI config keys', () => {
		const config = codexTreeDxConfig({
			...request,
			tools: [treeDxTool],
		});

		expect(config).toMatchObject({
			mcp_servers: {
				treedx_proxy: {
					command: expect.any(String),
					args: expect.any(Array),
					env: expect.objectContaining({
						TREESEED_TREEDX_PROXY_ASSIGNMENT_ID: 'assignment-1',
						TREESEED_TREEDX_PROXY_HANDLE_ID: 'handle-1',
					}),
				},
			},
		});
		expect(config).not.toHaveProperty('mcpServers');
	});

	it('places the core objective before the agent task when available', () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-core-objective-'));
		try {
			mkdirSync(join(repoRoot, 'src/content/objectives'), { recursive: true });
			writeFileSync(
				join(repoRoot, 'src/content/objectives/core.md'),
				[
					'---',
					'id: objective:core',
					'title: Core TreeSeed Objective',
					'---',
					'',
					'Coordinate durable organizational work through governed workdays.',
				].join('\n'),
				'utf8',
			);

			const prompt = buildCodexPrompt({ ...request, repoRoot });

			expect(prompt.startsWith('TreeSeed Core Objective')).toBe(true);
			expect(prompt).toContain('Source: src/content/objectives/core.md');
			expect(prompt.indexOf('Coordinate durable organizational work')).toBeLessThan(prompt.indexOf('Agent Task'));
			expect(prompt.indexOf('Agent Task')).toBeLessThan(prompt.indexOf('You are operating as a TreeSeed implementation agent.'));
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it('starts a new SDK thread and normalizes run output', async () => {
		const run = vi.fn(async () => runResult());
		const startThread = vi.fn(() => ({ id: 'thread-new', run }));
		const resumeThread = vi.fn();

		const result = await runCodexSubscriptionTask(request, {
			createCodexClient: () => ({ startThread, resumeThread }),
			now: vi.fn()
				.mockReturnValueOnce(100)
				.mockReturnValueOnce(160),
		});

		expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
			model: 'gpt-5.5',
			sandboxMode: 'workspace-write',
			workingDirectory: '/repo/.agent-worktrees/task-codex',
		}));
		expect(resumeThread).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledWith(expect.stringContaining('Required behavior:'));
		expect(result).toMatchObject({
			provider: 'codex',
			threadId: 'thread-new',
			status: 'completed',
			finalResponse: 'Implemented docs provider execution.\n\nVerification: npm test',
			summary: 'Implemented docs provider execution.',
			changedPaths: [
				'docs/provider.md',
				'src/content/knowledge/developer/providers/codex.mdx',
			],
			proposedCommands: [
				'npm run test:unit',
				'git status --short',
			],
			verificationHints: ['npm run test:unit'],
			rawEventRefs: ['cmd-1', 'cmd-2', 'patch-1'],
			usage: {
				subscriptionPlan: 'pro',
				wallMs: 60,
			},
		});
	});

	it('resumes an existing SDK thread when a thread id is supplied', async () => {
		const run = vi.fn(async () => ({
			items: [],
			finalResponse: 'Resumed task complete.',
			usage: null,
		}));
		const startThread = vi.fn();
		const resumeThread = vi.fn(() => ({ id: 'thread-existing', run }));

		const result = await runCodexSubscriptionTask({
			...request,
			threadId: 'thread-existing',
		}, {
			createCodexClient: () => ({ startThread, resumeThread }),
		});

		expect(startThread).not.toHaveBeenCalled();
		expect(resumeThread).toHaveBeenCalledWith('thread-existing', expect.objectContaining({
			workingDirectory: '/repo/.agent-worktrees/task-codex',
		}));
		expect(result).toMatchObject({
			status: 'completed',
			threadId: 'thread-existing',
			finalResponse: 'Resumed task complete.',
		});
	});

	it('normalizes SDK command and file-change items without executing a thread', () => {
		const result = normalizeCodexRunResult({
			request,
			result: runResult(),
			threadId: 'thread-normalized',
			wallMs: 42,
		});

		expect(result).toMatchObject({
			status: 'completed',
			threadId: 'thread-normalized',
			changedPaths: [
				'docs/provider.md',
				'src/content/knowledge/developer/providers/codex.mdx',
			],
			proposedCommands: ['npm run test:unit', 'git status --short'],
			verificationHints: ['npm run test:unit'],
			rawEventRefs: ['cmd-1', 'cmd-2', 'patch-1'],
		});
	});

	it('returns waiting for missing worktree safety inputs before SDK construction', async () => {
		const createCodexClient = vi.fn();

		const result = await runCodexSubscriptionTask({
			...request,
			worktreeRoot: undefined,
		}, { createCodexClient });

		expect(result).toMatchObject({
			status: 'waiting',
			error: {
				code: 'worktree_required',
			},
		});
		expect(createCodexClient).not.toHaveBeenCalled();
	});

	it('fails when SDK-reported changes violate mutation scope', async () => {
		const run = vi.fn(async () => ({
			items: [{
				id: 'patch-1',
				type: 'file_change',
				status: 'completed',
				changes: [
					{ path: 'src/content/knowledge/private/secret.mdx', kind: 'update' },
				],
			}],
			finalResponse: 'Changed a forbidden file.',
			usage: null,
		}));

		const result = await runCodexSubscriptionTask(request, {
			createCodexClient: () => ({
				startThread: () => ({ id: 'thread-scope', run }),
				resumeThread: vi.fn(),
			}),
		});

		expect(result).toMatchObject({
			status: 'failed',
			error: {
				code: 'changed_path_scope_violation',
			},
			changedPaths: ['src/content/knowledge/private/secret.mdx'],
			metadata: {
				violatingPath: 'src/content/knowledge/private/secret.mdx',
			},
		});
	});

	it('normalizes SDK errors as retryable provider failures', async () => {
		const run = vi.fn(async () => {
			throw new Error('local Codex auth missing');
		});

		const result = await runCodexSubscriptionTask({
			...request,
			sandboxMode: 'read_only',
			worktreeRoot: undefined,
			approvalId: undefined,
			allowedPaths: [],
		}, {
			createCodexClient: () => ({
				startThread: () => ({ id: 'thread-error', run }),
				resumeThread: vi.fn(),
			}),
		});

		expect(result).toMatchObject({
			status: 'failed',
			threadId: '',
			error: {
				code: 'codex_sdk_initialization_failed',
				message: 'local Codex auth missing',
				retryable: true,
			},
		});
	});
});
