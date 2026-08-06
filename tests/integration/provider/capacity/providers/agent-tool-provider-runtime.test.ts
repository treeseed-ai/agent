import { describe, expect, it } from 'vitest';
import { createAssignmentToolCatalog } from '../../../../../src/provider/commerce/catalog/assignment-tool-catalog.ts';

const writeHandle = {
	id: 'handle-1',
	teamId: 'team-1',
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
	it('exposes research tools only with a non-empty provider/project policy intersection', () => {
		const denied = createAssignmentToolCatalog({
			agentTools: ['research.search_sources', 'research.fetch_source'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
		});
		expect(denied.exposed).toEqual([]);
		expect(denied.omitted).toEqual([
			{ id: 'research.search_sources', missing: ['research_source_policy'] },
			{ id: 'research.fetch_source', missing: ['research_source_policy'] },
		]);

		const allowed = createAssignmentToolCatalog({
			agentTools: ['research.search_sources', 'research.fetch_source'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			researchNetworkPolicy: { allowWeb: true, allowedDomains: ['sources.example.test'] },
			providerResearchSourcePolicy: { allowedDomains: ['example.test'] },
		});
		expect(allowed.exposed).toEqual(['research.search_sources', 'research.fetch_source']);
		expect(allowed.descriptors[0]?.metadata).toMatchObject({ researchAllowedDomains: ['sources.example.test'] });

		const disjoint = createAssignmentToolCatalog({
			agentTools: ['research.fetch_source'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			researchNetworkPolicy: { allowWeb: true, allowedDomains: ['sources.example.test'] },
			providerResearchSourcePolicy: { allowedDomains: ['other.test'] },
		});
		expect(disjoint.omitted).toEqual([{ id: 'research.fetch_source', missing: ['research_source_policy'] }]);
	});

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
			agentTools: ['treedx.read_workspace_file', 'treedx.apply_workspace_changeset', 'treedx.commit_workspace'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'context_only',
			allowedPaths: ['src/content/**'],
			forbiddenPaths: [],
		});

		expect(catalog.exposed).toEqual(['treedx.read_workspace_file']);
		expect(catalog.omitted).toEqual([
			{ id: 'treedx.apply_workspace_changeset', missing: ['treedx_writable_workspace'] },
			{ id: 'treedx.commit_workspace', missing: ['treedx_writable_workspace', 'content_commit'] },
		]);
	});

	it('exposes writable TreeDX descriptors with handle metadata in workspace-write mode', () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treedx.read_workspace_file', 'treedx.apply_workspace_changeset', 'treedx.commit_workspace'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: writeHandle,
			workspaceMode: 'workspace_write',
			contentAccess: { write: { models: ['*'], actions: ['commit'] }, commit: { allowed: true } },
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

	it('marks dispatch preference only for SDK tools and keeps verify provider-owned', () => {
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
			worktreeRoot: '/repo/.agent-worktrees/task',
		});
		expect(catalog.descriptors.find((descriptor) => descriptor.id === 'treeseed.verify')).toMatchObject({
			executionTarget: 'provider_runner',
			mutability: 'read',
		});
		expect(catalog.descriptors.find((descriptor) => descriptor.id === 'treeseed.verify')?.metadata?.dispatchPreferredMode).toBeUndefined();

		const withoutWorktree = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
		});
		expect(withoutWorktree.exposed).not.toContain('treeseed.verify');
		expect(withoutWorktree.omitted).toContainEqual({
			id: 'treeseed.verify',
			missing: ['assignment_worktree'],
		});
		const providerManagedWorktree = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify', 'treeseed.checkpoint'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: null,
			providerManagesWorktree: true,
		});
		expect(providerManagedWorktree.exposed).toEqual(['treeseed.verify', 'treeseed.checkpoint']);
		expect(providerManagedWorktree.descriptors.every((descriptor) => descriptor.metadata?.worktreeRoot === null)).toBe(true);
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
