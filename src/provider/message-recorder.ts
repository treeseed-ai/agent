import { deliverProviderModeRunTelemetry, type AssignmentModeRunRecorder } from './mode-run-telemetry.ts';

export function createProviderMessageRecorder(input: {
	recorder: AssignmentModeRunRecorder;
	assignmentId: string;
	mode: string;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	runnerId: string;
}) {
	let deliveredSequence = 0;
	let pending: { sequence: number; message: Record<string, unknown> } | null = null;
	return async (request: Record<string, unknown>) => {
		if (!pending) {
			const sequence = deliveredSequence + 1;
			pending = {
				sequence,
				message: {
					id: `provider-message-${input.assignmentId}-${sequence}`,
					...request,
					actor: request.actor ?? 'agent',
					createdAt: new Date().toISOString(),
				},
			};
		}
		const { sequence, message } = pending;
		await deliverProviderModeRunTelemetry({
			recorder: input.recorder,
			assignmentId: input.assignmentId,
			eventId: `message:${message.id}`,
			request: {
				mode: input.mode,
				status: 'running',
				selectedInput: input.selectedInput,
				capacityEnvelope: input.capacityEnvelope,
				outputs: {
					status: 'message_recorded',
					summary: `Recorded provider assignment message ${message.id}.`,
					metadata: { source: 'provider_runner_message', message },
				},
				metadata: {
					source: 'provider_runner_message',
					assignmentId: input.assignmentId,
					runnerId: input.runnerId,
					messageId: message.id,
				},
			},
		});
		deliveredSequence = sequence;
		pending = null;
		return { ok: true, model: 'message', action: 'create', payload: message };
	};
}
