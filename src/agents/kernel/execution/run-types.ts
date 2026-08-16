import type { AgentCapacityEnvelope, AgentKernelModeExecutionInput, AgentModeRunStatus } from '@treeseed/sdk/agent-capacity';

export interface AgentKernelModeRunTelemetryInput {
	id?: string;
	status: AgentModeRunStatus;
	selectedInput: Record<string, unknown>;
	capacityEnvelope: AgentCapacityEnvelope;
	outputs?: Record<string, unknown>;
	traceRefs?: Record<string, unknown>;
	usageActual?: Record<string, unknown> | null;
	validation?: Record<string, unknown>;
	fallbackReason?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	failedAt?: string | null;
	metadata?: Record<string, unknown>;
}

export interface AgentKernelAssignmentRunOptions extends AgentKernelModeExecutionInput {
	signal?: AbortSignal;
	recordModeRun?: (run: AgentKernelModeRunTelemetryInput) => Promise<unknown>;
	recordFallbackOutput?: (output: Record<string, unknown>) => Promise<unknown>;
}
