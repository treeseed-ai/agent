import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	callAgentTool,
} from '../../../src/agents/tools/agent-tool-runtime.ts';

import { callAgentToolWithTelemetry } from '../../../src/agents/tools/agent-tool-telemetry.ts';

import type { ExecutionProviderToolDescriptor } from '../../../src/agents/runtime-types.ts';

import { createAssignmentToolCatalog } from '../../../src/provider/assignment-tool-catalog.ts';

import { AgentSdk } from '@treeseed/sdk/sdk';

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
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

it('rejects tools not listed in the assignment catalog', async () => {
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerAccessToken: '',
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
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor],
		}, 'treedx.write_workspace_file', { path: 'src/content/a.mdx' })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_tool_input',
			metadata: { field: 'content' },
		});
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerAccessToken: '',
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
			providerAccessToken: 'provider-key',
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

it('keeps provider-runner SDK dispatch ephemeral and out of the assignment worktree', async () => {
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: {} }));
		const createLocal = vi.spyOn(AgentSdk, 'createLocal').mockReturnValue({ dispatch } as never);
		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
			repoRoot: '/repo/.agent-worktrees/assignment-1',
		}, 'treeseed.status')).resolves.toMatchObject({ ok: true });
		expect(createLocal).toHaveBeenCalledWith(expect.objectContaining({
			repoRoot: '/repo/.agent-worktrees/assignment-1',
			databaseName: ':memory:',
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
				teamId: 'team-1',
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
		const telemetry: Array<Record<string, unknown>> = [];

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.questions.create', {
			title: 'How should content tools work?',
			fields: { questionType: 'implementation', relatedObjectives: ['objective-1'] },
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
		expect(telemetry.at(-1)).toMatchObject({
			derivedEvents: [{
				type: 'content_created',
				contentRef: {
					model: 'question',
					path: 'src/content/questions/how-should-content-tools-work.mdx',
					subjectId: 'objective-1',
					subjectField: 'related_objectives',
				},
			}],
		});
	});

it('places model-aware content beneath the assignment package content root', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.questions.create'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1',
				allowedOperations: ['files:read', 'files:write'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			contentAccess: {
				read: { models: ['question'], actions: ['read'] },
				write: { models: ['question'], actions: ['create'] },
				commit: { allowed: false },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			new Response(JSON.stringify(init?.method === 'GET' ? { content: '' } : { ok: true }), { status: 200 })) as unknown as typeof fetch;
		const result = await callAgentTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: catalog.descriptors, fetchImpl,
		}, 'treeseed.questions.create', { title: 'Package scoped question' });
		expect(result).toMatchObject({
			ok: true,
			changedPaths: ['docs/src/content/questions/package-scoped-question.mdx'],
		});
	});

it('reads legacy Markdown content while returning the authoritative TreeDX path', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.read'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1',
				allowedOperations: ['files:read'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			contentAccess: {
				read: { models: ['objective'], actions: ['read'] },
				write: { models: [], actions: [] },
				commit: { allowed: false },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const requestedPaths: string[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const path = new URL(String(url)).searchParams.get('path') ?? '';
			requestedPaths.push(path);
			if (path.endsWith('.mdx')) {
				return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
			}
			return new Response(JSON.stringify({ content: '---\nid: objective:core\n---\n' }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await callAgentTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: catalog.descriptors, fetchImpl,
		}, 'treeseed.content.read', { model: 'objective', id: 'core' });
		expect(result).toMatchObject({
			ok: true,
			refs: [{ model: 'objective', path: 'docs/src/content/objectives/core.md' }],
		});
		expect(requestedPaths).toEqual([
			'docs/src/content/objectives/core.mdx',
			'docs/src/content/objectives/core.md',
		]);
	});
});
