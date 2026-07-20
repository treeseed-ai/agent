export interface ProviderAssignmentClient {
	nextAssignment(request?: Record<string, unknown>): Promise<unknown>;
	createAssignmentModeRun(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	completeAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	failAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	reportAssignmentUsage?(assignmentId: string, request: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
	settleAssignment?(assignmentId: string, request: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
	renewAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	returnAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	dispatchAssignmentWorkflowOperation?(assignmentId: string, operationId: string, request: Record<string, unknown>): Promise<unknown>;
}
