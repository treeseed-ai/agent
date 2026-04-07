import type {
	AgentHandlerKind,
	AgentRuntimeSpec,
	AgentRunStatus,
	AgentTriggerConfig,
} from '@treeseed/core/types/agents';
import type { AgentErrorCategory } from './contracts/run.ts';
import type { ScopedAgentSdk } from './sdk.ts';
import type { SdkMessageEntity } from './sdk-types';

export interface AgentTriggerInvocation {
	kind: 'startup' | 'schedule' | 'message' | 'manual' | 'follow';
	source: string;
	trigger: AgentTriggerConfig;
	message?: SdkMessageEntity | null;
	followModels?: string[];
	cursorValue?: string | null;
}

export interface AgentExecutionResult {
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

export interface AgentExecutionAdapter {
	runTask(input: {
		agent: AgentRuntimeSpec;
		runId: string;
		prompt: string;
	}): Promise<AgentExecutionResult>;
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

export interface AgentContext {
	runId: string;
	repoRoot: string;
	agent: AgentRuntimeSpec;
	sdk: ScopedAgentSdk;
	trigger: AgentTriggerInvocation;
	execution: AgentExecutionAdapter;
	mutations: AgentMutationAdapter;
	repository: AgentRepositoryInspectionAdapter;
	verification: AgentVerificationAdapter;
	notifications: AgentNotificationAdapter;
	research: AgentResearchAdapter;
}

export interface AgentHandler<TInputs = unknown, TResult = unknown> {
	kind: AgentHandlerKind;
	resolveInputs(context: AgentContext): Promise<TInputs>;
	execute(context: AgentContext, inputs: TInputs): Promise<TResult>;
	emitOutputs(context: AgentContext, result: TResult): Promise<AgentExecutionResult>;
}
