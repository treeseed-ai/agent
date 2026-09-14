import { describe, expect, it, vi } from 'vitest';
import { materializeAssignmentContext } from '../../../src/kernel/materialize-context.ts';

describe('canonical assignment context materialization', () => {
	it('keeps an exact Git path in source custody without invoking TreeDX', async () => {
		const commit = 'b'.repeat(40);
		const reference = { store: 'git', model: 'repository', id: 'sdk-fixture', repository: 'treeseed-ai/sdk',
			commit, path: 'tests/fixtures/agent-execution/review-cycle.json' };
		const invoke = vi.fn();
		const context = await materializeAssignmentContext({
			attempt: { contextRefs: [reference] } as never,
			predecessorResults: [],
			treeDx: { projectId: 'sdk-project', repositoryId: 'sdk-library', workspaceId: null, invoke } as never,
		});
		expect(invoke).not.toHaveBeenCalled();
		expect(context.context[0]).toMatchObject({ ref: reference, mediaType: 'application/vnd.treeseed.git-ref+json',
			value: { repository: 'treeseed-ai/sdk', commit, path: reference.path } });
	});

	it('unwraps the control-plane envelope and accepts an exact extensionless TreeDX path', async () => {
		const commit = 'a'.repeat(40);
		const reference = { store: 'treedx', model: 'objective', id: 'team:objective',
			repository: 'team-repository', commit, path: 'objectives/core' };
		const invoke = vi.fn(async () => ({ result: { result: { ok: true, resolvedRef: commit, files: [{
			path: 'objectives/core.mdx', requestedPath: 'objectives/core', content: '# Core', frontmatter: { id: 'core' },
		}] } } }));
		const context = await materializeAssignmentContext({
			attempt: { contextRefs: [reference] } as never,
			predecessorResults: [],
			treeDx: { projectId: 'team-project', repositoryId: 'team-repository', workspaceId: null, invoke } as never,
		});
		expect(invoke).toHaveBeenCalledWith('treedx.repositories.files.read', expect.objectContaining({
			body: expect.objectContaining({ ref: commit, paths: ['objectives/core'] }),
		}));
		expect(context.context[0]).toMatchObject({ ref: reference, value: {
			path: 'objectives/core.mdx', requestedPath: 'objectives/core', content: '# Core',
		} });
	});
});
