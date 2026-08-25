import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssignmentTreeDxFacade } from '../../src/provider/coordination/assignment-treedx.ts';

afterEach(() => vi.unstubAllGlobals());

describe('assignment-scoped TreeDX facade', () => {
	it('fixes project and proxy-handle authority while invoking only SDK catalog operations', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'workspace-1' } }), {
			status: 200, headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchImpl);
		const facade = await createAssignmentTreeDxFacade({
			controlPlaneUrl: 'https://api.example.test', accessToken: 'provider-token',
		}, {
			id: 'assignment-1', projectId: 'project-1',
			treedxProxyHandle: { id: 'handle-1', token: 'handle-token', repositoryId: 'repo-1', workspaceId: 'workspace-1' },
		});
		await facade.invoke('treedx.workspaces.show', { path: { projectId: 'other-project', workspaceId: 'workspace-1' }, query: {}, body: undefined });
		const [request, init] = fetchImpl.mock.calls[0]!;
		expect(String(request)).toBe('https://api.example.test/v1/dx/projects/project-1/workspaces/workspace-1');
		expect(new Headers(init?.headers)).toMatchObject(expect.any(Headers));
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-token');
		expect(new Headers(init?.headers).get('x-treeseed-assignment-id')).toBe('assignment-1');
		expect(new Headers(init?.headers).get('x-treeseed-treedx-proxy-handle-id')).toBe('handle-1');
		expect(new Headers(init?.headers).get('x-treeseed-treedx-proxy-handle')).toBe('handle-token');
		await expect(facade.invoke('treedx.not.catalogued', {})).rejects.toThrow(/not part of the accepted SDK catalog/u);
	});

	it('rejects assignment admission without a project-scoped proxy handle', async () => {
		await expect(createAssignmentTreeDxFacade({ controlPlaneUrl: 'https://api.example.test', accessToken: 'provider-token' }, {
			id: 'assignment-1', projectId: 'project-1',
		})).rejects.toThrow(/requires an active project-scoped TreeDX proxy handle/u);
	});
});
