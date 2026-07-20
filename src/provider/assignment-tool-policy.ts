import { record, stringValue } from './value-utils.ts';

export function assignmentWorkspaceAccessMode(assignment: Record<string, unknown>) {
	const handles = record(assignment.capabilityHandles);
	const workspaceContext = record(assignment.workspaceContext);
	const mode = stringValue(handles.workspaceAccessMode, workspaceContext.workspaceAccessMode);
	return ['context_only', 'workspace_write', 'brokered_workspace', 'full_workspace_no_credentials', 'trusted_direct']
		.includes(mode ?? '') ? mode : 'context_only';
}

export function assignmentWorkflowOperationHandles(assignment: Record<string, unknown>) {
	const operations = record(assignment.capabilityHandles).workflowOperations;
	return Array.isArray(operations) ? operations as Record<string, unknown>[] : [];
}
