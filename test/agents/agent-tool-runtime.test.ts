import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	callAgentTool,
	callAgentToolWithTelemetry,
} from '../../src/agents/tools/agent-tool-runtime.ts';
import type { ExecutionProviderToolDescriptor } from '../../src/agents/runtime-types.ts';
import { createAssignmentToolCatalog } from '../../src/provider/runner.ts';

const tempRoots: string[] = [];

function statusDescriptor(overrides: Partial<ExecutionProviderToolDescriptor> = {}): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.status',
		name: 'TreeSeed status',
		description: 'Status',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		outputSchema: { type: 'object', additionalProperties: true },
		executionTarget: 'sdk_dispatch',
		mutability: 'read',
		metadata: {
			assignmentId: 'assignment-1',
			projectId: 'project-1',
			dispatchPreferredMode: 'auto',
			telemetryCategory: 'treeseed',
		},
		...overrides,
	};
}

function changedPathsDescriptor(worktreeRoot: string): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.changed_paths',
		name: 'Changed paths',
		description: 'Changed paths',
		inputSchema: {
			type: 'object',
			properties: { includeDiffSummary: { type: 'boolean' } },
			additionalProperties: false,
		},
		outputSchema: { type: 'object', additionalProperties: true },
		executionTarget: 'provider_runner',
		mutability: 'read',
		metadata: {
			assignmentId: 'assignment-1',
			projectId: 'project-1',
			worktreeRoot,
			allowedPaths: ['src/content/**'],
			forbiddenPaths: ['src/content/private/**'],
			telemetryCategory: 'repository',
		},
	};
}

describe('agent tool runtime', () => {
	afterEach(async () => {
		await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it('rejects tools not listed in the assignment catalog', async () => {
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerApiKey: '',
			assignmentId: 'assignment-1',
			descriptors: [],
		}, 'treeseed.status')).resolves.toMatchObject({ ok: false, code: 'tool_not_allowed' });
	});

	it('validates required fields and additional properties before execution', async () => {
		const descriptor: ExecutionProviderToolDescriptor = {
			...statusDescriptor(),
			id: 'treedx.write_workspace_file',
			executionTarget: 'treedx_proxy',
			mutability: 'content_write',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
				additionalProperties: false,
			},
		};
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerApiKey: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor],
		}, 'treedx.write_workspace_file', { path: 'src/content/a.mdx' })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_tool_input',
			metadata: { field: 'content' },
		});
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerApiKey: '',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
		}, 'treeseed.status', { extra: true })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_tool_input',
			metadata: { field: 'extra' },
		});
	});

	it('uses descriptor dispatch preferred mode for sdk dispatch tools', async () => {
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: {} }));
		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
			sdk: { dispatch },
		}, 'treeseed.status')).resolves.toMatchObject({ ok: true });
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			namespace: 'workflow',
			operation: 'status',
			preferredMode: 'auto',
		}));
	});

	it('creates model-aware content through TreeDX proxy calls', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.questions.create'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1',
				projectId: 'project-1',
				assignmentId: 'assignment-1',
				repositoryId: 'repo-1',
				workspaceId: 'workspace-1',
				allowedOperations: ['files:read', 'files:search', 'files:write'],
				allowedPaths: ['src/content/**'],
			},
			contentAccess: {
				read: { models: ['question'], actions: ['query', 'read'] },
				write: { models: ['question'], actions: ['create', 'validate'] },
				commit: { allowed: false },
			},
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			if (init?.method === 'GET') {
				return new Response(JSON.stringify({ content: String(calls[0]?.init.body ? JSON.parse(String(calls[0].init.body)).content : '') }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;

		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl,
		}, 'treeseed.questions.create', {
			title: 'How should content tools work?',
			fields: { questionType: 'implementation' },
			body: 'Create canonical content.',
		})).resolves.toMatchObject({
			ok: true,
			action: 'create',
			refs: [{ model: 'question', collection: 'questions', slug: 'how-should-content-tools-work' }],
			changedPaths: ['src/content/questions/how-should-content-tools-work.mdx'],
		});
		expect(fetchImpl).toHaveBeenCalled();
		expect(String(calls[0]?.init.body)).toContain('question_type');
		expect(String(calls[0]?.init.body)).not.toContain('provider-key');
	});

	it('keeps verify worktree scoped and local-preferred', async () => {
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: {} }));
		const descriptor: ExecutionProviderToolDescriptor = {
			...statusDescriptor(),
			id: 'treeseed.verify',
			inputSchema: {
				type: 'object',
				properties: {
					commands: { type: 'array', items: { type: 'string' } },
					reason: { type: 'string' },
				},
				additionalProperties: false,
			},
			mutability: 'worktree_write',
			metadata: {
				...statusDescriptor().metadata,
				worktreeRoot: '/tmp/worktree',
				dispatchPreferredMode: 'prefer_local',
			},
		};
		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: [descriptor],
			sdk: { dispatch },
		}, 'treeseed.verify', { commands: ['node --version'] })).resolves.toMatchObject({ ok: true });
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			operation: 'test',
			preferredMode: 'prefer_local',
			input: expect.objectContaining({ cwd: '/tmp/worktree' }),
		}));
	});

	it('enforces changed path scope', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-tool-runtime-'));
		tempRoots.push(root);
		execFileSync('git', ['init', '-b', 'main'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'agent-tool@example.test'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Agent Tool'], { cwd: root });
		mkdirSync(join(root, 'src/content/private'), { recursive: true });
		writeFileSync(join(root, 'src/content/private/secret.mdx'), 'secret\n', 'utf8');
		execFileSync('git', ['add', 'src/content/private/secret.mdx'], { cwd: root });
		const result = await callAgentTool({
			apiBaseUrl: '',
			providerApiKey: '',
			assignmentId: 'assignment-1',
			descriptors: [changedPathsDescriptor(root)],
		}, 'treeseed.changed_paths');
		expect(result).toMatchObject({ ok: false, code: 'path_forbidden' });
	});

	it('emits redacted telemetry for tool calls', async () => {
		const telemetry: unknown[] = [];
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: { token: 'not-input' } }));
		await callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerApiKey: '',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
			sdk: { dispatch },
			onTelemetry: (entry) => telemetry.push(entry),
		}, 'treeseed.status');
		expect(telemetry).toHaveLength(2);
		expect(telemetry.at(-1)).toMatchObject({
			toolId: 'treeseed.status',
			status: 'completed',
		});
	});
});
