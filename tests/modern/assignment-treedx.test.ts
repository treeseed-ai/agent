import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createAssignmentTreeDxFacade } from '../../src/provider/coordination/assignment-treedx.ts';

afterEach(() => vi.unstubAllGlobals());

async function proxyBoundary(status: number, run: (url: string, requests: IncomingMessage[]) => Promise<void>) {
	const requests: IncomingMessage[] = [];
	const server = createServer((request, response) => {
		requests.push(request);
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(JSON.stringify(status === 200 ? { data: { id: 'workspace-http' } } : { error: { message: 'fixture denied' } }));
	});
	server.requestTimeout = 2_000;
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
	try { await run(`http://127.0.0.1:${address.port}`, requests); }
	finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

const assignedHandle = () => ({ id: 'assignment-http', projectId: 'yaml-project', agentClass: 'custom-yaml-worker',
	treedxProxyHandle: { id: 'handle-http', token: 'fixture-handle', repositoryId: 'repo-http', workspaceId: 'workspace-http', baseRef: 'a'.repeat(40) } });
const workspaceInput = (projectId: string) => ({ path: { projectId, workspaceId: 'workspace-http' }, query: {}, body: undefined });

describe('assignment-scoped TreeDX facade', () => {
	it('uses the real SDK HTTP boundary with configured identity and exact assignment authority', async () => {
		await proxyBoundary(200, async (url, requests) => {
			const facade = await createAssignmentTreeDxFacade({ controlPlaneUrl: url, accessToken: 'fixture-provider' }, assignedHandle());
			expect(await facade.invoke('treedx.workspaces.show', workspaceInput('ungranted-project'), { signal: AbortSignal.timeout(2_000) })).toMatchObject({ data: { id: 'workspace-http' } });
			expect(requests).toHaveLength(1);
			expect(requests[0]!.url).toBe('/v1/dx/projects/yaml-project/workspaces/workspace-http');
			expect(requests[0]!.headers).toMatchObject({ authorization: 'Bearer fixture-provider', 'x-treeseed-assignment-id': 'assignment-http', 'x-treeseed-treedx-proxy-handle-id': 'handle-http', 'x-treeseed-treedx-proxy-handle': 'fixture-handle' });
		});
	}, 5_000);
	it('propagates actual HTTP proxy denial without retrying or fabricating content', async () => {
		await proxyBoundary(403, async (url, requests) => {
			const facade = await createAssignmentTreeDxFacade({ controlPlaneUrl: url, accessToken: 'fixture-provider' }, assignedHandle());
			await expect(facade.invoke('treedx.workspaces.show', workspaceInput('yaml-project'), { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
			expect(requests).toHaveLength(1);
		});
	}, 5_000);
	it('rejects missing handles and unknown operations before any real HTTP side effect', async () => {
		await proxyBoundary(200, async (url, requests) => {
			await expect(createAssignmentTreeDxFacade({ controlPlaneUrl: url, accessToken: 'fixture-provider' }, { id: 'assignment-http', projectId: 'yaml-project' })).rejects.toThrow('requires an active project-scoped TreeDX proxy handle');
			const facade = await createAssignmentTreeDxFacade({ controlPlaneUrl: url, accessToken: 'fixture-provider' }, assignedHandle());
			await expect(facade.invoke('treedx.unknown', {})).rejects.toThrow('not part of the accepted SDK catalog');
			expect(requests).toEqual([]);
		});
	}, 5_000);
	it('fixes project and proxy-handle authority while invoking only SDK catalog operations', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: { id: 'workspace-1' } }), {
			status: 200, headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchImpl);
		const facade = await createAssignmentTreeDxFacade({
			controlPlaneUrl: 'https://api.example.test', accessToken: 'provider-token',
		}, {
			id: 'assignment-1', projectId: 'project-1',
			treedxProxyHandle: { id: 'handle-1', token: 'handle-token', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1' },
		});
		expect(facade.handleId).toBe('handle-1');
		expect(facade.baseRef).toBe('commit-1');
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
