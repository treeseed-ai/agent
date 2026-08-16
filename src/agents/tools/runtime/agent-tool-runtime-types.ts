import type {
	AgentToolExecutionTarget,
	AgentToolMutability,
	ResearchSourcePolicy,
} from '@treeseed/sdk';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import type { ExecutionProviderToolDescriptor } from '../../runtime/runtime-types.ts';

export interface AgentToolRuntimeOptions {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	leaseToken?: string | null;
	descriptors: ExecutionProviderToolDescriptor[];
	sdk?: Pick<AgentSdk, 'dispatch'>;
	fetchImpl?: typeof fetch;
	repoRoot?: string;
	telemetryPath?: string | null;
	onTelemetry?: (entry: AgentToolCallTelemetry) => void | Promise<void>;
	researchSourcePolicy?: ResearchSourcePolicy;
}

export interface AgentToolCallTelemetry {
	assignmentId: string;
	projectId: string;
	toolId: string;
	executionTarget: AgentToolExecutionTarget;
	mutability: AgentToolMutability;
	status: 'started' | 'completed' | 'failed';
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	inputSummary: Record<string, unknown>;
	outputSummary?: Record<string, unknown>;
	operation?: { namespace?: string; name?: string };
	capturedInputRef?: string;
	capturedOutputRef?: string;
	derivedEvents?: AgentToolDerivedEvent[];
	error?: { code: string; message: string };
}

export type AgentToolDerivedEvent =
	| { type: 'question_created'; questionRef: Record<string, unknown>; answerPolicy?: Record<string, unknown> }
	| { type: 'question_updated'; questionRef: Record<string, unknown> }
	| { type: 'content_created'; contentRef: Record<string, unknown>; requiresCommit?: boolean }
	| { type: 'content_updated'; contentRef: Record<string, unknown> }
	| { type: 'verification_completed'; status: 'passed'; summary: string; commands: string[] }
	| { type: 'branch_staged'; branchRef: string; stagedRef?: string }
	| { type: 'content_committed'; commitSha?: string; branchRef?: string }
	| { type: 'source_checkpoint_committed'; commitSha: string; branchRef?: string; changedPaths: string[] }
	| { type: 'review_decision_recorded'; disposition: 'approved' | 'rejected'; summary: string }
	| { type: 'research_citation_fetched'; citation: Record<string, unknown> }
	| { type: 'research_claims_recorded'; claims: Record<string, unknown>[] }
	| { type: 'signal_requested'; signal: Record<string, unknown> };
