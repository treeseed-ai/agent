import type {
	AgentActivityProfile,
	AgentActivityType,
	AgentRuntimeSpec,
} from '@treeseed/sdk/types/agents';

function executionForProfile(agent: AgentRuntimeSpec, profile: AgentActivityProfile) {
	return {
		...agent.execution,
		timeoutSeconds: profile.execution?.maxRuntimeSeconds ?? agent.execution.timeoutSeconds,
		retryLimit: profile.execution?.maxRetries ?? agent.execution.retryLimit,
		allowedPaths: profile.execution?.allowedPaths ?? agent.execution.allowedPaths,
		forbiddenPaths: profile.execution?.forbiddenPaths ?? agent.execution.forbiddenPaths,
	};
}

export function agentActivityTypeForAssignmentMode(mode: 'planning' | 'acting'): AgentActivityType {
	return mode;
}

export function selectAgentActivityProfile(
	agent: AgentRuntimeSpec,
	mode: 'planning' | 'acting',
	requestedActivityType?: AgentActivityType | null,
): AgentRuntimeSpec | null {
	const activityType = requestedActivityType ?? agentActivityTypeForAssignmentMode(mode);
	if (mode === 'acting' && activityType !== 'acting') return null;
	if (mode === 'planning' && activityType === 'acting') return null;
	const profile = agent.activityProfiles?.[activityType];
	if (!profile?.enabled) return null;
	return {
		...agent,
		handler: profile.handler,
		activityType,
		branchPolicy: profile.branchPolicy,
		questionPolicy: profile.questionPolicy,
		systemPrompt: profile.prompt.system,
		tools: profile.tools,
		outputs: profile.outputs,
		contentAccess: profile.contentAccess,
		execution: executionForProfile(agent, profile),
		activityConfig: {
			...agent.activityConfig,
			workPackageKind: profile.handler,
			domain: activityType,
			metadata: {
				...agent.activityConfig?.metadata,
				activityType,
				promptTask: profile.prompt.task,
			},
		},
	};
}
