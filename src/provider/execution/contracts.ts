export interface AgentExecutionRequest {
  assignment: Record<string, unknown>;
  assignmentId: string;
  leaseToken: string;
  runnerId: string;
  signal?: AbortSignal;
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed' | 'returned';
  summary: string;
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
}

export interface AgentExecutorModule {
  createAgentExecutor(input: { executionProviderId: string; environment: string }): AgentExecutor | Promise<AgentExecutor>;
}
