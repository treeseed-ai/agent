import { describe,expect,it } from 'vitest';
import { codexAgentToolConfig } from '../../../src/agents/adapters/codex/execution-codex-core.ts';
import { executionContentOutputStatus } from '../../../src/agents/handlers/execution-content.ts';
import { waitingOutputIsTerminal } from '../../../src/agents/kernel/validation/output-validator.ts';

describe('execution-provider retry propagation', () => {
	it('gives the required production MCP server enough time to initialize under concurrent load', () => {
		const config = codexAgentToolConfig({
			repoRoot: '/tmp/agent-lab-repository', sandboxMode: 'workspace_write',
			tools: [{ kind: 'agent_tool', id: 'treeseed.content.query', name: 'Query content' }],
		} as never) as { mcp_servers: { treeseed_tools: { startup_timeout_sec: number } } };
		expect(config.mcp_servers.treeseed_tools.startup_timeout_sec).toBe(90);
	});

	it('returns retryable provider initialization failures to capacity instead of terminalizing them', () => {
		const snapshot = { status: 'failed', retryable: true, code: 'codex_sdk_initialization_failed' } as never;
		expect(executionContentOutputStatus(snapshot)).toBe('waiting');
		expect(waitingOutputIsTerminal({
			status: 'waiting', summary: 'Retry provider startup.',
			metadata: { executionSnapshot: { ...snapshot, outputs: { executionBlocked: true } } },
		})).toBe(false);
	});

	it('keeps non-retryable provider failures terminal', () => {
		const snapshot = { status: 'failed', retryable: false } as never;
		expect(executionContentOutputStatus(snapshot)).toBe('failed');
		expect(waitingOutputIsTerminal({
			status: 'waiting', summary: 'Stop.', metadata: { executionSnapshot: { ...snapshot, outputs: { executionBlocked: true } } },
		})).toBe(true);
	});
});
