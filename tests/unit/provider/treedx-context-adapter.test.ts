import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssignmentTreeDxAdapter } from '../../../src/provider/treedx/graph/treedx-context-adapter.ts';
import type { ProviderConnectionRuntimeContext } from '../../../src/provider/configuration/config.ts';

afterEach(() => vi.unstubAllGlobals());

describe('assignment TreeDX context adapter', () => {
	it('retries a transient transport failure against the same authoritative path', async () => {
		const fetchMock = vi.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(new Response(JSON.stringify({ payload: { file: { path: 'src/content/agents/editorial/guide-steward.mdx', content: 'agent' } } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createAssignmentTreeDxAdapter({
			config: { marketUrl: 'http://api.test', accessToken: 'secret' } as ProviderConnectionRuntimeContext,
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', status: 'issued', allowedOperations: ['files:read'], allowedPaths: ['**'],
			},
		});
		const result = await adapter?.readRepositoryFiles({ repoId: 'repo-1', paths: ['src/content/agents/editorial/guide-steward.mdx'] });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).path)).toEqual([
			'src/content/agents/editorial/guide-steward.mdx',
			'src/content/agents/editorial/guide-steward.mdx',
		]);
		expect(result?.files).toHaveLength(1);
	});

	it('does not retry a missing path', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'File not found.' } }), {
			status: 404,
			headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createAssignmentTreeDxAdapter({
			config: { marketUrl: 'http://api.test', accessToken: 'secret' } as ProviderConnectionRuntimeContext,
			projectId: 'project-1', assignmentId: 'assignment-1',
			treedxProxyHandle: { id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1', repositoryId: 'repo-1', status: 'issued', allowedOperations: ['files:read'], allowedPaths: ['**'] },
		});
		await expect(adapter?.readRepositoryFiles({ repoId: 'repo-1', paths: ['missing.mdx'] })).rejects.toThrow(/404/u);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('bounds internally assembled context packs before proxy transport', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload: { nodes: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createAssignmentTreeDxAdapter({
			config: { marketUrl: 'http://api.test', accessToken: 'secret' } as ProviderConnectionRuntimeContext,
			projectId: 'project-1', assignmentId: 'assignment-1',
			treedxProxyHandle: { id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1', repositoryId: 'repo-1', status: 'issued', allowedOperations: ['files:read'], allowedPaths: ['**'] },
		});
		await adapter?.buildContext({ repoId: 'repo-1', query: 'guide', body: { limit: 24, format: 'full' } });
		const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(sent).toMatchObject({ query: 'guide', limit: 24, format: 'full', budget: { maxNodes: 8, maxTokens: 1800 } });
	});
});
