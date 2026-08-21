import { assertProviderAssignment, type ProviderAssignment, type ProviderAssignmentCapabilityHandles } from '@treeseed/sdk/agent-capacity';
import { record, stringValue } from '../../configuration/value-utils.ts';
import { isApiIssuedWorkdayAssignment } from './workday-assignment-authority.ts';

export function buildKernelProviderAssignment(input: {
	assignment: Record<string, unknown>;
	assignmentId: string;
	membershipId: string;
	stateVersion: number;
	decisionInput: Record<string, unknown>;
	decisionPayload: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	projectId: string;
	agentSlug: string;
	workspaceMode: string | null;
	treedxProxyHandle: Record<string, unknown>;
	capabilityHandles: ProviderAssignmentCapabilityHandles;
}): ProviderAssignment {
	const { assignment, assignmentId, membershipId, stateVersion, decisionInput, decisionPayload, capacityEnvelope, projectId, agentSlug, workspaceMode, treedxProxyHandle, capabilityHandles } = input;
	if (isApiIssuedWorkdayAssignment(assignment)) {
		return assertProviderAssignment({
			...assignment,
			treedxProxyHandle,
			capabilityHandles,
			workspaceContext: {
				...record(assignment.workspaceContext),
				workspaceAccessMode: workspaceMode,
				treedxProxyHandle,
				capabilityHandles,
			},
		});
	}
	return assertProviderAssignment({
		...assignment,
		id: assignmentId,
		membershipId,
		stateVersion,
		teamId: stringValue(assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
		projectId,
		capacityProviderId: stringValue(assignment.capacityProviderId, capacityEnvelope.capacityProviderId) ?? '',
		projectAgentClassId: stringValue(assignment.projectAgentClassId, decisionInput.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
		mode: stringValue(assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
		status: stringValue(assignment.status) ?? 'leased',
		leaseState: stringValue(assignment.leaseState) ?? 'leased',
		agentId: agentSlug,
		handlerId: stringValue(assignment.handlerId, decisionInput.handlerId),
		treedxProxyHandle,
		capacityEnvelope: {
			...capacityEnvelope,
			teamId: stringValue(capacityEnvelope.teamId, assignment.teamId, decisionInput.teamId) ?? '',
			projectId,
			mode: stringValue(capacityEnvelope.mode, assignment.mode, decisionInput.mode) ?? 'planning',
			projectAgentClassId: stringValue(capacityEnvelope.projectAgentClassId, assignment.projectAgentClassId, decisionInput.projectAgentClassId) ?? agentSlug,
			capacityProviderId: stringValue(capacityEnvelope.capacityProviderId, assignment.capacityProviderId) ?? '',
		},
		decisionInput: {
			...decisionInput,
			teamId: stringValue(decisionInput.teamId, assignment.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			projectAgentClassId: stringValue(decisionInput.projectAgentClassId, assignment.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
			mode: stringValue(decisionInput.mode, assignment.mode, capacityEnvelope.mode) ?? 'planning',
			agentId: agentSlug,
			input: { ...decisionPayload, projectId, agentSlug, assignmentId },
		},
		capabilityHandles,
		workspaceContext: {
			...record(assignment.workspaceContext),
			workspaceAccessMode: workspaceMode,
			treedxProxyHandle,
			capabilityHandles,
		},
	});
}
