import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
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
	const modulePath = fileURLToPath(import.meta.url).replace(/\.ts$/u, '.js');
	return {
		command: process.execPath,
		args: [modulePath],
		env: {
			TREESEED_API_BASE_URL: options.apiBaseUrl,
			TREESEED_CAPACITY_PROVIDER_API_KEY: options.providerApiKey,
			TREESEED_TREEDX_PROXY_ASSIGNMENT_ID: options.assignmentId,
			TREESEED_TREEDX_PROXY_HANDLE_ID: options.handleId,
			TREESEED_TREEDX_PROXY_DESCRIPTOR: JSON.stringify(options.descriptor),
		},
	};
}

function send(id: unknown, result?: unknown, error?: unknown) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result, error })}\n`);
}

function descriptorFromEnv(): TreeDxProxyExecutionToolDescriptor {
	return JSON.parse(process.env.TREESEED_TREEDX_PROXY_DESCRIPTOR ?? '{}');
}

export async function startTreeDxProxyMcpServer(options?: Partial<TreeDxProxyMcpServerOptions>) {
	const descriptor = options?.descriptor ?? descriptorFromEnv();
	const apiBaseUrl = options?.apiBaseUrl ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_MARKET_URL ?? '';
	const providerApiKey = options?.providerApiKey ?? process.env.TREESEED_CAPACITY_PROVIDER_API_KEY ?? process.env.TREESEED_PROVIDER_API_KEY ?? '';
	const assignmentId = options?.assignmentId ?? process.env.TREESEED_TREEDX_PROXY_ASSIGNMENT_ID ?? descriptor.assignmentId ?? '';
	const handleId = options?.handleId ?? process.env.TREESEED_TREEDX_PROXY_HANDLE_ID ?? descriptor.handleId ?? '';
	const rl = createInterface({ input: process.stdin });
	rl.on('line', (line) => {
		void (async () => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			const id = message.id;
			if (message.method === 'initialize') {
				send(id, {
					protocolVersion: '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'treedx-proxy', version: '1.0.0' },
				});
				return;
			}
			if (message.method === 'tools/list') {
				send(id, {
					tools: TREE_DX_PROXY_TOOL_NAMES.map((name) => ({
						name,
						description: 'Assignment-scoped TreeDX proxy tool.',
						inputSchema: TREE_DX_PROXY_TOOL_INPUT_SCHEMAS[name],
					})),
				});
				return;
			}
			if (message.method === 'tools/call') {
				const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
				const toolName = String(params.name ?? '') as TreeDxProxyToolName;
				const input = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
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
					send(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
				} catch (error) {
					send(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
				}
				return;
			}
			if (id !== undefined) send(id, {});
		})();
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void startTreeDxProxyMcpServer();
}
