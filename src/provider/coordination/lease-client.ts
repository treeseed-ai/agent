import type { ProviderRuntimeEventInput } from '@treeseed/sdk/agent-capacity';

export interface ProviderAssignmentClient {
	nextAssignment(request?: Record<string, unknown>): Promise<unknown>;
	assignment?(assignmentId: string): Promise<unknown>;
	createAssignmentModeRun(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	createAssignmentEvent?(assignmentId: string, request: ProviderRuntimeEventInput): Promise<unknown>;
	publishAssignmentSignal?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	preflightAssignmentCompletion?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	completeAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	failAssignment(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	reportAssignmentUsage?(assignmentId: string, request: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
	settleAssignment?(assignmentId: string, request: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
	renewAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	returnAssignment?(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
	dispatchAssignmentWorkflowOperation?(assignmentId: string, operationId: string, request: Record<string, unknown>): Promise<unknown>;
	getAssignmentWorkflowRun?(assignmentId: string, runId: string): Promise<unknown>;
}

// Settlement consumes the reservation before completion releases the lease.
// Close local renewal authority before that financial terminal boundary so a
// timer already queued for the same assignment cannot renew against a consumed
// reservation during the settlement-to-completion handoff.
const TERMINAL_METHODS = new Set<PropertyKey>(['settleAssignment', 'completeAssignment', 'failAssignment', 'returnAssignment']);

export function providerAssignmentClientWithTerminalBoundary(
	client: ProviderAssignmentClient,
	onTerminalizing: () => void,
): ProviderAssignmentClient {
	return new Proxy(client, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== 'function') return value;
			if (TERMINAL_METHODS.has(property)) {
				return (...args: unknown[]) => {
					onTerminalizing();
					return Reflect.apply(value, target, args);
				};
			}
			return value.bind(target);
		},
	});
}
