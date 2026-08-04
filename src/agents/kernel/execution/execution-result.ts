import {
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
	normalizeAgentExecutionMode,
	type AgentKernelModeExecutionResult,
	type AgentKernelModeFallback,
} from '@treeseed/sdk/agent-capacity';
import { AgentKernelFallbackController } from '../validation/fallback-controller.ts';
import type { AgentKernelAssignmentRunOptions } from './run-types.ts';
import { recordAssignmentModeRun } from '../telemetry/telemetry.ts';
import { nowIso } from '../runtime/runtime-helpers.ts';

const fallbackController = new AgentKernelFallbackController();

export async function boundedAssignmentResult(
	options: AgentKernelAssignmentRunOptions,
	fallback: AgentKernelModeFallback,
	status: AgentKernelModeExecutionResult['status'] = fallback.retryable ? 'returned' : 'failed',
	evidence?: Pick<AgentKernelModeExecutionResult, 'artifactManifest' | 'outputs' | 'traceRefs'>,
): Promise<AgentKernelModeExecutionResult> {
	const assignment = options.assignment;
	const mode = normalizeAgentExecutionMode(assignment.mode);
	const capacityEnvelope = options.capacityEnvelope ?? deriveAgentCapacityEnvelopeFromAssignment(assignment);
	const decisionInput = options.decisionInput ?? deriveDecisionExecutionInputFromAssignment(assignment);
	const timestamp = nowIso();
	await recordAssignmentModeRun(options, {
		status: status === 'failed' ? 'failed' : 'cancelled',
		selectedInput: decisionInput.input,
		capacityEnvelope,
		outputs: {
			...(evidence?.outputs ?? {}),
			status,
			summary: fallback.reason,
			artifactManifest: evidence?.artifactManifest ?? null,
		},
		validation: { code: fallback.code, retryable: fallback.retryable, ...(fallback.metadata ?? {}) },
		fallbackReason: fallback.reason,
		failedAt: status === 'failed' ? timestamp : null,
		completedAt: status !== 'failed' ? timestamp : null,
			metadata: {
				recordKind: 'mode-run',
				source: 'agent_kernel_mode_runtime',
			assignmentId: assignment.id,
			runnerId: options.runnerId ?? null,
		},
	});
	if (options.recordFallbackOutput) {
		await options.recordFallbackOutput(fallbackController.buildOutput({
			assignmentId: assignment.id,
			projectId: assignment.projectId,
			mode,
			fallback,
			metadata: {
				status,
				runnerId: options.runnerId ?? null,
				attemptCount: assignment.attemptCount ?? 0,
			},
		}));
	}
	return {
		status,
		mode,
		assignmentId: assignment.id,
		projectId: assignment.projectId,
		projectAgentClassId: assignment.projectAgentClassId,
		agentId: decisionInput.agentId ?? assignment.agentId ?? null,
		handlerId: decisionInput.handlerId ?? assignment.handlerId ?? null,
		summary: fallback.reason,
		outputs: { ...(evidence?.outputs ?? {}), status, summary: fallback.reason },
		selectedInput: decisionInput.input,
		capacityEnvelope,
		traceRefs: evidence?.traceRefs ?? {},
		artifactManifest: evidence?.artifactManifest ?? null,
		fallback,
		metadata: { recordKind: 'mode-run', source: 'agent_kernel_mode_runtime' },
	};
}
