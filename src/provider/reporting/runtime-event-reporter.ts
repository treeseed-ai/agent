import type { ProviderRuntimeEventInput } from '@treeseed/sdk/agent-capacity';
import type { ProviderAssignmentClient } from '../coordination/lease-client.ts';

export async function reportProviderRuntimeEvent(input: {
	client: ProviderAssignmentClient;
	assignmentId: string;
	event: ProviderRuntimeEventInput;
	maxAttempts?: number;
}) {
	if (!input.client.createAssignmentEvent || !input.assignmentId) return false;
	const attempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 5));
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await input.client.createAssignmentEvent(input.assignmentId, input.event);
			return true;
		} catch (error) {
			lastError = error;
		}
	}
	console.error(JSON.stringify({
		level: 'error', event: 'provider.runtime_event_delivery_failed', assignmentId: input.assignmentId,
		runtimeEventType: input.event.eventType, message: lastError instanceof Error ? lastError.message : String(lastError), attempts,
	}));
	return false;
}
