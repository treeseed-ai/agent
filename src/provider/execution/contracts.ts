export interface AssignmentTreeDxFacade {
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly workspaceId: string | null;
  readonly baseRef?: string | null;
  invoke(operationId: string, input: Record<string, unknown>, options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<unknown>;
}

export interface AgentExecutionRequest {
  assignment: Record<string, unknown>;
  assignmentId: string;
  leaseToken: string;
  runnerId: string;
  treeDx: AssignmentTreeDxFacade;
  signal?: AbortSignal;
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed' | 'returned' | 'responded' | 'abstained';
  summary: string;
	responseMarkdown?: string;
  retryable?: boolean;
  code?: string;
  outputs?: Record<string, unknown>;
  usage?: Record<string, unknown>[];
  artifacts?: Record<string, unknown>[];
}

export interface AgentExecutorObservation {
  available: boolean;
  activeAssignments?: number;
  capabilities?: string[];
  reason?: string;
}

export interface AgentExecutor {
  readonly id: string;
  observe(): Promise<AgentExecutorObservation>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  recover?(request: Pick<AgentExecutionRequest, 'assignment' | 'assignmentId' | 'runnerId'>): Promise<AgentExecutionResult | null>;
  shutdown?(): void | Promise<void>;
}

export interface AgentExecutorModule {
  createAgentExecutor(input: { executionProviderId: string; environment: string }): AgentExecutor | Promise<AgentExecutor>;
}
