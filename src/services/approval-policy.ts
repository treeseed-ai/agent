import type { AgentOperationGrant, AgentOperationName } from '@treeseed/sdk/operations/agent-tools';

export const PROMOTION_APPROVAL_DECISIONS = [
	'approve_as_book_content',
	'request_more_research',
	'reject',
] as const;

export const RELEASE_APPROVAL_DECISIONS = [
	'approve_release',
	'reject_release',
] as const;

export type PromotionApprovalDecision = typeof PROMOTION_APPROVAL_DECISIONS[number];
export type ReleaseApprovalDecision = typeof RELEASE_APPROVAL_DECISIONS[number];
export type AgentApprovalDecision = PromotionApprovalDecision | ReleaseApprovalDecision;
export type AgentApprovalKind = 'promote_knowledge_draft' | 'release_staged_knowledge';

export function defaultReleaseGrant(input: {
	taskId: string;
	projectId: string;
	environment: string;
	approvalId: string;
}) {
	return {
		id: `grant:knowledge-release:${input.taskId}`,
		state: 'active',
		operations: ['release'] as AgentOperationName[],
		modes: ['mutating'],
		agentRoles: ['releaser'],
		taskKinds: ['release_staged_knowledge_request'],
		projectIds: [input.projectId],
		environments: [input.environment],
		metadata: {
			source: 'staged_knowledge_release_request',
			approvalId: input.approvalId,
		},
	} satisfies AgentOperationGrant;
}
