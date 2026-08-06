import { record, stringValue } from '../configuration/value-utils.ts';

export function assignmentTreeDxProxyHandle(assignment: Record<string, unknown>) {
	const direct = record(assignment.treedxProxyHandle);
	if (Object.keys(direct).length) return direct;
	return record(record(assignment.workspaceContext).treedxProxyHandle);
}

export function modeRunIdForAssignment(
	assignment: Record<string, unknown>,
	selectedInput: Record<string, unknown>,
	capacityEnvelope: Record<string, unknown>,
) {
	const decisionInput = record(assignment.decisionInput);
	return [
		stringValue(assignment.id) ?? 'assignment',
		stringValue(assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
		stringValue(assignment.agentId, decisionInput.agentId, selectedInput.agentSlug, selectedInput.agentId) ?? 'agent',
		stringValue(assignment.handlerId, decisionInput.handlerId, selectedInput.handlerId) ?? 'handler',
	].join(':');
}

export function assignmentAgentTools(allowed: string[], allowedOutputs: Record<string, unknown>) {
	const publications = allowedOutputs.publishedSignals;
	return Array.isArray(publications) && publications.length > 0
		? [...new Set([...allowed, 'treeseed.publish_signal'])]
		: allowed;
}
