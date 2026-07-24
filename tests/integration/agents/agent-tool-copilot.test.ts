import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCopilotAgentTools } from '../../../src/agents/tools/agent-tool-copilot.ts';
import type { ExecutionProviderToolDescriptor } from '../../../src/agents/runtime/runtime-types.ts';

function statusDescriptor(): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.status',
		name: 'TreeSeed status',
		description: 'Inspect TreeSeed status.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		executionTarget: 'sdk_dispatch',
		mutability: 'read',
		metadata: {
			assignmentId: 'assignment-copilot',
			projectId: 'project-copilot',
			telemetryCategory: 'treeseed',
			dispatchPreferredMode: 'prefer_local',
		},
	};
}

describe('Copilot agent tools', () => {
	it('maps TreeSeed descriptors to Copilot-native tools and executes through the runtime', async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-copilot-tool-'));
		try {
			const tools = createCopilotAgentTools({
				apiBaseUrl: '',
				providerAccessToken: '',
				assignmentId: 'assignment-copilot',
				descriptors: [statusDescriptor()],
				repoRoot,
				sdk: {
					dispatch: async (request) => ({
						ok: true,
						request,
					}),
				},
			});

			expect(tools).toHaveLength(1);
			expect(tools[0]).toMatchObject({
				name: 'treeseed_status',
				skipPermission: true,
				parameters: { type: 'object' },
			});

			const result = await tools[0]?.handler({}, {
				sessionId: 'session-1',
				toolCallId: 'tool-call-1',
				toolName: 'treeseed_status',
				arguments: {},
			});

			expect(result).toMatchObject({
				resultType: 'success',
				toolTelemetry: {
					toolId: 'treeseed.status',
					callName: 'treeseed_status',
				},
			});
			expect(String(result && typeof result === 'object' && 'textResultForLlm' in result ? result.textResultForLlm : '')).toContain('"operation":"status"');
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
