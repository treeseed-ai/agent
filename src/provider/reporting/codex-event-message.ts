function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value : null;
}

function activityItem(item: Record<string, unknown>) {
	const type = text(item.type);
	if (type === 'agent_message' || type === 'reasoning') return { id: text(item.id), type, text: text(item.text) };
	if (type === 'command_execution') return { id: text(item.id), type, command: text(item.command), status: text(item.status), exitCode: item.exit_code ?? null };
	if (type === 'file_change') return { id: text(item.id), type, status: text(item.status), changes: item.changes ?? [] };
	if (type === 'mcp_tool_call') return redactCodexTraceRecord(item);
	if (type === 'web_search') return { id: text(item.id), type, query: text(item.query) };
	if (type === 'todo_list') return { id: text(item.id), type, items: item.items ?? [] };
	if (type === 'error') return { id: text(item.id), type, message: text(item.message) };
	return Object.keys(item).length ? { id: text(item.id), type } : null;
}

export function codexEventMessage(event: Record<string, unknown>) {
	const eventType = text(event.type) ?? 'unknown';
	const item = activityItem(record(event.item));
	const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
	return {
		type: 'agent.execution.activity',
		payload: {
			provider: 'codex',
			eventType,
			threadId: text(event.thread_id),
			item,
			usage: eventType === 'turn.completed' ? record(event.usage) : null,
			error: eventType === 'turn.failed' ? record(event.error) : eventType === 'error' ? { message: text(event.message) } : null,
			redactionStatus: 'sanitized',
			payloadDigest: digest,
		},
	};
}
import { createHash } from 'node:crypto';
import { redactCodexTraceRecord } from '../../agents/adapters/codex/execution-codex-redaction.ts';
