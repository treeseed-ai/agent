import { TreeseedOperationsSdk } from '@treeseed/sdk';
import type { ApiWorkflowOperationResponse, WorkflowHttpOperationRequest } from './types.ts';

const HTTP_BLOCKED_WORKFLOW_OPERATIONS = new Set(['dev', 'dev:watch']);

export function isHttpWorkflowOperationAllowed(operation: string) {
	return !HTTP_BLOCKED_WORKFLOW_OPERATIONS.has(operation);
}

export async function executeHttpWorkflowOperation(
	operation: string,
	request: WorkflowHttpOperationRequest,
): Promise<ApiWorkflowOperationResponse> {
	if (!isHttpWorkflowOperationAllowed(operation)) {
		throw new Error(`Workflow operation "${operation}" is not supported over HTTP.`);
	}

	const operations = new TreeseedOperationsSdk();
	return operations.execute({
		operationName: operation,
		input: (request.input ?? {}) as Record<string, unknown>,
	}, {
		cwd: request.cwd ?? process.cwd(),
		env: {
			...process.env,
			...(request.env ?? {}),
		},
		transport: 'api',
	});
}
