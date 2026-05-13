import type { AgentExecutionResult, AgentContext } from '../runtime-types.ts';

export interface HandlerPayload {
	[key: string]: unknown;
}

export function nowIso() {
	return new Date().toISOString();
}

export function parseTriggerPayload(context: AgentContext): HandlerPayload {
	const raw = context.trigger.message?.payloadJson;
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as HandlerPayload
			: {};
	} catch {
		return {};
	}
}

export function readRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readTaskId(payload: HandlerPayload) {
	return readString(payload.taskId) ?? readString(readRecord(payload.metadata)?.taskId);
}

export async function appendArtifactTaskEvent(input: {
	context: AgentContext;
	payload: HandlerPayload;
	kind: string;
	data: Record<string, unknown>;
}) {
	const taskId = readTaskId(input.payload);
	const sdk = input.context.sdk as unknown as {
		appendTaskEvent?: (request: {
			taskId: string;
			kind: string;
			data: Record<string, unknown>;
			actor: string;
		}) => Promise<unknown>;
	};
	if (!taskId || typeof sdk.appendTaskEvent !== 'function') {
		return;
	}
	await sdk.appendTaskEvent({
		taskId,
		kind: input.kind,
		data: input.data,
		actor: input.context.agent.slug,
	});
}

export async function createAgentMessage(input: {
	context: AgentContext;
	type: string;
	payload: Record<string, unknown>;
	relatedModel?: string | null;
	relatedId?: string | null;
}) {
	try {
		await input.context.sdk.createMessage({
			type: input.type,
			payload: input.payload,
			relatedModel: input.relatedModel ?? null,
			relatedId: input.relatedId ?? null,
			priority: 100,
		});
	} catch {
		// Message permissions are agent-spec controlled; artifact metadata remains the durable handler output.
	}
}

export function waiting(summary: string): AgentExecutionResult {
	return {
		status: 'waiting',
		summary,
	};
}

export function completed(summary: string, metadata: Record<string, unknown>): AgentExecutionResult {
	return {
		status: 'completed',
		summary,
		metadata,
	};
}
