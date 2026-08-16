import { describe, expect, it, vi } from 'vitest';
import { runCodexThread } from '../../../../src/agents/adapters/codex/execution-codex-stream.ts';
import { codexEventMessage } from '../../../../src/provider/reporting/codex-event-message.ts';

describe('Codex streamed execution activity', () => {
	it('records events in order and rebuilds the buffered Codex result', async () => {
		const events = [
			{ type: 'thread.started', thread_id: 'thread-a' },
			{ type: 'item.started', item: { id: 'reason-a', type: 'reasoning', text: 'Inspecting evidence.' } },
			{ type: 'item.completed', item: { id: 'message-a', type: 'agent_message', text: 'Created the review note.' } },
			{ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 } },
		];
		const recorded: Record<string, unknown>[] = [];
		const result = await runCodexThread({
			async run() { throw new Error('buffered execution should not be used'); },
			async runStreamed() {
				return { events: (async function* () { for (const event of events) yield event; })() };
			},
		}, 'Review the Guide.', async (event) => { recorded.push(event); });
		expect(recorded).toEqual(events);
		expect(result).toMatchObject({
			finalResponse: 'Created the review note.',
			usage: { input_tokens: 10, output_tokens: 4 },
			items: [
				{ id: 'reason-a', type: 'reasoning', text: 'Inspecting evidence.' },
				{ id: 'message-a', type: 'agent_message', text: 'Created the review note.' },
			],
		});
	});

	it('treats turn.completed as terminal without waiting for stream teardown', async () => {
		let released = false;
		const result = await Promise.race([
			runCodexThread({
				async run() { throw new Error('buffered execution should not be used'); },
				async runStreamed() { return { events: (async function* () {
					try {
						yield { type: 'item.completed', item: { id: 'message-a', type: 'agent_message', text: 'Durable work completed.' } };
						yield { type: 'turn.completed', usage: { output_tokens: 8 } };
						await new Promise(() => undefined);
					} finally { released = true; }
				})() }; },
			}, 'Complete the bounded assignment.', vi.fn()),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('completed turn did not return')), 100)),
		]);
		expect(result).toMatchObject({ finalResponse: 'Durable work completed.', usage: { output_tokens: 8 } });
		expect(released).toBe(true);
	});

	it('fails closed when durable event recording fails', async () => {
		await expect(runCodexThread({
			async run() { return {}; },
			async runStreamed() {
				return { events: (async function* () { yield { type: 'turn.started' }; })() };
			},
		}, 'Review the Guide.', vi.fn(async () => { throw new Error('telemetry unavailable'); })))
			.rejects.toThrow('telemetry unavailable');
	});

	it('redacts credentials before events and buffered trace items leave the provider', async () => {
		const recorded: Record<string, unknown>[] = [];
		const result = await runCodexThread({
			async run() { return {}; },
			async runStreamed() {
				return { events: (async function* () {
					yield { type: 'item.completed', item: { id: 'command-a', type: 'command_execution', command: 'curl -H "Authorization: Bearer secret-token-value"', accessToken: 'tsk_secret_value' } };
				})() };
			},
		}, 'Review the Guide.', async (event) => { recorded.push(event); });
		expect(JSON.stringify({ recorded, result })).not.toContain('secret-token-value');
		expect(JSON.stringify({ recorded, result })).not.toContain('tsk_secret_value');
		expect(JSON.stringify({ recorded, result })).toContain('<redacted>');
	});

	it('preserves full agent text while bounding command activity to safe fields', () => {
		expect(codexEventMessage({ type: 'item.updated', item: { id: 'message-a', type: 'agent_message', text: 'Full progress message.' } }))
			.toMatchObject({ payload: { eventType: 'item.updated', item: { text: 'Full progress message.' } } });
		expect(codexEventMessage({ type: 'item.completed', item: { id: 'command-a', type: 'command_execution', command: 'npm test', aggregated_output: 'sensitive output', status: 'completed', exit_code: 0 } }))
			.toMatchObject({ payload: { item: { command: 'npm test', status: 'completed', exitCode: 0 } } });
		expect(JSON.stringify(codexEventMessage({ type: 'item.completed', item: { id: 'command-a', type: 'command_execution', command: 'npm test', aggregated_output: 'sensitive output' } })))
			.not.toContain('sensitive output');
	});

	it('retains sanitized MCP arguments and results for forensic provider messages', () => {
		const message = codexEventMessage({ type: 'item.completed', item: {
			id: 'tool-a', type: 'mcp_tool_call', server: 'treeseed_tools', tool: 'treeseed_content_query',
			arguments: { model: 'note', accessToken: 'tsk_secret_value' }, result: { items: [{ id: 'note:one' }] }, status: 'completed',
		} });
		expect(message).toMatchObject({ payload: { item: { arguments: { model: 'note', accessToken: '<redacted>' }, result: { items: [{ id: 'note:one' }] } } } });
	});
});
