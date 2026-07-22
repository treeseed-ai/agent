import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	callAgentTool,
} from '../../src/agents/tools/agent-tool-runtime.ts';
import { callAgentToolWithTelemetry } from '../../src/agents/tools/agent-tool-telemetry.ts';
import type { ExecutionProviderToolDescriptor } from '../../src/agents/runtime-types.ts';
import { createAssignmentToolCatalog } from '../../src/provider/assignment-tool-catalog.ts';
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

	it('preserves commit provenance returned through the TreeDX proxy envelope', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1',
				status: 'active',
				allowedOperations: ['files:write', 'git:commit'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			contentAccess: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create'] },
				commit: { allowed: true },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			ok: true,
			payload: {
				ok: true,
				status: 'committed',
				commitSha: 'abc123',
				branchName: 'refs/heads/agent-work',
			},
		}), { status: 200 })) as unknown as typeof fetch;
		const telemetry: Array<Record<string, unknown>> = [];

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.content.commit', { message: 'Persist planning note' })).resolves.toMatchObject({ ok: true });
		expect(telemetry.at(-1)).toMatchObject({
			derivedEvents: [{
				type: 'content_committed',
				commitSha: 'abc123',
				branchRef: 'refs/heads/agent-work',
			}],
		});
	});

	it('blocks workspace finalization until the required linked content artifact exists', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-precommit-'));
		tempRoots.push(root);
		const telemetryPath = join(root, 'events.jsonl');
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', status: 'active',
				allowedOperations: ['files:write', 'git:commit'],
				allowedPaths: ['docs/**'], allowedWritePaths: ['docs', 'docs/**'],
			},
			contentAccess: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create', 'link'] },
				commit: { allowed: true },
			},
			allowedPaths: ['docs/**'], forbiddenPaths: [],
		});
		const commit = catalog.descriptors.find((entry) => entry.id === 'treeseed.content.commit')!;
		const descriptor = {
			...commit,
			metadata: {
				...(commit.metadata ?? {}),
				requiredArtifactKind: 'documentation_update',
				requireContentArtifact: true,
			},
		};
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: {
			status: 'committed', commitSha: 'abc123', branchName: 'refs/heads/agent-work',
		} }), { status: 200 })) as unknown as typeof fetch;
		writeFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'docs/src/content/notes/release.md' } }],
		})}\n`, 'utf8');

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' })).resolves.toMatchObject({
			ok: false,
			code: 'content_completion_required_before_commit',
			metadata: { missingReceipts: [
				'content_subject_linked:docs/src/content/notes/release.md',
			] },
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		writeFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_updated', contentRef: {
				model: 'note', path: 'docs/src/content/notes/release.md',
				subjectId: 'proposal:release-channel-normalization', subjectField: 'about',
			} }],
		})}\n`, 'utf8');
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' })).resolves.toMatchObject({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('runs bounded verification in the assignment worktree and accepts an expected failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-verify-'));
		tempRoots.push(root);
		mkdirSync(join(root, 'template'), { recursive: true });
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: root,
			allowedPaths: ['template/tests/**'],
		});
		const descriptor = catalog.descriptors.find((entry) => entry.id === 'treeseed.verify');
		expect(descriptor).toBeDefined();
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
		}, 'treeseed.verify', {
			commands: [{
				command: 'node',
				args: ['-e', 'process.exit(3)'],
				cwd: 'template',
				expectedExitCode: 3,
			}],
		})).resolves.toMatchObject({
			ok: true,
			payload: {
				results: [expect.objectContaining({ command: 'node', cwd: 'template', exitCode: 3, expectedExitCode: 3, ok: true })],
			},
		});
		await expect(callAgentTool({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
		}, 'treeseed.verify', {
			commands: [{ command: 'node', args: ['--version'], cwd: '../outside' }],
		})).resolves.toMatchObject({ ok: false, code: 'verification_cwd_invalid' });
	});

	it('emits structured verification evidence for the artifact manifest', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-verify-telemetry-'));
		tempRoots.push(root);
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: root,
		});
		const telemetry: Array<Record<string, unknown>> = [];
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.verify', {
			commands: [{ command: 'node', args: ['-e', 'process.exit(3)'], expectedExitCode: 3 }],
		})).resolves.toMatchObject({ ok: true });
		expect(telemetry.at(-1)).toMatchObject({
			status: 'completed',
			derivedEvents: [{
				type: 'verification_completed',
				status: 'passed',
				commands: ['node -e process.exit(3) (cwd: .)'],
			}],
		});
	});

	it('records an explicit governed review disposition event', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.review_decision'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
		});
		const telemetry: Array<Record<string, unknown>> = [];
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.review_decision', {
			disposition: 'rejected',
			summary: 'The implementation needs a bounded recovery correction.',
		})).resolves.toMatchObject({
			ok: true,
			payload: { disposition: 'rejected' },
		});
		expect(telemetry.at(-1)).toMatchObject({
			status: 'completed',
			derivedEvents: [{
				type: 'review_decision_recorded',
				disposition: 'rejected',
			}],
		});
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
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [changedPathsDescriptor(root)],
		}, 'treeseed.changed_paths');
		expect(result).toMatchObject({ ok: false, code: 'path_forbidden' });
	});

	it('reads and searches only bounded assignment repository paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-repository-tools-'));
		tempRoots.push(root);
		execFileSync('git', ['init', '-b', 'main'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'agent-tool@example.test'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Agent Tool'], { cwd: root });
		mkdirSync(join(root, 'src/private'), { recursive: true });
		writeFileSync(join(root, 'src/scheduler.ts'), 'export const scheduler = \"weighted-deficit\";\\n', 'utf8');
		writeFileSync(join(root, 'src/private/secret.ts'), 'export const secret = true;\\n', 'utf8');
		execFileSync('git', ['add', '.'], { cwd: root });
		execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.repository.read_file', 'treeseed.repository.search'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			allowedPaths: ['src/**'],
			forbiddenPaths: ['src/private/**'],
		});
		const options = {
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			repoRoot: root,
		};
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: 'src/scheduler.ts',
		})).resolves.toMatchObject({
			ok: true,
			payload: { path: 'src/scheduler.ts', content: expect.stringContaining('weighted-deficit'), truncated: false },
		});
		await expect(callAgentTool(options, 'treeseed.repository.search', {
			query: 'weighted-deficit',
			paths: ['src'],
		})).resolves.toMatchObject({
			ok: true,
			payload: { matches: [{ path: 'src/scheduler.ts', match: expect.stringContaining('weighted-deficit') }] },
		});
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: 'src/private/secret.ts',
		})).resolves.toMatchObject({ ok: false, code: 'path_forbidden' });
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: '../outside',
		})).resolves.toMatchObject({ ok: false, code: 'repository_path_invalid' });
	});

	it('emits redacted telemetry for tool calls', async () => {
		const telemetry: unknown[] = [];
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: { token: 'not-input' } }));
		await callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerAccessToken: '',
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
