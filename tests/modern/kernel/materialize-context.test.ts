import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { materializeAssignmentContext } from '../../../src/kernel/materialize-context.ts';

describe('canonical assignment context materialization', () => {
	it('keeps an exact Git path in source custody without invoking TreeDX', async () => {
		const commit = 'b'.repeat(40);
		const reference = { store: 'git', model: 'repository', id: 'sdk-fixture', repository: 'treeseed-ai/sdk',
			commit, path: 'tests/fixtures/agent-execution/review-cycle.json' };
		const invoke = vi.fn();
		const context = await materializeAssignmentContext({
			attempt: { contextRefs: [reference], effectiveProfile: { activity: 'acting' } } as never,
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
			attempt: { contextRefs: [reference], effectiveProfile: { activity: 'acting' } } as never,
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
	it('materializes the published SDK Book from exact granted TreeDX custody', async () => {
		const commit = 'e'.repeat(40);
		const reference = { store: 'treedx', model: 'book', id: 'sdk-core', repository: 'sdk-library', commit, path: 'books/sdk-core.md' };
		const frontmatter = { schemaVersion: 'treeseed.book/v2', id: 'sdk-core', title: 'SDK Core', status: 'published' };
		const invoke = vi.fn(async () => ({ result: { result: { resolvedRef: commit, files: [{
			path: reference.path, requestedPath: reference.path, content: '# SDK Core', frontmatter,
		}] } } }));
		const context = await materializeAssignmentContext({ attempt: {
			contextRefs: [reference], grant: { contentRead: [reference] }, effectiveProfile: { activity: 'acting' },
		} as never, predecessorResults: [], treeDx: { projectId: 'sdk-project', repositoryId: 'sdk-library', workspaceId: null, invoke } as never });
		expect(context.context[0]).toMatchObject({ ref: reference, value: { frontmatter, content: '# SDK Core' } });
		expect(invoke).toHaveBeenCalledWith('treedx.repositories.files.read', expect.objectContaining({
			body: expect.objectContaining({ ref: commit, paths: ['books/sdk-core.md'] }),
		}));
	});
	it.each(['team', 'workday', 'digest', 'activity'])('rejects inline Reporter context with incorrect %s authority', async failure => {
		const ref = { store: 'postgresql', model: 'workday', id: 'workday', revision: 1, digest: `sha256:${'a'.repeat(64)}` };
		const value = { teamId: failure === 'team' ? 'another' : 'team', workdayId: failure === 'workday' ? 'another' : 'workday' };
		await expect(materializeAssignmentContext({ attempt: { contextRefs: [], sourceRef: ref, teamId: 'team', workdayId: 'workday',
			effectiveProfile: { activity: failure === 'activity' ? 'acting' : 'reporting' } } as never,
			predecessorResults: [], treeDx: {} as never, authorizedContext: [{ ref, mediaType: 'application/json', value,
				digest: failure === 'digest' ? ref.digest : `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}` }] }))
			.rejects.toThrow(/assignment_inline_context/u);
	});
	it('accepts PostgreSQL JSONB key reordering without weakening exact authority', async () => {
		const ref = { store: 'postgresql', model: 'workday', id: 'workday', revision: 1, digest: `sha256:${'a'.repeat(64)}` };
		const value = { teamId: 'team', workdayId: 'workday', nodes: [{ id: 'actor', status: 'completed' }] };
		const reordered = { nodes: [{ status: 'completed', id: 'actor' }], workdayId: 'workday', teamId: 'team' };
		const context = await materializeAssignmentContext({ attempt: { contextRefs: [ref], sourceRef: ref,
			teamId: 'team', workdayId: 'workday', effectiveProfile: { activity: 'reporting' } } as never,
			predecessorResults: [], treeDx: { invoke: vi.fn() } as never,
			authorizedContext: [{ ref: { digest: ref.digest, revision: 1, id: 'workday', model: 'workday', store: 'postgresql' },
				mediaType: 'application/json', value: reordered,
				digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}` }] });
		expect(context.context[0].value).toEqual(value);
	});
});
