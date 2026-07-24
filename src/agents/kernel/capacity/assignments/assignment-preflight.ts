import {
	createAgentKernelModeFallback,
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
	normalizeAgentExecutionMode,
	validateAgentKernelModeExecutionInput,
	type AgentKernelModeFallback,
} from '@treeseed/sdk/agent-capacity';
import type { AgentKernelAssignmentRunOptions } from '../../execution/run-types.ts';
import { assignmentTreeDxProxyHandle } from '../../runtime/runtime-helpers.ts';

function actingReadinessAllowsExecution(readiness: Record<string, unknown> | null | undefined) {
	if (!readiness) return false;
	return (readiness.executionReadiness === 'ready' || readiness.executionReadiness === 'waived')
		&& (readiness.planningInputsStatus === 'complete' || readiness.planningInputsStatus === 'waived');
}

export function preflightAssignment(options: AgentKernelAssignmentRunOptions) {
	const assignment = options.assignment;
	const mode = normalizeAgentExecutionMode(assignment.mode);
	const capacityEnvelope = options.capacityEnvelope ?? deriveAgentCapacityEnvelopeFromAssignment(assignment);
	const decisionInput = options.decisionInput ?? deriveDecisionExecutionInputFromAssignment(assignment);
	const treedxProxyHandle = assignmentTreeDxProxyHandle(assignment, options.treedxProxyHandle);
	let fallback: AgentKernelModeFallback | null = validateAgentKernelModeExecutionInput({
		...options,
		capacityEnvelope,
		decisionInput,
		readiness: options.readiness ?? null,
		treedxProxyHandle: treedxProxyHandle as Parameters<typeof validateAgentKernelModeExecutionInput>[0]['treedxProxyHandle'],
	});
	if (!fallback && mode === 'acting' && options.readiness
		&& !actingReadinessAllowsExecution(options.readiness as unknown as Record<string, unknown>)) {
		fallback = createAgentKernelModeFallback(
			'assignment_decision_not_ready',
			`Assignment ${assignment.id} is not ready for acting execution.`,
			{ retryable: true, metadata: { readiness: options.readiness } },
		);
	}
	return {
		assignment,
		mode,
		capacityEnvelope,
		decisionInput,
		treedxProxyHandle,
		fallback,
	};
}
