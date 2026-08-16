import type {
	AgentActivityProfile,
	AgentActivityType,
	AgentRuntimeSpec,
} from '@treeseed/sdk/types/agents';
import { allowedSafetyModesForActivity,compileAgentAuthoritySnapshot } from '@treeseed/sdk/agent-capacity';
import { permissionProjectionForProfile } from '../../support/spec-normalizer-policy.ts';

function executionForProfile(agent: AgentRuntimeSpec, profile: AgentActivityProfile) {
	return {
		...agent.execution,
		...profile.execution,
		timeoutSeconds: profile.execution?.maxRuntimeSeconds ?? agent.execution.timeoutSeconds,
		retryLimit: profile.execution?.maxRetries ?? agent.execution.retryLimit,
		allowedPaths: profile.execution?.allowedPaths ?? agent.execution.allowedPaths,
		forbiddenPaths: profile.execution?.forbiddenPaths ?? agent.execution.forbiddenPaths,
	};
}

const RESOURCE_STEWARDSHIP_PROMPT = `Resource stewardship:
- Your allocation is a maximum, not a target to consume.
- Finish as soon as every acceptance criterion is satisfied and no important in-scope work remains.
- Do not invent work, broaden scope, prolong discussion, or consume tokens merely because capacity remains.
- Before completing early, verify the result, persist every required durable artifact, and report why further work would have low value.
- Use blocked rather than completed_early when evidence, authority, credentials, or dependencies are missing.
- Near the deadline, narrow scope, checkpoint valid work, and return an honest partial or blocked result.
- A completed_early result must include acceptanceChecks, durableArtifactRefs, remainingBudget, completionReason, and noUsefulScopedWorkRemaining=true.`;

function systemPromptForProfile(profile: AgentActivityProfile) {
	const publications = profile.signals?.publishes ?? [];
	const signalPrompt = publications.length
		? `\n\nSignal handoff: after creating the required durable content or control-plane evidence, call treeseed.publish_signal once for each applicable declared signal (${publications.join(', ')}). Use the durable subject identity, explain the change for the next agent, and include typed routing fields such as objective and proposalTypes. Do not claim completion until the signal request has succeeded.`
		: '';
	return `${profile.prompt.system}\n\n${RESOURCE_STEWARDSHIP_PROMPT}${signalPrompt}`;
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
	if (!allowedSafetyModesForActivity(activityType).includes(mode)) return null;
	const profile = agent.activityProfiles?.[activityType];
	if (!profile?.enabled) return null;
	const authority = compileAgentAuthoritySnapshot(activityType, profile);
	if (authority.diagnostics.length > 0) return null;
	return {
		...agent,
		handler: profile.handler,
		activityType,
		branchPolicy: profile.branchPolicy,
		questionPolicy: profile.questionPolicy,
		systemPrompt: systemPromptForProfile(profile),
		tools: authority.tools,
		authorityPresetIds: authority.presetIds,
		authoritySnapshot: {
			presetIds: authority.presetIds,
			permissions: authority.permissions,
			tools: authority.tools,
			branchPolicy: profile.branchPolicy,
		},
		signalPolicy: profile.signals,
		outputs: profile.outputs,
		permissionProjection: permissionProjectionForProfile(authority.permissions),
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
