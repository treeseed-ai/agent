import type {
	AgentOperationGrant,
	AgentOperationResult,
	AgentOperationApprovalRef,
} from '@treeseed/sdk/operations/agent-tools';
import type { AgentVerificationResult } from '../runtime-types.ts';
import type { CodexExecutionResult, CodexSandboxMode } from '../adapters/execution-codex.ts';

export type ImplementationLifecycleStatus =
	| 'staged'
	| 'completed'
	| 'waiting'
	| 'failed'
	| 'merge_failed';

export interface CodexDocsMutationTaskInput {
	taskId: string;
	workDayId?: string;
	taskKind: 'implementation' | string;
	agentRole: 'engineer' | string;
	projectId: string;
	environment: string;
	provider: 'codex' | 'codex_subscription' | string;
	releaseAllowed: boolean;
	goal: string;
	featureBranch: string;
	stagingBranch: string;
	approvalId?: string;
	approval?: AgentOperationApprovalRef;
	permissionGrantId?: string;
	operationGrants: AgentOperationGrant[];
	allowedPaths: string[];
	forbiddenPaths: string[];
	verificationCommands: string[];
	sandboxMode: CodexSandboxMode;
	model?: string;
	reasoningEffort?: 'low' | 'medium' | 'high';
	threadId?: string;
	contextPackSummary?: string;
	workPackage?: Record<string, unknown>;
}

export interface AgentWorktreeSnapshot {
	kind: 'verified' | 'failure' | 'merge_failure';
	ref: string;
	summary: string;
	changedPaths: string[];
	createdAt: string;
}

export interface AgentRepairTaskPayload {
	taskKind: 'implementation_repair';
	sourceTaskId: string;
	featureBranch: string;
	stagingBranch: string;
	worktreeRoot: string;
	conflictedPaths: string[];
	mergeMessage: string;
	allowedPaths: string[];
	forbiddenPaths: string[];
}

export interface CodexDocsMutationResult {
	status: ImplementationLifecycleStatus;
	summary: string;
	taskId: string;
	workDayId?: string;
	featureBranch: string;
	stagingBranch: string;
	worktreeRoot: string | null;
	changedPaths: string[];
	codexResult?: CodexExecutionResult;
	verification?: AgentVerificationResult;
	operationResults: AgentOperationResult[];
	snapshots: AgentWorktreeSnapshot[];
	mergedToStaging: boolean;
	mergeFailure?: {
		targetBranch: string;
		featureBranch: string;
		conflictedPaths: string[];
		message: string;
		repairTaskId?: string;
	};
	repairTask?: AgentRepairTaskPayload;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	};
}
