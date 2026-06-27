import { describe, expect, it } from 'vitest';
import { createAssignmentToolCatalog } from '../../src/provider/runner.ts';

const writeHandle = {
	id: 'handle-1',
	projectId: 'project-1',
	assignmentId: 'assignment-1',
	repositoryId: 'repo-1',
	workspaceId: 'workspace-1',
	status: 'active',
	tokenHash: 'secret_should_not_leak',
	allowedOperations: ['files:read', 'files:search', 'files:write', 'git:commit'],
	allowedPaths: ['src/content/**'],
};

describe('provider agent tool catalog', () => {
	it('omits TreeDX tools when the assignment lacks a valid proxy handle', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treedx.read_workspace_file', 'treeseed.status'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.exposed).toEqual(['treeseed.status']);
		expect(catalog.omitted).toEqual([{ id: 'treedx.read_workspace_file', missing: ['treedx_proxy_handle'] }]);
		expect(catalog.descriptors.some((descriptor) => descriptor.executionTarget === 'treedx_proxy')).toBe(false);
	});

	it('exposes only read-capable TreeDX tools in context-only mode', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treedx.read_workspace_file', 'treedx.write_workspace_file', 'treedx.commit_workspace'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'context_only',
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.exposed).toEqual([
			'treedx.read_workspace_file',
			'treedx.write_workspace_file',
			'treedx.commit_workspace',
		]);
		const write = catalog.descriptors.find((descriptor) => descriptor.id === 'treedx.write_workspace_file');
		expect(write).toMatchObject({
			executionTarget: 'treedx_proxy',
			allowedOperations: ['files:read', 'files:search'],
		});
	});

	it('exposes writable TreeDX descriptors with handle metadata in workspace-write mode', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treedx.read_workspace_file', 'treedx.write_workspace_file', 'treedx.commit_workspace'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'workspace_write',
			allowedPaths: ['src/content/**'],
			forbiddenPaths: ['src/content/private/**'],
		});

		expect(catalog.omitted).toEqual([]);
		expect(catalog.descriptors[0]).toMatchObject({
			kind: 'agent_tool',
			executionTarget: 'treedx_proxy',
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			repositoryId: 'repo-1',
			workspaceId: 'workspace-1',
			allowedOperations: ['files:read', 'files:search', 'files:write', 'git:commit'],
			metadata: expect.objectContaining({
				assignmentId: 'assignment-1',
				projectId: 'project-1',
				allowedPaths: ['src/content/**'],
				forbiddenPaths: ['src/content/private/**'],
			}),
		});
		expect(JSON.stringify(catalog)).not.toContain('secret_should_not_leak');
	});

	it('marks dispatch preferred mode for SDK tools', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.status', 'treeseed.verify', 'treeseed.changed_paths'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: '/repo/.agent-worktrees/task',
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.descriptors.find((descriptor) => descriptor.id === 'treeseed.status')?.metadata).toMatchObject({
			dispatchPreferredMode: 'auto',
		});
		expect(catalog.descriptors.find((descriptor) => descriptor.id === 'treeseed.verify')?.metadata).toMatchObject({
			dispatchPreferredMode: 'prefer_local',
			worktreeRoot: '/repo/.agent-worktrees/task',
		});
	});

	it('filters model-aware content tools through contentAccess', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.questions.create', 'treeseed.proposals.create', 'treeseed.content.commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'workspace_write',
			contentAccess: {
				read: { models: ['question'], actions: ['query', 'read'] },
				write: { models: ['question'], actions: ['create', 'update', 'validate'] },
				commit: { allowed: false },
			},
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.exposed).toEqual(['treeseed.questions.create']);
		expect(catalog.omitted).toEqual([
			{ id: 'treeseed.proposals.create', missing: ['content_access'] },
			{ id: 'treeseed.content.commit', missing: ['content_access', 'content_commit'] },
		]);
		expect(catalog.descriptors[0]).toMatchObject({
			executionTarget: 'treeseed_content',
			metadata: expect.objectContaining({
				contentAction: 'create',
				contentModel: 'question',
				contentPreset: 'treeseed.questions.create',
			}),
		});
		expect(JSON.stringify(catalog)).not.toContain('secret_should_not_leak');
	});

	it('omits writable content tools for context-only workspaces', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.questions.query', 'treeseed.questions.create'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'context_only',
			contentAccess: {
				read: { models: ['question'], actions: ['query', 'read'] },
				write: { models: ['question'], actions: ['create'] },
				commit: { allowed: false },
			},
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.exposed).toEqual(['treeseed.questions.query']);
		expect(catalog.omitted).toEqual([{ id: 'treeseed.questions.create', missing: ['treedx_writable_workspace'] }]);
	});
});
