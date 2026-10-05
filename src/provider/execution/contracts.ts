import type { SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';

export interface AssignmentTreeDxFacade {
  readonly projectId: string;
	readonly handleId: string;
  readonly repositoryId: string | null;
  readonly workspaceId: string | null;
  readonly baseRef?: string | null;
	readonly readRepositories?: Array<{projectId:string;projectSlug:string;repositoryId:string;baseRef:string;allowedPaths:string[];allowedModels:string[];source:string}>;
  invoke(operationId: string, input: Record<string, unknown>, options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<unknown>;
}

export interface AgentExecutionRequest {
  assignment: Record<string, unknown>;
  assignmentId: string;
  leaseToken: string;
  runnerId: string;
  treeDx: AssignmentTreeDxFacade;
  /** Trusted host callback; never serialized into context, tools or the execution guest. */
  authorizeSource?: (recipientPublicKey: string) => Promise<SourceWorkspaceResponse>;
	/** Start the API-owned productive window after sandbox/source preparation. */
	beginExecution?: () => Promise<Record<string, unknown>>;
	/** Stop productive accounting when the harness exits, before infrastructure teardown. */
	finishExecution?: () => Promise<void>;
	emit?: (event: { type: string; occurredAt: string; summary: string; payload: Record<string, unknown>; protectedPayload?: Record<string, unknown> }) => Promise<void>;
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
  renewLease?(assignmentId: string, leaseExpiresAt: string): Promise<void>;
  recover?(request: Pick<AgentExecutionRequest, 'assignment' | 'assignmentId' | 'runnerId'>): Promise<AgentExecutionResult | null>;
  shutdown?(): void | Promise<void>;
}

export interface AgentExecutorModule {
  createAgentExecutor(input: { executionProviderId: string; environment: string }): AgentExecutor | Promise<AgentExecutor>;
}
