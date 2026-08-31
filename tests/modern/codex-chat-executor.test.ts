import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertObjectiveContentModel, discussionMessageSourcePaths, readDiscussionSourceMessage, readIdentityContext, readableCloneUrl, validatedSnapshotPaths } from '../../src/provider/execution/codex-chat-executor.ts';
import { reasoningEffortFromAssignmentMetadata } from '../../src/provider/execution/microvm-executor.ts';
import { codexInteractiveTimeoutMs, codexReasoningArguments } from '../../src/sandbox/guest.ts';

describe('Codex chat executor', () => {
	it('carries the agent-selected reasoning effort into Codex without a provider hardcode', () => {
		expect(reasoningEffortFromAssignmentMetadata({ chatProfile: { execution: { reasoningEffort: 'high' } } })).toBe('high');
		expect(reasoningEffortFromAssignmentMetadata({ executionPolicy: { reasoningEffort: 'xhigh' } })).toBe('xhigh');
		expect(codexReasoningArguments('high')).toEqual(['-c', 'model_reasoning_effort=high']);
		expect(reasoningEffortFromAssignmentMetadata({ chatProfile: { execution: { reasoningEffort: 'fast' } } })).toBeUndefined();
		expect(codexReasoningArguments(undefined)).toEqual([]);
	});
	it('keeps interactive execution inside the one-minute chat budget', () => {
		expect(codexInteractiveTimeoutMs(900)).toBe(38_000);
		expect(codexInteractiveTimeoutMs(20)).toBe(15_000);
	});
	it('uses a non-interactive readable URL for public GitHub project workspaces', () => {
		expect(readableCloneUrl('git@github.com:treeseed-ai/sdk.git')).toBe('https://github.com/treeseed-ai/sdk.git');
		expect(readableCloneUrl('https://example.test/project.git')).toBe('https://example.test/project.git');
	});
	it('accepts root and nested TreeDX discussion-message references', () => {
		expect(discussionMessageSourcePaths({ sourceMessageRefs: [
			'discussion-messages/topic/message.mdx',
			'./discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
			'knowledge/topic/message.mdx',
		] })).toEqual([
			'discussion-messages/topic/message.mdx',
			'discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
		]);
	});
	it('rejects unsafe, duplicate, and parent-colliding TreeDX snapshot paths', () => {
		expect(validatedSnapshotPaths([{ path: 'objectives/core.mdx' }, { path: 'agents/architect.mdx' }])).toEqual(['objectives/core.mdx', 'agents/architect.mdx']);
		for (const entries of [[{ path: '../secret' }], [{ path: 'a\\b' }], [{ path: 'a' }, { path: 'a' }], [{ path: 'a' }, { path: 'a/b' }]]) expect(() => validatedSnapshotPaths(entries)).toThrow();
	});

	it('requires objective-directory Markdown to satisfy the SDK objective content model', () => {
		expect(() => assertObjectiveContentModel('objectives/core.mdx', { frontmatter: { title: 'Core objective' } })).not.toThrow();
		expect(() => assertObjectiveContentModel('objectives/core.md', { frontmatter: {} })).toThrow(/SDK objective content model/u);
		expect(() => assertObjectiveContentModel('knowledge/core.md', { frontmatter: {} })).not.toThrow();
	});

	it('resolves the logical core objective to the exact file present in the frozen snapshot', async () => {
		let requested: string[] = [];
		const context = await readIdentityContext({ assignment: { metadata: { identityManifest: {
			agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1' },
			coreObjective: { path: 'objectives/core', candidates: ['objectives/core.mdx', 'objectives/core.md'], expectedRevision: 'commit-1' },
			projectReadme: { path: 'README.md', expectedRevision: 'commit-1' }, instructionTemplates: [],
		} } }, assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner', treeDx: {
			projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1', invoke: async (_operationId, value: any) => {
				requested = value.body.paths; return { data: { result: { files: [
					{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.md', content: 'objective', frontmatter: { title: 'Core objective' } }, { path: 'README.md', content: 'readme' },
				] } } };
			},
		} }, new Set(['agents/architect.yaml', 'objectives/core.md', 'README.md']));
		expect(requested).toContain('objectives/core.md');
		expect(requested).not.toContain('objectives/core.mdx');
		expect((context.manifest.sources as any[])[1]).toMatchObject({ logicalPath: 'objectives/core', path: 'objectives/core.md' });
	});

	it('reads the committed discussion message at the assignment exact ref', async () => {
		let input: Record<string, unknown> | undefined;
		const content = await readDiscussionSourceMessage({
			assignment: { sourceMessageRefs: ['discussion-messages/topic/message.mdx'] },
			assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner',
			treeDx: { projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1',
				invoke: async (_operationId, value) => { input = value; return {
					data: { result: { files: [{ content: 'Exact message' }] }, receipt: { requestId: 'request-1' } },
				}; } },
		});
		expect(content).toBe('Exact message');
		expect(input).toEqual({ path: { repoId: 'repo-1' }, body: {
			ref: 'commit-1', paths: ['discussion-messages/topic/message.mdx'], encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
		} });
	});

	it('verifies exact identity, objective, and instruction sources at the immutable TreeDX ref', async () => {
		const profile = 'name: Architect'; const digest = `sha256:${createHash('sha256').update(profile).digest('hex')}`; let input: any;
		const context = await readIdentityContext({ assignment: { metadata: { identityManifest: {
			agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1', digest },
			coreObjective: { path: 'objectives/core', candidates: ['objectives/core.mdx', 'objectives/core.md'], expectedRevision: 'commit-1' },
			projectReadme: { path: 'README.md', expectedRevision: 'commit-1' },
			instructionTemplates: [{ path: 'instructions/chat.md', expectedRevision: 'commit-1' }],
		} } }, assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner',
			treeDx: { projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1', invoke: async (_operationId, value) => { input = value; return { data: { result: { files: [
				{ path: 'agents/architect.yaml', content: profile }, { path: 'objectives/core.mdx', content: '# Objective', frontmatter: { title: 'Core objective' } }, { path: 'README.md', content: '# SDK' }, { path: 'instructions/chat.md', content: 'Be concise.' },
			] } } }; } } });
		expect(input.body.ref).toBe('commit-1');
		expect(context.manifest.agentHandle).toBe('@sdk/architect');
		expect((context.manifest.sources as any[]).map((source) => source.path)).toEqual(['agents/architect.yaml', 'objectives/core.mdx', 'README.md', 'instructions/chat.md']);
		expect((context.manifest.sources as any[])[1].logicalPath).toBe('objectives/core');
		expect((context.manifest.sources as any[]).every((source) => source.disposition === 'prompt-injected')).toBe(true);
	});

	it('fails closed when identity authority or content digest is mismatched', async () => {
		const request: any = { assignment: { metadata: { identityManifest: { agentHandle: '@sdk/architect', repositoryId: 'repo-1', immutableRef: 'commit-1',
			agentProfile: { path: 'agents/architect.yaml', expectedRevision: 'commit-1', digest: 'sha256:wrong' }, coreObjective: { paths: ['objectives/core.mdx'], expectedRevision: 'commit-1' }, instructionTemplates: [] } } },
			assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner', treeDx: { projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1',
				invoke: async () => ({ data: { result: { files: [{ path: 'agents/architect.yaml', content: 'profile' }, { path: 'objectives/core.mdx', content: 'objective', frontmatter: { title: 'Core objective' } }] } } }) } };
		await expect(readIdentityContext(request)).rejects.toThrow(/digest mismatch/u);
		request.treeDx.baseRef = 'commit-2';
		await expect(readIdentityContext(request)).rejects.toThrow(/does not match/u);
	});
});
