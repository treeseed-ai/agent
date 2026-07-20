import { deriveDecisionExecutionInputFromAssignment } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import type { AgentKernelAssignmentRunOptions, AgentKernelModeRunTelemetryInput } from './run-types.ts';

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
	return options.recordModeRun({
		id: run.id ?? `${assignment.id}:${mode}:${agentId}:${handlerId}:${source}:${randomUUID()}`,
		...run,
	});
}
