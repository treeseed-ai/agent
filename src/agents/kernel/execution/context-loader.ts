import {
	createAgentKernelModeFallback,
	type AgentKernelModeFallback,
	type DecisionExecutionInput,
	type ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import { AGENT_ACTIVITY_TYPES, type AgentActivityType, type AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import { loadActiveAgentSpecs } from '../../support/spec-loader.ts';
import { selectAgentActivityProfile } from '../telemetry/activity-profile-resolver.ts';
import { AGENT_SPEC_LOAD_TIMEOUT_MS, record, stringValue, withTimeout } from '../runtime/runtime-helpers.ts';

interface AssignmentActivityContext {
	agent: AgentRuntimeSpec | null;
	runtimeAgent: AgentRuntimeSpec | null;
	fallback: AgentKernelModeFallback | null;
}

function failed(code: string, reason: string, metadata?: Record<string, unknown>): AssignmentActivityContext {
	return {
		agent: null,
		runtimeAgent: null,
		fallback: createAgentKernelModeFallback(code, reason, { retryable: false, metadata }),
	};
}

export async function loadAssignmentActivityContext(input: {
	sdk: AgentSdk;
	assignment: ProviderAssignment;
	decisionInput: DecisionExecutionInput;
	mode: 'planning' | 'acting';
}): Promise<AssignmentActivityContext> {
	let loaded: Awaited<ReturnType<typeof loadActiveAgentSpecs>>;
	try {
		loaded = await withTimeout({
			promise: loadActiveAgentSpecs(input.sdk),
			timeoutMs: AGENT_SPEC_LOAD_TIMEOUT_MS,
			code: 'assignment_agent_spec_load_timeout',
			message: `Active agent spec loading exceeded ${AGENT_SPEC_LOAD_TIMEOUT_MS}ms.`,
		});
	} catch (error) {
		return {
			agent: null,
			runtimeAgent: null,
			fallback: createAgentKernelModeFallback(
				(error as Error & { code?: string }).code ?? 'assignment_agent_spec_load_failed',
				error instanceof Error ? error.message : String(error),
				{ retryable: true, metadata: { phase: 'load_active_agent_specs', timeoutMs: AGENT_SPEC_LOAD_TIMEOUT_MS } },
			),
		};
	}
	const errors = loaded.diagnostics.filter((entry) => entry.severity === 'error');
	if (errors.length) {
		return failed(
			'assignment_agent_not_found',
			`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
		);
	}
	const agentSlug = input.decisionInput.agentId ?? input.assignment.agentId;
	const agent = agentSlug ? loaded.specs.find((entry) => entry.slug === agentSlug) ?? null : null;
	if (!agent) {
		return failed(
			'assignment_agent_not_found',
			`Agent ${agentSlug ?? '<missing>'} is not enabled or was not found in project ${input.assignment.projectId}.`,
		);
	}
	const requestedActivity = stringValue(record(input.decisionInput.input).activityType, '');
	const requestedActivityType = AGENT_ACTIVITY_TYPES.includes(requestedActivity as AgentActivityType)
		? requestedActivity as AgentActivityType
		: null;
	const runtimeAgent = selectAgentActivityProfile(agent, input.mode, requestedActivityType);
	if (!runtimeAgent) {
		return failed(
			'assignment_activity_profile_unavailable',
			`Agent ${agent.slug} does not define an enabled ${requestedActivityType ?? input.mode} activity profile allowed under ${input.mode} capacity.`,
			{ agentSlug: agent.slug, mode: input.mode, requestedActivityType },
		);
	}
	if (input.decisionInput.handlerId && input.decisionInput.handlerId !== runtimeAgent.handler) {
		return failed(
			'assignment_handler_profile_mismatch',
			`Assignment handler ${input.decisionInput.handlerId} does not match ${agent.slug}'s configured ${input.mode} handler ${runtimeAgent.handler}.`,
			{
				agentSlug: agent.slug,
				mode: input.mode,
				assignedHandler: input.decisionInput.handlerId,
				configuredHandler: runtimeAgent.handler,
			},
		);
	}
	return { agent, runtimeAgent, fallback: null };
}
