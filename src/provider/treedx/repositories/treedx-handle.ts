import type { TreeDxProxyHandle } from '@treeseed/sdk/agent-capacity';
import { record, stringValue } from '../../configuration/value-utils.ts';

export type ScopedTreeDxProxyHandle = TreeDxProxyHandle & {
	allowedReadPaths?: string[];
	allowedWritePaths?: string[];
};

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

export function normalizeTreeDxProxyHandle(value: unknown): ScopedTreeDxProxyHandle | null {
	const input = record(value);
	const id = stringValue(input.id);
	const teamId = stringValue(input.teamId);
	const projectId = stringValue(input.projectId);
	if (!id || !teamId || !projectId) return null;
	return {
		id,
		teamId,
		projectId,
		assignmentId: optionalString(input.assignmentId),
		repositoryId: optionalString(input.repositoryId),
		workspaceId: optionalString(input.workspaceId),
		status: stringValue(input.status) ?? 'issued',
		scopes: strings(input.scopes),
		allowedOperations: strings(input.allowedOperations),
		allowedPaths: strings(input.allowedPaths),
		allowedReadPaths: strings(input.allowedReadPaths),
		allowedWritePaths: strings(input.allowedWritePaths),
		expiresAt: optionalString(input.expiresAt),
		issuedAt: optionalString(input.issuedAt),
		revokedAt: optionalString(input.revokedAt),
		token: optionalString(input.token),
		tokenHash: optionalString(input.tokenHash),
		metadata: record(input.metadata),
	};
}
