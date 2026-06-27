import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ExecutionProviderToolDescriptor } from '../runtime-types.ts';
import { callAgentToolWithTelemetry, type AgentToolRuntimeOptions } from './agent-tool-runtime.ts';

export interface AgentToolMcpServerOptions extends AgentToolRuntimeOptions {}

export function agentToolMcpName(toolId: string) {
	return toolId.replace(/[^A-Za-z0-9_-]/gu, '_');
}

export function createAgentToolMcpServerCommand(options: AgentToolMcpServerOptions): {
	command: string;
	args: string[];
	env: Record<string, string>;
} {
	const modulePath = fileURLToPath(import.meta.url);
	const require = createRequire(import.meta.url);
	const args = modulePath.endsWith('.ts')
		? ['--import', require.resolve('tsx'), modulePath]
		: [modulePath];
	return {
		command: process.execPath,
		args,
		env: {
			TREESEED_API_BASE_URL: options.apiBaseUrl,
			TREESEED_CAPACITY_PROVIDER_API_KEY: options.providerApiKey,
			TREESEED_AGENT_TOOL_ASSIGNMENT_ID: options.assignmentId,
			TREESEED_AGENT_TOOL_LEASE_TOKEN: options.leaseToken ?? '',
			TREESEED_AGENT_TOOL_REPO_ROOT: options.repoRoot ?? '',
			TREESEED_AGENT_TOOL_TELEMETRY_PATH: options.telemetryPath ?? '',
			TREESEED_AGENT_TOOL_DESCRIPTORS: JSON.stringify(options.descriptors),
		},
	};
}

function descriptorsFromEnv(): ExecutionProviderToolDescriptor[] {
	try {
		const parsed = JSON.parse(process.env.TREESEED_AGENT_TOOL_DESCRIPTORS ?? '[]');
		return Array.isArray(parsed) ? parsed as ExecutionProviderToolDescriptor[] : [];
	} catch {
		return [];
	}
}

export function createAgentToolMcpServer(options?: Partial<AgentToolMcpServerOptions>) {
	const descriptors = options?.descriptors ?? descriptorsFromEnv();
	const apiBaseUrl = options?.apiBaseUrl ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_MARKET_URL ?? '';
	const providerApiKey = options?.providerApiKey ?? process.env.TREESEED_CAPACITY_PROVIDER_API_KEY ?? process.env.TREESEED_PROVIDER_API_KEY ?? '';
	const assignmentId = options?.assignmentId ?? process.env.TREESEED_AGENT_TOOL_ASSIGNMENT_ID ?? '';
	const leaseToken = options?.leaseToken ?? process.env.TREESEED_AGENT_TOOL_LEASE_TOKEN ?? null;
	const repoRoot = options?.repoRoot ?? process.env.TREESEED_AGENT_TOOL_REPO_ROOT ?? undefined;
	const telemetryPath = options?.telemetryPath ?? process.env.TREESEED_AGENT_TOOL_TELEMETRY_PATH ?? null;

	const server = new Server(
		{ name: 'treeseed-tools', version: '1.0.0' },
		{
			capabilities: { tools: {} },
			instructions: 'Assignment-scoped TreeSeed tools for a single provider assignment.',
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: descriptors.map((descriptor) => ({
			name: agentToolMcpName(descriptor.id),
			description: `TreeSeed tool ${descriptor.id}. ${descriptor.description}`,
			inputSchema: descriptor.inputSchema as {
				type: 'object';
				properties?: Record<string, object>;
				required?: string[];
			},
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const requestedName = request.params.name;
		const matchingDescriptor = descriptors.find((descriptor) =>
			descriptor.id === requestedName || agentToolMcpName(descriptor.id) === requestedName,
		);
		const toolId = matchingDescriptor?.id ?? requestedName;
		const input = request.params.arguments ?? {};
		try {
			const result = await callAgentToolWithTelemetry({
				apiBaseUrl,
				providerApiKey,
				assignmentId,
				leaseToken,
				descriptors,
				sdk: options?.sdk,
				fetchImpl: options?.fetchImpl,
				repoRoot,
				telemetryPath,
				onTelemetry: options?.onTelemetry,
			}, toolId, input);
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
				structuredContent: result,
				isError: result && typeof result === 'object' && 'ok' in result && result.ok === false ? true : undefined,
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

export async function startAgentToolMcpServer(options?: Partial<AgentToolMcpServerOptions>) {
	const server = createAgentToolMcpServer(options);
	await server.connect(new StdioServerTransport());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void startAgentToolMcpServer();
}
