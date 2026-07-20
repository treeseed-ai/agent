import type { AgentModeRunStatus } from '@treeseed/sdk/agent-capacity';
import type { ProviderAssignmentClient } from './lease-client.ts';
import { deliverProviderModeRunTelemetry } from './mode-run-telemetry.ts';
import { stringValue } from './value-utils.ts';

export async function recordEarlyModeRun(input: {
	client: ProviderAssignmentClient;
	assignmentId: string;
	assignment: Record<string, unknown>;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	status: AgentModeRunStatus;
	fallbackReason: string;
	metadata?: Record<string, unknown>;
	outputs?: Record<string, unknown>;
	traceRefs?: Record<string, unknown>;
	startedAt?: string | null;
}) {
	if (!input.assignmentId) return null;
	const source = stringValue(input.metadata?.source) ?? 'provider_runner_early_exit';
	const outputStatus = stringValue(input.outputs?.status) ?? input.fallbackReason ?? input.status;
	return deliverProviderModeRunTelemetry({
		recorder: input.client,
		assignmentId: input.assignmentId,
		eventId: `runner:${source}:${outputStatus}`,
		request: {
			mode: stringValue(input.assignment.mode, input.capacityEnvelope.mode) ?? 'planning',
			status: input.status,
			selectedInput: input.selectedInput,
			capacityEnvelope: input.capacityEnvelope,
			outputs: input.outputs ?? {},
			traceRefs: input.traceRefs ?? {},
			fallbackReason: input.fallbackReason,
			startedAt: input.startedAt ?? null,
			metadata: { source, ...(input.metadata ?? {}) },
		},
	});
}
