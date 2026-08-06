import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callTreeDxProxyTool } from '../../../src/agents/tools/treedx-proxy-client.ts';
import {
	agentToolMcpName,
	createAgentToolMcpServer,
	createAgentToolMcpServerCommand,
} from '../../../src/agents/tools/agent-tool-mcp-server.ts';
import type { TreeDxProxyExecutionToolDescriptor } from '../../../src/agents/runtime/runtime-types.ts';

const descriptor: TreeDxProxyExecutionToolDescriptor = {
	kind: 'agent_tool',
	id: 'treedx.apply_workspace_changeset',
	name: 'Apply TreeDX workspace changeset',
	description: 'Assignment-scoped atomic TreeDX workspace changeset.',
	inputSchema: {
		type: 'object',
		properties: {
			contract: { type: 'string' }, baseCommitSha: { type: 'string' }, baseRef: { type: 'string' },
			patch: { type: 'string' }, patchSha256: { type: 'string' }, idempotencyKey: { type: 'string' },
		},
		required: ['contract', 'baseCommitSha', 'baseRef', 'patch', 'patchSha256', 'idempotencyKey'],
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
	metadata: {
		contentRoot: 'template/src/content',
		requiredArtifactKind: 'documentation_update',
		requireContentArtifact: true,
	},
	routes: {
		buildContext: 'POST /v1/dx/projects/project-1/repos/:repoId/context/build',
		readRepositoryFiles: 'POST /v1/dx/projects/project-1/repos/:repoId/files/read',
		searchWorkspace: 'POST /v1/dx/projects/project-1/workspaces/:workspaceId/search',
		readWorkspaceFile: 'GET /v1/dx/projects/project-1/workspaces/:workspaceId/files?path=:path',
		applyWorkspaceChangeset: 'POST /v1/dx/projects/project-1/workspaces/:workspaceId/changesets',
		commitWorkspace: 'POST /v1/dx/projects/project-1/workspaces/:workspaceId/commit',
	},
};

describe('agent tool MCP tooling', () => {
	it('creates an assignment-scoped command without embedding credentials in args', () => {
		const command = createAgentToolMcpServerCommand({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-secret',
			assignmentId: 'assignment-1',
			repoRoot: '/repo',
			telemetryPath: '/tmp/tools.jsonl',
			descriptors: [descriptor],
			researchSourcePolicy: {
				schemaVersion: 1,
				allowedDomains: ['sources.example.test'],
				requestTimeoutMs: 10_000,
				maxResponseBytes: 100_000,
				maxRedirects: 2,
				allowedContentTypes: ['text/*'],
			},
		});
		expect(command.command).toBe(process.execPath);
		expect(command.args.join(' ')).not.toContain('provider-secret');
		expect(command.env.TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN).toBe('provider-secret');
		expect(command.env.TREESEED_AGENT_TOOL_REPO_ROOT).toBe('/repo');
		expect(command.env.TREESEED_AGENT_TOOL_TELEMETRY_PATH).toBe('/tmp/tools.jsonl');
		expect(command.env.TREESEED_AGENT_TOOL_DESCRIPTORS).not.toContain('provider-secret');
		const transported = JSON.parse(command.env.TREESEED_AGENT_TOOL_DESCRIPTORS);
		expect(transported[0].metadata).toMatchObject({
			contentRoot: 'template/src/content',
			requiredArtifactKind: 'documentation_update',
			requireContentArtifact: true,
		});
		expect(JSON.parse(command.env.TREESEED_AGENT_TOOL_RESEARCH_SOURCE_POLICY)).toMatchObject({
			allowedDomains: ['sources.example.test'],
			maxRedirects: 2,
		});
	});

	it('calls an atomic workspace changeset through the API proxy with assignment headers', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-secret',
			assignmentId: 'assignment-1',
			handleId: 'handle-1',
			descriptor,
			toolName: 'treedx.apply_workspace_changeset',
			input: { contract: 'treedx.changeset/v1', baseCommitSha: 'abc123', baseRef: 'refs/heads/main', patch: 'patch', patchSha256: 'digest', idempotencyKey: 'changeset-1' },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.example.test/v1/dx/projects/project-1/workspaces/workspace-1/changesets',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					authorization: 'Bearer provider-secret',
					'x-treeseed-assignment-id': 'assignment-1',
					'x-treeseed-treedx-proxy-handle-id': 'handle-1',
				}),
			}),
		);
	});

	it('bounds context packs below the control-plane response ceiling by default', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { nodes: [] } }), { status: 200 }));
		await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-secret', assignmentId: 'assignment-1',
			handleId: 'handle-1', descriptor, toolName: 'treedx.build_context', input: { query: 'guide architecture' },
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(request.body))).toEqual({ query: 'guide architecture', budget: { maxNodes: 16, maxTokens: 4000 } });
	});

	it('pages repository reads below the control-plane response ceiling', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ file: { content: 'bounded' } }), { status: 200 }));
		await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-secret', assignmentId: 'assignment-1',
			handleId: 'handle-1', descriptor, toolName: 'treedx.read_repository_files',
			input: { paths: ['src/content/a.mdx'], offsetBytes: 42 }, fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(request.body))).toEqual({
			paths: ['src/content/a.mdx'], maxBytes: 131_072, offsetBytes: 42,
		});
	});

	it('retries transient assignment-scoped TreeDX reads without retrying mutations', async () => {
		const readFetch = vi.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValue(new Response(JSON.stringify({ ok: true, payload: { content: 'recovered' } }), { status: 200 }));
		await expect(callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-secret', assignmentId: 'assignment-1',
			handleId: 'handle-1', descriptor, toolName: 'treedx.read_workspace_file', input: { path: 'src/content/a.mdx' },
			fetchImpl: readFetch as unknown as typeof fetch,
		})).resolves.toMatchObject({ ok: true });
		expect(readFetch).toHaveBeenCalledTimes(2);

		const writeFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		await expect(callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-secret', assignmentId: 'assignment-1',
			handleId: 'handle-1', descriptor, toolName: 'treedx.apply_workspace_changeset', input: { path: 'src/content/a.mdx', content: 'body' },
			fetchImpl: writeFetch as unknown as typeof fetch,
		})).rejects.toThrow('fetch failed');
		expect(writeFetch).toHaveBeenCalledTimes(1);
	});

	it('fans multi-file repository reads into independently bounded requests', async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ ok: true, payload: { files: [{ path: body.paths[0] }] } }), { status: 200 });
		});
		const response = await callTreeDxProxyTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-secret', assignmentId: 'assignment-1',
			handleId: 'handle-1', descriptor, toolName: 'treedx.read_repository_files',
			input: { paths: ['src/content/a.mdx', 'src/content/b.mdx'] }, fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect((response as { payload: { files: unknown[] } }).payload.files).toEqual([
			{ path: 'src/content/a.mdx' }, { path: 'src/content/b.mdx' },
		]);
	});

	it('serves allowed tools through a standards-compliant MCP connection', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { path: 'src/content/a.mdx' } }), { status: 200 }));
		const telemetry: unknown[] = [];
		const server = createAgentToolMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-secret',
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
			expect(tools.tools.map((tool) => tool.name)).toEqual(['treedx_apply_workspace_changeset']);
			expect(agentToolMcpName('treedx.apply_workspace_changeset')).toBe('treedx_apply_workspace_changeset');

			const result = await client.callTool({
				name: 'treedx_apply_workspace_changeset',
				arguments: { contract: 'treedx.changeset/v1', baseCommitSha: 'abc123', baseRef: 'refs/heads/main', patch: 'patch', patchSha256: 'digest', idempotencyKey: 'changeset-1' },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({ ok: true, payload: { path: 'src/content/a.mdx' } });
			expect(telemetry).toEqual(expect.arrayContaining([
				expect.objectContaining({ toolId: 'treedx.apply_workspace_changeset', status: 'started' }),
				expect.objectContaining({ toolId: 'treedx.apply_workspace_changeset', status: 'completed' }),
			]));
		} finally {
			await client.close();
		}
	});

	it('returns structured validation errors for invalid tool input', async () => {
		const server = createAgentToolMcpServer({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-secret',
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
				name: 'treedx.apply_workspace_changeset',
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
			providerAccessToken: 'provider-secret',
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
			const result = await client.callTool({ name: 'treedx.apply_workspace_changeset', arguments: {} });
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
