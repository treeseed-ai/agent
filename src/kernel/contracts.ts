import type {
	AssignmentContext,
	AssignmentReference,
	AssignmentResult,
	ExactEntityReference,
} from '@treeseed/sdk/agent-capacity';

export interface ModelInvocationRequest {
	prompt: string;
	context: unknown[];
	parameters?: Record<string, unknown>;
}

export interface ModelInvocationResult {
	text: string;
	activityCompletion?: {
		summary: string;
		reviewDisposition: 'approved' | 'rejected' | 'revision-required' | null;
		contentOutput: { model: string; body: string; frontmatter: Record<string, unknown> } | null;
	};
	references?: AssignmentReference[];
	verification?: VerificationResult[];
	inputTokens?: number;
	outputTokens?: number;
}

export interface VerificationRequest {
	command: string;
}

export interface VerificationResult {
	command: string;
	status: 'passed' | 'failed' | 'skipped';
	exitCode: number;
	outputDigest: string;
	durationSeconds?: number;
}

export interface TreeDxCommitRequest {
	target: ExactEntityReference;
	value: unknown;
}

export interface SourceCommitRequest {
	message: string;
	paths: string[];
}

export interface AgentRuntime {
	readContext(ref: ExactEntityReference): Promise<unknown>;
	invokeModel(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
	runVerification(request: VerificationRequest): Promise<VerificationResult>;
	commitTreeDx(request: TreeDxCommitRequest): Promise<AssignmentReference>;
	commitSource(request: SourceCommitRequest): Promise<AssignmentReference>;
	now(): string;
}

export interface Handler {
	readonly id: string;
	run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult>;
}

export interface KernelAssignmentRequest {
	context: AssignmentContext;
	runtimeBuild: string;
	runtime: AgentRuntime;
	signal?: AbortSignal;
}
