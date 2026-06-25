import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TreeDxProxyExecutionToolDescriptor } from '../runtime-types.ts';
import {
	TREE_DX_PROXY_TOOL_INPUT_SCHEMAS,
	TREE_DX_PROXY_TOOL_NAMES,
	type TreeDxProxyToolName,
} from './treedx-proxy-tool.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';

export interface TreeDxProxyMcpServerOptions {
	apiBaseUrl: string;
	providerApiKey: string;
	assignmentId: string;
	handleId: string;
	descriptor: TreeDxProxyExecutionToolDescriptor;
	fetchImpl?: typeof fetch;
}

export function createTreeDxProxyMcpServerCommand(options: TreeDxProxyMcpServerOptions): {
	command: string;
	args: string[];
	env: Record<string, string>;
} {
	const modulePath = fileURLToPath(import.meta.url);
	const args = modulePath.endsWith('.ts')
		? ['--import', 'tsx', modulePath]
		: [modulePath];
	return {
		command: process.execPath,
		args,
		env: {
			TREESEED_API_BASE_URL: options.apiBaseUrl,
			TREESEED_CAPACITY_PROVIDER_API_KEY: options.providerApiKey,
			TREESEED_TREEDX_PROXY_ASSIGNMENT_ID: options.assignmentId,
			TREESEED_TREEDX_PROXY_HANDLE_ID: options.handleId,
			TREESEED_TREEDX_PROXY_DESCRIPTOR: JSON.stringify(options.descriptor),
		},
	};
}

function descriptorFromEnv(): TreeDxProxyExecutionToolDescriptor {
	return JSON.parse(process.env.TREESEED_TREEDX_PROXY_DESCRIPTOR ?? '{}');
}

export function createTreeDxProxyMcpServer(options?: Partial<TreeDxProxyMcpServerOptions>) {
	const descriptor = options?.descriptor ?? descriptorFromEnv();
	const apiBaseUrl = options?.apiBaseUrl ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_MARKET_URL ?? '';
	const providerApiKey = options?.providerApiKey ?? process.env.TREESEED_CAPACITY_PROVIDER_API_KEY ?? process.env.TREESEED_PROVIDER_API_KEY ?? '';
	const assignmentId = options?.assignmentId ?? process.env.TREESEED_TREEDX_PROXY_ASSIGNMENT_ID ?? descriptor.assignmentId ?? '';
	const handleId = options?.handleId ?? process.env.TREESEED_TREEDX_PROXY_HANDLE_ID ?? descriptor.handleId ?? '';

	const server = new Server(
		{ name: 'treedx-proxy', version: '1.0.0' },
		{
			capabilities: { tools: {} },
			instructions: 'Assignment-scoped TreeDX content access for a single TreeSeed provider assignment.',
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TREE_DX_PROXY_TOOL_NAMES.map((name) => ({
			name,
			description: 'Assignment-scoped TreeDX proxy tool.',
			inputSchema: TREE_DX_PROXY_TOOL_INPUT_SCHEMAS[name] as {
				type: 'object';
				properties?: Record<string, object>;
				required?: string[];
			},
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const toolName = request.params.name as TreeDxProxyToolName;
		const input = request.params.arguments ?? {};
		try {
			const result = await callTreeDxProxyTool({
				apiBaseUrl,
				providerApiKey,
				assignmentId,
				handleId,
				descriptor,
				toolName,
				input,
				fetchImpl: options?.fetchImpl,
			});
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
				structuredContent: result,
			};
		} catch (error) {
			return {
				content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			};
		}
	});
	return server;
}

export async function startTreeDxProxyMcpServer(options?: Partial<TreeDxProxyMcpServerOptions>) {
	const server = createTreeDxProxyMcpServer(options);
	await server.connect(new StdioServerTransport());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void startTreeDxProxyMcpServer();
}
