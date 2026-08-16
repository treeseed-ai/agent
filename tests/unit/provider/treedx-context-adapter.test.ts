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
			treedxProxyHandle: { id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1', repositoryId: 'repo-1', baseCommitSha: 'a'.repeat(40), status: 'issued', allowedOperations: ['files:read'], allowedPaths: ['**'] },
		});
		await adapter?.buildContext({ repoId: 'repo-1', query: 'guide', body: { limit: 24, format: 'full' } });
		const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(sent).toMatchObject({ query: 'guide', ref:'a'.repeat(40), limit: 24, format: 'full', budget: { maxNodes: 8, maxTokens: 1800 } });
	});

	it('defaults repository reads and listings to immutable assignment custody while preserving an explicit ref', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload: { files: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createAssignmentTreeDxAdapter({
			config:{marketUrl:'http://api.test',accessToken:'secret'} as ProviderConnectionRuntimeContext,projectId:'project-1',assignmentId:'assignment-1',
			treedxProxyHandle:{id:'handle-1',teamId:'team-1',projectId:'project-1',assignmentId:'assignment-1',repositoryId:'repo-1',baseCommitSha:'b'.repeat(40),status:'issued',allowedOperations:['files:read'],allowedPaths:['**']},
		});
		await adapter?.readRepositoryFiles({repoId:'repo-1',paths:['template.mdx']});
		await adapter?.listRepositoryPaths?.({repoId:'repo-1',path:'src/content',ref:'c'.repeat(40)});
		expect(fetchMock.mock.calls.map((call)=>JSON.parse(String(call[1]?.body)).ref)).toEqual(['b'.repeat(40),'c'.repeat(40)]);
	});

	it('resolves a current provider access token for every TreeDX request', async () => {
		const accessTokenProvider = vi.fn()
			.mockResolvedValueOnce('token-before-refresh')
			.mockResolvedValueOnce('token-after-refresh');
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload: {} }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createAssignmentTreeDxAdapter({
			config: { marketUrl: 'http://api.test', accessToken: 'expired', accessTokenProvider } as ProviderConnectionRuntimeContext,
			projectId: 'project-1', assignmentId: 'assignment-1',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', status: 'issued',
				allowedOperations: ['files:read', 'workspace:write'], allowedPaths: ['**'],
			},
		});
		await adapter?.readRepositoryFiles({ repoId: 'repo-1', paths: ['src/content/objectives/core.mdx'] });
		await adapter?.closeWorkspace({ workspaceId: 'workspace-1' });
		expect(accessTokenProvider).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization'))).toEqual([
			'Bearer token-before-refresh',
			'Bearer token-after-refresh',
		]);
	});
});
