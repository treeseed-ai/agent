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
	signal?: AbortSignal,
	onThreadStarted?: (threadId: string) => void,
): Promise<CodexRunResult> {
	if (!thread.runStreamed) return thread.run(prompt, { signal });
	const streamed = await thread.runStreamed(prompt, { signal });
	const items = new Map<string, Record<string, unknown>>();
	let finalResponse = '';
	let usage: CodexRunResult['usage'] = null;
	const result = (): CodexRunResult => ({ items: [...items.values()], finalResponse, usage });
	for await (const rawEvent of streamed.events) {
		const event = redactCodexTraceRecord(rawEvent);
		const eventType = text(event.type);
		if (eventType === 'thread.started') {
			const threadId = text(event.thread_id);
			if (threadId) onThreadStarted?.(threadId);
		}
		await onEvent?.(event);
		const item = record(event.item);
		const itemId = text(item.id);
		if (itemId && eventType.startsWith('item.')) items.set(itemId, item);
		if (eventType === 'item.completed' && item.type === 'agent_message') finalResponse = text(item.text);
		if (eventType === 'turn.completed') {
			usage = record(event.usage) as CodexRunResult['usage'];
			return result();
		}
		if (eventType === 'turn.failed') throw new Error(text(record(event.error).message) || 'Codex turn failed.');
		if (eventType === 'error') throw new Error(text(event.message) || 'Codex event stream failed.');
	}
	return result();
}
