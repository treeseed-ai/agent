import type { AgentExecutionRequest } from '../contracts.ts';

type ExecutionEvent = Parameters<NonNullable<AgentExecutionRequest['emit']>>[0];

/** Keep the original transcript in ordinary protected trace records, rather
 * than accumulating the whole provider stream in one terminal API request. */
export async function emitExecutionEvidence(emit: AgentExecutionRequest['emit'], event: ExecutionEvent,
	usage: Record<string, unknown>, outputs: Record<string, unknown>) {
	if (!emit) return;
	try {
		const diagnostics = event.protectedPayload;
		if (!diagnostics || !Array.isArray(diagnostics.providerEvents)) { await emit(event); return; }
		const { providerEvents, ...terminalDiagnostics } = diagnostics;
		let batch: unknown[] = [], offset = 0;
		const flush = async () => {
			if (!batch.length) return;
			await emit({ type: 'execution.progress', occurredAt: event.occurredAt, summary: 'Original provider transcript retained.',
				payload: { stage: 'provider.events', offset, count: batch.length }, protectedPayload: { providerEvents: batch } });
			offset += batch.length; batch = [];
		};
		for (const providerEvent of providerEvents) {
			if (batch.length && JSON.stringify({ providerEvents: [...batch, providerEvent] }).length > 262_144) await flush();
			batch.push(providerEvent);
		}
		await flush();
		await emit({ ...event, protectedPayload: { ...terminalDiagnostics, providerEventCount: providerEvents.length } });
	} catch (error) {
		// A diagnostics outage must not erase the already measured execution or
		// verified teardown when the owning runner retains the original failure.
		throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage: [usage], outputs });
	}
}
