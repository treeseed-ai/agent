export type AgentErrorCategory =
	| 'trigger_resolution_error'
	| 'permission_error'
	| 'message_claim_error'
	| 'lease_error'
	| 'execution_error'
	| 'mutation_error'
	| 'sdk_error';

export interface AgentRunTrace {
	[key: string]: unknown;
	runId: string;
	agentSlug: string;
	handlerKind: string;
	triggerKind: string;
	triggerSource: string;
	claimedMessageId: number | null;
	selectedItemKey: string | null;
	branchName: string | null;
	commitSha: string | null;
	changedPaths: string[];
	summary: string | null;
	error: string | null;
	errorCategory: AgentErrorCategory | null;
	startedAt: string;
	finishedAt: string | null;
	status: string;
}
