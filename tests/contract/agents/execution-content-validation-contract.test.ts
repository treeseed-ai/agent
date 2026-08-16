import { renderContentRecord } from '@treeseed/sdk/content-operations';
import { describe,expect,it,vi } from 'vitest';
import { callContentTool } from '../../../src/agents/tools/content-tool-runtime.ts';

describe('execution content validation contract',()=>{
	it('validates the existing record at an exact hierarchical placement', async () => {
		const urls: string[] = [];
		const objective = renderContentRecord({ model: 'objective', slug: 'core', title: 'Core', body: 'Objective.' });
		const existing = renderContentRecord({
			model: 'note', title: 'Technical review plan', body: 'Review body.',
			relations: [{ field: 'relatedObjectives', targetSlug: 'objective:core' }],
		});
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a',
				assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read', 'files:search'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path', searchWorkspace: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/search' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note',
				placement: { path: 'src/content/notes/editorial/books/treeseed-guide/reviews/technical-review-plan.mdx' },
			},
			fetchImpl: (async (url) => {
				urls.push(String(url));
				const value = String(url);
				if (value.includes('/search')) return Response.json({ ok: true, payload: { results: [
					{ path: 'src/content/objectives/core.mdx' },
					{ path: 'src/content/agent-tests/guide-editorial-cycle.mdx' },
				] } });
				return new Response(JSON.stringify({ ok: true, payload: { content: value.includes('objectives%2Fcore') ? objective.content : existing.content } }), {
					status: 200, headers: { 'content-type': 'application/json' },
				});
			}) as typeof fetch,
		});
		expect(result).toMatchObject({
			ok: true,
			refs: [{ path: 'src/content/notes/editorial/books/treeseed-guide/reviews/technical-review-plan.mdx' }],
		});
		expect(urls).toHaveLength(3);
		expect(urls.some((url) => url.includes('agent-tests'))).toBe(false);
	});
	it('validates persisted relations from an exact existing record when the request only repeats identity and relations', async () => {
		const existing = renderContentRecord({
			model: 'note', title: 'Workday report', body: 'Durable report body.',
			relations: [{ field: 'relatedObjectives', targetSlug: 'objective:core' }],
		});
		const objective = renderContentRecord({ model: 'objective', slug: 'core', title: 'Core', body: 'Objective.' });
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const value = String(url);
			if (value.includes('/search')) return Response.json({ ok: true, payload: { results: [{ path: 'src/content/objectives/core.mdx' }] } });
			return Response.json({ ok: true, payload: { content: value.includes('objectives%2Fcore') ? objective.content : existing.content } });
		});
		const path = 'src/content/notes/editorial/books/treeseed-guide/reports/workday-report.mdx';
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read', 'files:search'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path', searchWorkspace: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/search' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note', id: 'note:workday-report', slug: 'workday-report', placement: { path },
				relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'core' }],
			},
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, refs: [{ path }] });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ query: 'objective:core' });
	});
	it('preflights a proposed record at an exact placement against its current relation target', async () => {
		const path = 'src/content/notes/editorial/books/treeseed-guide/reviews/proposed-review.mdx';
		const objective = renderContentRecord({ model: 'objective', slug: 'core', title: 'Core', body: 'Objective.' });
		const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('/search')
			? Response.json({ ok: true, payload: { results: [{ path: 'src/content/objectives/core.mdx' }] } })
			: Response.json({ ok: true, payload: { content: objective.content } }));
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read', 'files:search'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path', searchWorkspace: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/search' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note', title: 'Proposed technical review', body: 'Review body.',
				relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'objective:core' }],
				placement: { path },
			},
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, refs: [expect.objectContaining({ path })] });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ query: 'objective:core' });
	});
	it('rejects a guessed hierarchical relation id when the current target has a different canonical identity', async () => {
		const path = 'src/content/notes/editorial/books/treeseed-guide/evidence/core-evidence.mdx';
		const question = renderContentRecord({ model: 'question', slug: 'core-evidence-question', title: 'Core evidence question', body: 'Question.' });
		const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('/search')
			? Response.json({ ok: true, payload: { results: [{ path: 'src/content/questions/core-evidence-question.mdx' }] } })
			: Response.json({ ok: true, payload: { content: question.content } }));
		const result = await callContentTool({ apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: { id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a', allowedOperations: ['files:read','files:search'], allowedPaths: ['src/content/**'], routes: { readWorkspaceFile: 'GET /files?path=:path', searchWorkspace: 'POST /search' }, metadata: { contentAction: 'validate', contentRoot: 'src/content' } } as never,
			input: { model: 'note', title: 'Core evidence', body: 'Evidence.', fields: { related_questions: ['question:editorial:treeseed-guide:core-evidence-question'] }, placement: { path } }, fetchImpl: fetchImpl as typeof fetch });
		expect(result).toMatchObject({ ok: false, code: 'content_relation_invalid', metadata: { diagnostics: [expect.objectContaining({ code: 'content_relation_target_mismatch', targetId: 'question:editorial:treeseed-guide:core-evidence-question' })] } });
	});
});
