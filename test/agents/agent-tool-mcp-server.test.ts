import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callTreeDxProxyTool } from '../../src/agents/tools/treedx-proxy-client.ts';
import {
	agentToolMcpName,
	createAgentToolMcpServer,
	createAgentToolMcpServerCommand,
} from '../../src/agents/tools/agent-tool-mcp-server.ts';
import type { TreeDxProxyExecutionToolDescriptor } from '../../src/agents/runtime-types.ts';

const descriptor: TreeDxProxyExecutionToolDescriptor = {
	kind: 'agent_tool',
	id: 'treedx.write_workspace_file',
	name: 'Write TreeDX workspace file',
	description: 'Assignment-scoped TreeDX workspace write.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			content: { type: 'string' },
		},
		required: ['path', 'content'],
		additionalProperties: false,
	},
	executionTarget: 'treedx_proxy',
	mutability: 'content_write',
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

describe('agent tool MCP tooling', () => {
	it('creates an assignment-scoped command without embedding credentials in args', () => {
		const command = createAgentToolMcpServerCommand({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			repoRoot: '/repo',
			telemetryPath: '/tmp/tools.jsonl',
			descriptors: [descriptor],
		});
		expect(command.command).toBe(process.execPath);
		expect(command.args.join(' ')).not.toContain('provider-secret');
		expect(command.env.TREESEED_CAPACITY_PROVIDER_API_KEY).toBe('provider-secret');
		expect(command.env.TREESEED_AGENT_TOOL_REPO_ROOT).toBe('/repo');
		expect(command.env.TREESEED_AGENT_TOOL_TELEMETRY_PATH).toBe('/tmp/tools.jsonl');
		expect(command.env.TREESEED_AGENT_TOOL_DESCRIPTORS).not.toContain('provider-secret');
	});

	it('calls workspace write through the API proxy with assignment headers', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
			toolName: 'treedx.write_workspace_file',
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

	it('serves allowed tools through a standards-compliant MCP connection', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		const telemetry: unknown[] = [];
		const server = createAgentToolMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			descriptors: [descriptor],
			fetchImpl: fetchImpl as unknown as typeof fetch,
			onTelemetry: (entry) => telemetry.push(entry),
		});
		const client = new Client({ name: 'treeseed-test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toEqual(['treedx_write_workspace_file']);
			expect(agentToolMcpName('treedx.write_workspace_file')).toBe('treedx_write_workspace_file');

			const result = await client.callTool({
				name: 'treedx_write_workspace_file',
				arguments: { path: 'src/content/a.mdx', content: 'body' },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({ ok: true, payload: { path: 'src/content/a.mdx' } });
			expect(telemetry).toEqual(expect.arrayContaining([
				expect.objectContaining({ toolId: 'treedx.write_workspace_file', status: 'started' }),
				expect.objectContaining({ toolId: 'treedx.write_workspace_file', status: 'completed' }),
			]));
		} finally {
			await client.close();
		}
	});

	it('returns structured validation errors for invalid tool input', async () => {
		const server = createAgentToolMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			descriptors: [descriptor],
		});
		const client = new Client({ name: 'treeseed-test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const result = await client.callTool({
				name: 'treedx.write_workspace_file',
				arguments: { path: 'src/content/a.mdx' },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ ok: false, code: 'invalid_tool_input' });
		} finally {
			await client.close();
		}
	});

	it('rejects tools not included in the assignment catalog', async () => {
		const server = createAgentToolMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerApiKey: 'provider-secret',
			assignmentId: 'assignment-1',
			descriptors: [],
		});
		const client = new Client({ name: 'treeseed-test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const result = await client.callTool({ name: 'treedx.write_workspace_file', arguments: {} });
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({ ok: false, code: 'tool_not_allowed' });
		} finally {
			await client.close();
		}
	});

	it('uses an empty catalog when descriptor env JSON is malformed', async () => {
		const previous = process.env.TREESEED_AGENT_TOOL_DESCRIPTORS;
		process.env.TREESEED_AGENT_TOOL_DESCRIPTORS = '{malformed';
		try {
			const server = createAgentToolMcpServer();
			const client = new Client({ name: 'treeseed-test-client', version: '1.0.0' });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await Promise.all([
				server.connect(serverTransport),
				client.connect(clientTransport),
			]);
			try {
				const tools = await client.listTools();
				expect(tools.tools).toEqual([]);
			} finally {
				await client.close();
			}
		} finally {
			if (previous === undefined) delete process.env.TREESEED_AGENT_TOOL_DESCRIPTORS;
			else process.env.TREESEED_AGENT_TOOL_DESCRIPTORS = previous;
		}
	});
});
