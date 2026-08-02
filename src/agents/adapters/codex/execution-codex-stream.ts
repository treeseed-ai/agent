import type { CodexRunResult, CodexThread } from './execution-codex-core.ts';
import { redactCodexTraceRecord } from './execution-codex-redaction.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value : '';
}

export async function runCodexThread(
	thread: CodexThread,
	prompt: string,
	onEvent?: (event: Record<string, unknown>) => void | Promise<void>,
): Promise<CodexRunResult> {
	if (!onEvent || !thread.runStreamed) return thread.run(prompt);
	const streamed = await thread.runStreamed(prompt);
	const items = new Map<string, Record<string, unknown>>();
	let finalResponse = '';
	let usage: CodexRunResult['usage'] = null;
	for await (const rawEvent of streamed.events) {
		const event = redactCodexTraceRecord(rawEvent);
		await onEvent(event);
		const eventType = text(event.type);
		const item = record(event.item);
		const itemId = text(item.id);
		if (itemId && eventType.startsWith('item.')) items.set(itemId, item);
		if (eventType === 'item.completed' && item.type === 'agent_message') finalResponse = text(item.text);
		if (eventType === 'turn.completed') usage = record(event.usage) as CodexRunResult['usage'];
		if (eventType === 'turn.failed') throw new Error(text(record(event.error).message) || 'Codex turn failed.');
		if (eventType === 'error') throw new Error(text(event.message) || 'Codex event stream failed.');
	}
	return { items: [...items.values()], finalResponse, usage };
}
