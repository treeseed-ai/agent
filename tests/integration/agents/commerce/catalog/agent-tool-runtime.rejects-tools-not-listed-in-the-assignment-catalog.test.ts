import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	callAgentTool,
} from '../../../../../src/agents/tools/agent-tool-runtime.ts';

import { callAgentToolWithTelemetry } from '../../../../../src/agents/tools/agent-tool-telemetry.ts';

import type { ExecutionProviderToolDescriptor } from '../../../../../src/agents/runtime/runtime-types.ts';

import { createAssignmentToolCatalog } from '../../../../../src/provider/commerce/catalog/assignment-tool-catalog.ts';

import { AgentSdk } from '@treeseed/sdk/sdk';

const tempRoots: string[] = [];

function assignmentStatusEnvelope() {
	return { ok: true, payload: {
		id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', workDayId: 'workday-1',
		stateVersion: 2, status: 'leased', leaseState: 'leased', assignedAt: '2026-08-14T00:00:00.000Z',
		capacityEnvelope: { reservedSeconds: 900, budget: { time: { hardDeadlineAt: '2099-01-01T00:00:00.000Z' } } },
		decisionInput: { input: { activityType: 'planning' } }, metadata: { workdayRunId: 'run-1' },
	} };
}

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
			id: 'treedx.apply_workspace_changeset',
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
		}, 'treedx.apply_workspace_changeset', { path: 'src/content/a.mdx' })).resolves.toMatchObject({
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

it('reads assignment status from the provider-authorized API without exposing lease credentials', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: {
			id: 'assignment-1', workDayId: 'workday-1', projectId: 'project-1', agentId: 'guide-steward',
			projectAgentClassId: 'class-1', handlerId: 'writer', mode: 'planning', status: 'leased',
			leaseState: 'leased', leaseExpiresAt: '2026-08-04T00:00:00.000Z', leaseToken: 'must-not-leak',
			decisionInput: { input: { activityType: 'planning' } }, capacityEnvelope: { reservedSeconds: 1 },
			metadata: { workdayRunId: 'run-1' }, treedxProxyHandle: { token: 'must-not-leak' },
		} }), { status: 200, headers: { 'content-type': 'application/json' } }));
		const result = await callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
			repoRoot: '/repo/.agent-worktrees/assignment-1',
			fetchImpl: fetchImpl as typeof fetch,
		}, 'treeseed.status');
		expect(result).toMatchObject({ ok: true, payload: {
			assignmentId: 'assignment-1', workdayId: 'workday-1', workdayRunId: 'run-1',
			activityType: 'planning', status: 'leased', time: { allocatedSeconds: 1, phase: 'working', shouldCloseOut: false },
		} });
		expect(JSON.stringify(result)).not.toContain('must-not-leak');
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.example.test/v1/provider/assignments/assignment-1',
			expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer provider-key' }) }),
		);
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
				baseCommitSha: 'abc123', baseRef: 'refs/heads/main',
				allowedOperations: ['files:read', 'files:search', 'files:write'],
				allowedPaths: ['src/content/**'],
			},
			permissionProjection: {
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
			if (String(url).includes('/v1/provider/assignments/')) return new Response(JSON.stringify(assignmentStatusEnvelope()), { status: 200 });
			if (String(url).includes('/search')) return Response.json({ ok: true, payload: { results: [{ path: 'src/content/objectives/objective-1.mdx' }] } });
			if (init?.method === 'GET') {
				if (String(url).includes('src%2Fcontent%2Fquestions%2F')) return new Response(JSON.stringify({ ok:false,code:'not_found' }), { status: 404 });
				if (String(url).includes('src%2Fcontent%2Fobjectives%2F')) return Response.json({ ok: true, payload: { content: '---\nid: objective-1\ntitle: Objective one\nstatus: live\n---\nObjective.' } });
				return new Response(JSON.stringify({ content: '---\nid: question:how-should-content-tools-work\ntitle: How should content tools work?\nquestion_type: implementation\nrelated_objectives: [objective-1]\n---\n\nCreate canonical content.\n' }), { status: 200 });
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
		const contentWrite = calls.find((call) => typeof call.init.body === 'string' && call.init.body.includes('question_type'));
		expect(String(contentWrite?.init.body)).toContain('question_type');
		expect(String(contentWrite?.init.body)).not.toContain('provider-key');
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
				baseCommitSha: 'abc123', baseRef: 'refs/heads/main',
				allowedOperations: ['files:read', 'files:write'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			permissionProjection: {
				read: { models: ['question'], actions: ['read'] },
				write: { models: ['question'], actions: ['create'] },
				commit: { allowed: false },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
			new Response(JSON.stringify(String(url).includes('/v1/provider/assignments/') ? assignmentStatusEnvelope() : init?.method === 'GET' ? { content: '' } : { ok: true }), { status: 200 })) as unknown as typeof fetch;
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
			permissionProjection: {
				read: { models: ['objective'], actions: ['read'] },
				write: { models: [], actions: [] },
				commit: { allowed: false },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const requestedPaths: string[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes('/v1/provider/assignments/')) return new Response(JSON.stringify(assignmentStatusEnvelope()), { status: 200 });
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
