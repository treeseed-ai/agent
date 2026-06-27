import type {
	AgentExpectedOutput,
	AgentHandlerKind,
	AgentRuntimeSpec,
	AgentRunStatus,
	AgentWorkPackage,
	ExecutionArtifactRef,
	ExecutionPreparationResult,
	ExecutionProviderDescriptor,
	ExecutionProviderObservation,
	ExecutionProviderObserveInput,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
	ExecutionWorkspaceContext,
	AgentTriggerConfig,
} from '@treeseed/sdk/types/agents';
export type { ExecutionPreparationResult } from '@treeseed/sdk/types/agents';
import type { AgentErrorCategory } from './contracts/run.ts';
import type { ScopedAgentSdk } from '@treeseed/sdk/sdk';
import type { SdkMessageEntity } from '@treeseed/sdk/types';
import type {
	AgentOperationGrant,
	AgentOperationRequest,
	AgentOperationResult,
} from '@treeseed/sdk/operations/agent-tools';
import type {
	AgentCapacityEnvelope,
	ProviderAssignmentCapabilityHandles,
	AgentAssignmentWorkspaceAccessMode,
	AgentExecutionMode,
	AgentKernelPolicy,
	AgentKernelProfile,
	DecisionExecutionInput,
	ProviderAssignment,
	ProjectAgentClass,
} from '@treeseed/sdk/agent-capacity';

export interface AgentTriggerInvocation {
	kind: 'startup' | 'schedule' | 'message' | 'manual' | 'follow';
	source: string;
	trigger: AgentTriggerConfig;
	message?: SdkMessageEntity | null;
	followModels?: string[];
	cursorValue?: string | null;
}

export interface AgentHandlerOutput {
	status: AgentRunStatus;
	summary: string;
	stdout?: string;
	stderr?: string;
	errorCategory?: AgentErrorCategory | null;
	metadata?: Record<string, unknown>;
}

export interface AgentMutationResult {
	branchName: string | null;
	commitMessage: string | null;
	worktreePath: string | null;
	commitSha: string | null;
	changedPaths: string[];
}

export interface AgentRepositoryInspectionResult {
	branchName: string | null;
	changedPaths: string[];
	commitSha: string | null;
	summary: string;
}

export interface AgentVerificationResult {
	status: 'completed' | 'failed' | 'waiting';
	summary: string;
	stdout?: string;
	stderr?: string;
	errorCategory?: AgentErrorCategory | null;
}

export interface AgentNotificationResult {
	status: 'completed' | 'failed' | 'waiting';
	summary: string;
	deliveredCount: number;
}

export interface AgentResearchResult {
	status: 'completed' | 'failed' | 'waiting';
	summary: string;
	markdown: string;
	sources?: string[];
	errorCategory?: AgentErrorCategory | null;
}

export interface ExecutionProviderInvocation {
	assignment: ProviderAssignment;
	capacityEnvelope: AgentCapacityEnvelope;
	decisionInput: DecisionExecutionInput;
	agent: AgentRuntimeSpec;
	workPackage: AgentWorkPackage;
	leaseToken: string | null;
	runnerId: string;
	projectAgentClass?: ProjectAgentClass | null;
	workspace?: ExecutionWorkspaceContext | null;
	tools?: ExecutionProviderToolDescriptor[];
	metadata?: Record<string, unknown>;
}

export type ExecutionProviderToolKind = 'agent_tool';

export interface ExecutionProviderToolDescriptor {
	kind: ExecutionProviderToolKind;
	id: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	executionTarget: 'sdk_dispatch' | 'treedx_proxy' | 'treeseed_content' | 'provider_runner';
	mutability: 'read' | 'content_write' | 'worktree_write' | 'shared_state_write';
	metadata?: Record<string, unknown>;
}

export interface TreeDxProxyExecutionToolDescriptor extends ExecutionProviderToolDescriptor {
	kind: 'agent_tool';
	executionTarget: 'treedx_proxy';
	projectId: string;
	assignmentId: string;
	handleId: string;
	repositoryId?: string | null;
	workspaceId?: string | null;
	allowedOperations: string[];
	allowedPaths: string[];
	allowedReadPaths?: string[];
	allowedWritePaths?: string[];
	routes: {
		buildContext: string;
		readRepositoryFiles: string;
		searchWorkspace: string;
		readWorkspaceFile: string;
		writeWorkspaceFile: string;
		commitWorkspace: string;
	};
}

export interface ExecutionProviderAdapter {
	describe(): ExecutionProviderDescriptor | Promise<ExecutionProviderDescriptor>;
	observe(input: ExecutionProviderObserveInput): Promise<ExecutionProviderObservation>;
	prepare?(input: ExecutionProviderInvocation): Promise<ExecutionPreparationResult>;
	start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot>;
	poll?(input: ExecutionRunRef): Promise<ExecutionRunSnapshot>;
	resume?(input: ExecutionRunRef): Promise<ExecutionRunSnapshot>;
	cancel?(input: ExecutionRunRef & { reason: string }): Promise<ExecutionRunSnapshot>;
	collectUsage?(input: ExecutionRunRef): Promise<ExecutionUsageActual[]>;
	collectArtifacts?(input: ExecutionRunRef): Promise<ExecutionArtifactRef[]>;
}

export interface AgentMutationAdapter {
	writeArtifact(input: {
		runId: string;
		agent: AgentRuntimeSpec;
		relativePath: string;
		content: string;
		commitMessage: string;
	}): Promise<AgentMutationResult>;
}

export interface AgentRepositoryInspectionAdapter {
	inspectBranch(input: {
		repoRoot: string;
		branchName: string | null;
	}): Promise<AgentRepositoryInspectionResult>;
}

export interface AgentVerificationAdapter {
	runChecks(input: {
		agent: AgentRuntimeSpec;
		runId: string;
		commands: string[];
		cwd?: string;
	}): Promise<AgentVerificationResult>;
}

export interface AgentNotificationAdapter {
	deliver(input: {
		agent: AgentRuntimeSpec;
		runId: string;
		recipients: string[];
		subject: string;
		body: string;
	}): Promise<AgentNotificationResult>;
}

export interface AgentResearchAdapter {
	research(input: {
		agent: AgentRuntimeSpec;
		runId: string;
		questionId: string;
		reason: string | null;
	}): Promise<AgentResearchResult>;
}

export interface AgentOperationsAdapter {
	runOperation(input: {
		request: AgentOperationRequest;
		grants: AgentOperationGrant[];
		sdk?: ScopedAgentSdk;
	}): Promise<AgentOperationResult>;
}

export interface AgentTreeDxAdapter {
	buildContext(input: { repoId: string; query?: string | null; paths?: string[]; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
	listRepositoryPaths(input: { repoId: string; path: string; ref?: string | null; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
	readRepositoryFiles(input: { repoId: string; paths: string[]; ref?: string | null; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
	searchWorkspace(input: { workspaceId: string; query: string; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
	readWorkspaceFile(input: { workspaceId: string; path: string }): Promise<Record<string, unknown>>;
	writeWorkspaceFile(input: { workspaceId: string; path: string; content: string; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
	commitWorkspace(input: { workspaceId: string; message: string; body?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface AgentContext {
	runId: string;
	repoRoot: string;
	agent: AgentRuntimeSpec;
	capacity?: {
		assignmentId: string;
		providerId: string;
		mode: AgentExecutionMode;
		envelope: AgentCapacityEnvelope;
		decisionInput: DecisionExecutionInput;
		projectAgentClass?: ProjectAgentClass | null;
		kernelProfile?: AgentKernelProfile | null;
		kernelPolicy?: AgentKernelPolicy | null;
		assignment?: ProviderAssignment;
		readiness?: Record<string, unknown> | null;
		treedxProxyHandle?: Record<string, unknown> | null;
		capabilityHandles?: ProviderAssignmentCapabilityHandles | Record<string, unknown> | null;
		workspaceAccessMode?: AgentAssignmentWorkspaceAccessMode | string | null;
		fallbackReason?: string | null;
	};
	coreObjective?: {
		path: string;
		content: string;
		message: string;
	} | null;
	sdk: ScopedAgentSdk;
	trigger: AgentTriggerInvocation;
	execution: ExecutionProviderAdapter;
	mutations: AgentMutationAdapter;
	repository: AgentRepositoryInspectionAdapter;
	verification: AgentVerificationAdapter;
	notifications: AgentNotificationAdapter;
	research: AgentResearchAdapter;
	operations: AgentOperationsAdapter;
	treeDx?: AgentTreeDxAdapter | null;
}

export interface AgentHandler<TInputs = unknown, TResult = unknown> {
	kind: AgentHandlerKind;
	resolveInputs(context: AgentContext): Promise<TInputs>;
	execute(context: AgentContext, inputs: TInputs): Promise<TResult>;
	emitOutputs(context: AgentContext, result: TResult): Promise<AgentHandlerOutput>;
}

export type { AgentExpectedOutput, AgentWorkPackage };

export {};
