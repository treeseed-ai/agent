import type { AgentHandlerOutput, AgentContext } from '../runtime-types.ts';

export interface HandlerPayload {
	[key: string]: unknown;
}

export function nowIso() {
	return new Date().toISOString();
}

export function parseTriggerPayload(context: AgentContext): HandlerPayload {
	const decisionInput = context.capacity?.decisionInput && typeof context.capacity.decisionInput === 'object'
		? context.capacity.decisionInput as Record<string, unknown>
		: {};
	const assignmentInput = decisionInput.input && typeof decisionInput.input === 'object' && !Array.isArray(decisionInput.input)
		? decisionInput.input as HandlerPayload
		: {};
	const raw = context.trigger.message?.payloadJson;
	if (!raw) {
		return assignmentInput;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		const triggerPayload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as HandlerPayload
			: {};
		return { ...triggerPayload, ...assignmentInput };
	} catch {
		return assignmentInput;
	}
}

export function readRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function recordArtifactMessage(input: {
	context: AgentContext;
	payload: HandlerPayload;
	kind: string;
	data: Record<string, unknown>;
}) {
	await createAgentMessage({
		context: input.context,
		type: `agent.${input.kind}`,
		payload: {
			...input.data,
			assignmentId: input.context.capacity?.assignment?.id ?? null,
			mode: input.context.mode,
			agentSlug: input.context.agent.slug,
		},
		relatedModel: 'provider_assignment',
		relatedId: input.context.capacity?.assignment?.id ?? null,
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

export function waiting(summary: string): AgentHandlerOutput {
	return {
		status: 'waiting',
		summary,
	};
}

export function completed(summary: string, metadata: Record<string, unknown>): AgentHandlerOutput {
	return {
		status: 'completed',
		summary,
		metadata,
	};
}
