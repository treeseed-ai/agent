import { deriveDecisionExecutionInputFromAssignment } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import type { AgentKernelAssignmentRunOptions, AgentKernelModeRunTelemetryInput } from '../execution/run-types.ts';

function transientTelemetryFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fetch failed|timed out|econnreset|econnrefused|socket|temporarily unavailable|network error/iu.test(message);
}

async function waitBeforeRetry(attempt: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, attempt * 250));
}

export async function recordAssignmentModeRun(
	options: AgentKernelAssignmentRunOptions,
	run: AgentKernelModeRunTelemetryInput,
) {
	if (!options.recordModeRun) return null;
	const assignment = options.assignment;
	const decisionInput = options.decisionInput ?? deriveDecisionExecutionInputFromAssignment(assignment);
	const handlerId = decisionInput.handlerId ?? assignment.handlerId ?? 'handler';
	const agentId = decisionInput.agentId ?? assignment.agentId ?? 'agent';
	const mode = run.capacityEnvelope?.mode ?? assignment.mode ?? decisionInput.mode ?? 'planning';
	const source = typeof run.metadata?.source === 'string' && run.metadata.source.trim()
		? run.metadata.source.trim()
		: 'agent_kernel_mode_runtime';
	const request = {
		id: run.id ?? options.modeRunId ?? `${assignment.id}:${mode}:${agentId}:${handlerId}:${source}:${randomUUID()}`,
		...run,
	};
	let lastError: unknown = new Error('Mode-run telemetry was not attempted.');
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await options.recordModeRun(request);
		} catch (error) {
			lastError = error;
			if (!transientTelemetryFailure(error) || attempt === 3) break;
			await waitBeforeRetry(attempt);
		}
	}
	throw lastError;
}
