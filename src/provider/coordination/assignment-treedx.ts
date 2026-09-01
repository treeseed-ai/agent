import { ControlPlaneClient } from '@treeseed/sdk/control-plane-client';
import type { ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { TREESEED_TREEDX_OPERATIONS, TreeSeedTreeDxClient } from '@treeseed/sdk/treedx';
import type { ProviderControlPlaneConnection } from './contracts.ts';
import type { AssignmentTreeDxFacade } from '../execution/contracts.ts';

type AnyOperation = ControlPlaneOperationBinding<any, any, any, any>;
type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
function text(...values: unknown[]) { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return ''; }
function operationMap(value: unknown, output = new Map<string, AnyOperation>()) {
	if (value && typeof value === 'object' && 'descriptor' in value && 'schema' in value) {
		const operation = value as AnyOperation; output.set(operation.descriptor.operationId, operation);
	} else if (value && typeof value === 'object') for (const child of Object.values(value)) operationMap(child, output);
	return output;
}
const operations = operationMap(TREESEED_TREEDX_OPERATIONS);

export async function createAssignmentTreeDxFacade(connection: ProviderControlPlaneConnection, assignment: RecordValue): Promise<AssignmentTreeDxFacade> {
	const handle = record(assignment.treedxProxyHandle ?? record(assignment.workspaceContext).treedxProxyHandle);
	const projectId = text(assignment.projectId, handle.projectId);
	const assignmentId = text(assignment.id, handle.assignmentId);
	const handleId = text(handle.id, handle.handleId);
	const handleToken = text(handle.token, handle.handleToken);
	if (!projectId || !assignmentId || !handleId) throw new Error('Assignment admission requires an active project-scoped TreeDX proxy handle.');
	const accessToken = async () => connection.accessTokenProvider ? connection.accessTokenProvider() : connection.accessToken;
	const client = new TreeSeedTreeDxClient(new ControlPlaneClient({
		profile: { serverId: 'capacity-provider-control-plane', label: 'Capacity provider control plane', baseUrl: connection.controlPlaneUrl },
		userAgent: '@treeseed/agent assignment-treedx',
	}));
	return {
		projectId, repositoryId: text(handle.repositoryId) || null, workspaceId: text(handle.workspaceId) || null,
		baseRef: text(handle.baseRef, handle.baseCommitSha) || null,
		readRepositories:Array.isArray(handle.readRepositories)?handle.readRepositories as never:Array.isArray(record(handle.metadata).readRepositories)?record(handle.metadata).readRepositories as never:[],
		async invoke(operationId, input, options = {}) {
			const operation = operations.get(operationId);
			if (!operation) throw new Error(`TreeDX proxy operation ${operationId} is not part of the accepted SDK catalog.`);
			const invocation = record(input);
			const requestedProjectId=text(record(invocation.path).projectId)||projectId;
			const readRepositories = Array.isArray(handle.readRepositories)
				? handle.readRepositories.map(record)
				: Array.isArray(record(handle.metadata).readRepositories)
					? (record(handle.metadata).readRepositories as unknown[]).map(record)
					: [];
			const authorizedProjectId = requestedProjectId === projectId
				|| readRepositories.some((candidate) => text(candidate.projectId) === requestedProjectId)
				? requestedProjectId
				: projectId;
			return client.invoke(operation, { path: { ...record(invocation.path), projectId:authorizedProjectId }, query: record(invocation.query), body: invocation.body }, {
				authorization: `Bearer ${await accessToken()}`,
				headers: { 'x-treeseed-assignment-id': assignmentId, 'x-treeseed-treedx-proxy-handle-id': handleId,
					...(handleToken ? { 'x-treeseed-treedx-proxy-handle': handleToken } : {}) },
				signal: options.signal, idempotencyKey: options.idempotencyKey,
			});
		},
	};
}
