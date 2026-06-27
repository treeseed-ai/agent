import type { TreeseedCopilotTool } from '@treeseed/sdk/copilot';
import type { ExecutionProviderToolDescriptor } from '../runtime-types.ts';
import { agentToolMcpName } from './agent-tool-mcp-server.ts';
import { callAgentToolWithTelemetry, type AgentToolRuntimeOptions } from './agent-tool-runtime.ts';

export function agentToolCopilotName(toolId: string) {
	return agentToolMcpName(toolId);
}

export function createCopilotAgentTools(options: AgentToolRuntimeOptions): TreeseedCopilotTool[] {
	return options.descriptors.map((descriptor): TreeseedCopilotTool => {
		const metadata = descriptor.metadata && typeof descriptor.metadata === 'object' && !Array.isArray(descriptor.metadata)
			? descriptor.metadata as Record<string, unknown>
			: {};
		const contentDetail = descriptor.executionTarget === 'treeseed_content'
			? ` Content action: ${String(metadata.contentAction ?? 'unknown')}; model: ${String(metadata.contentModel ?? 'generic')}; writes are staged unless an explicit commit content tool is available.`
			: '';
		return {
			name: agentToolCopilotName(descriptor.id),
			description: `TreeSeed tool ${descriptor.id}. ${descriptor.description}${contentDetail}`,
			parameters: descriptor.inputSchema,
			skipPermission: true,
			handler: async (input) => {
				const result = await callAgentToolWithTelemetry(options, descriptor.id, input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {});
				const ok = !(result && typeof result === 'object' && 'ok' in result && result.ok === false);
				const message = result && typeof result === 'object' && 'message' in result && typeof result.message === 'string'
					? result.message
					: JSON.stringify(result);
				return {
					textResultForLlm: JSON.stringify(result),
					resultType: ok ? 'success' : 'failure',
					error: ok ? undefined : message,
					toolTelemetry: {
						toolId: descriptor.id,
						callName: agentToolCopilotName(descriptor.id),
						executionTarget: descriptor.executionTarget,
						mutability: descriptor.mutability,
					},
				};
			},
		};
	});
}
