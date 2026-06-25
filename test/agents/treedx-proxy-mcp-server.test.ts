import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callTreeDxProxyTool } from '../../src/agents/tools/treedx-proxy-client.ts';
import {
	createTreeDxProxyMcpServer,
	createTreeDxProxyMcpServerCommand,
} from '../../src/agents/tools/treedx-proxy-mcp-server.ts';
import type { TreeDxProxyExecutionToolDescriptor } from '../../src/agents/runtime-types.ts';

const descriptor: TreeDxProxyExecutionToolDescriptor = {
	kind: 'treedx_proxy',
	id: 'treedx-proxy:handle-1',
	name: 'TreeDX assignment proxy',
	description: 'Assignment-scoped TreeDX proxy.',
	operations: ['files:read', 'files:write', 'git:commit'],
	projectId: 'project-1',
	assignmentId: 'assignment-1',
	handleId: 'handle-1',
	repositoryId: 'repo-1',
	workspaceId: 'workspace-1',
	allowedOperations: ['files:read', 'files:write', 'git:commit'],
	allowedPaths: ['src/content/**'],
	routes: {
		buildContext: 'POST /v1/dx/projects/project-1/repos/:repoId/context/build',
		readRepositoryFiles: 'POST /v1/dx/projects/project-1/repos/:repoId/files/read',
		searchWorkspace: 'POST /v1/dx/projects/project-1/workspaces/:workspaceId/search',
		readWorkspaceFile: 'GET /v1/dx/projects/project-1/workspaces/:workspaceId/files?path=:path',
		writeWorkspaceFile: 'PUT /v1/dx/projects/project-1/workspaces/:workspaceId/files?path=:path',
		commitWorkspace: 'POST /v1/dx/projects/project-1/workspaces/:workspaceId/commit',
	},
};

describe('TreeDX proxy MCP tooling', () => {
	it('creates an assignment-scoped command without embedding credentials in args', () => {
		const command = createTreeDxProxyMcpServerCommand({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
		});
		expect(command.command).toBe(process.execPath);
		expect(command.args.join(' ')).not.toContain('provider-secret');
		expect(command.env.TREESEED_CAPACITY_PROVIDER_API_KEY).toBe('provider-secret');
		expect(command.env.TREESEED_TREEDX_PROXY_DESCRIPTOR).not.toContain('provider-secret');
	});

	it('calls workspace write through the API proxy with assignment headers', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
			toolName: 'treedx_write_workspace_file',
			input: { path: 'src/content/a.mdx', content: 'body' },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.example.test/v1/dx/projects/project-1/workspaces/workspace-1/files?path=src%2Fcontent%2Fa.mdx',
			expect.objectContaining({
				method: 'PUT',
				headers: expect.objectContaining({
					authorization: 'Bearer provider-secret',
					'x-treeseed-assignment-id': 'assignment-1',
					'x-treeseed-treedx-proxy-handle-id': 'handle-1',
				}),
			}),
		);
	});

	it('rejects disallowed paths before fetch', async () => {
		const fetchImpl = vi.fn();
		await expect(callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
			toolName: 'treedx_write_workspace_file',
			input: { path: 'private/a.mdx', content: 'body' },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})).rejects.toThrow(/path denied/u);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('serves TreeDX tools through a standards-compliant MCP connection', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		const server = createTreeDxProxyMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const client = new Client({ name: 'treeseed-test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toContain('treedx_write_workspace_file');

			const result = await client.callTool({
				name: 'treedx_write_workspace_file',
				arguments: { path: 'src/content/a.mdx', content: 'body' },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({ ok: true, payload: { path: 'src/content/a.mdx' } });
			expect(fetchImpl).toHaveBeenCalledWith(
				'https://api.example.test/v1/dx/projects/project-1/workspaces/workspace-1/files?path=src%2Fcontent%2Fa.mdx',
				expect.objectContaining({ method: 'PUT' }),
			);
		} finally {
			await client.close();
		}
	});
});
