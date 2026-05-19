import type { AgentSdk } from '@treeseed/sdk';
import type { KnowledgeDraft, OptimizationReport } from '../agents/contracts/knowledge.ts';
import type { ResearchNote } from '../agents/contracts/research.ts';

type GovernanceSdk = Pick<AgentSdk, 'createApprovalRequest' | 'upsertTeamInboxItem' | 'appendTaskEvent' | 'createMessage'>;

function unique(values: string[]) {
	return [...new Set(values.filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

function sourceMapRefs(note: ResearchNote) {
	return note.sourceMap.map((entry) => ({
		claim: entry.claim,
		sourceFiles: entry.sourceFiles,
		sourceSymbolsOrSections: entry.sourceSymbolsOrSections,
		evidenceStrength: entry.evidenceStrength,
		uncertainty: entry.uncertainty,
		lastObservedRef: entry.lastObservedRef,
	}));
}

function artifactRefs(input: {
	draft: KnowledgeDraft;
	report: OptimizationReport;
	note: ResearchNote;
	promotionRequest: Record<string, unknown>;
}) {
	return [
		{ artifactKind: 'research_note', id: input.note.id },
		{ artifactKind: 'knowledge_draft', id: input.draft.id, targetPath: input.draft.targetPath },
		{ artifactKind: 'optimization_report', id: input.report.id, totalScore: input.report.totalScore, recommendation: input.report.recommendation },
		{ artifactKind: 'promotion_request', id: String(input.promotionRequest.id ?? `promotion:${input.draft.id}`), draftId: input.draft.id },
	];
}

function approvalOptions() {
	return [
		{ id: 'approve_as_book_content', label: 'Approve content', decision: 'approve' },
		{ id: 'request_more_research', label: 'Request changes', decision: 'request_changes' },
		{ id: 'defer', label: 'Defer', decision: 'defer' },
		{ id: 'reject', label: 'Reject', decision: 'reject' },
	];
}

export function teamIdForGovernance(input: { teamId?: string | null; projectId: string }) {
	return input.teamId?.trim()
		|| process.env.TREESEED_TEAM_ID?.trim()
		|| process.env.TREESEED_HOSTING_TEAM_ID?.trim()
		|| process.env.TREESEED_CONTENT_DEFAULT_TEAM_ID?.trim()
		|| input.projectId;
}

export async function persistPromotionApprovalRequest(input: {
	sdk: GovernanceSdk;
	projectId: string;
	teamId?: string | null;
	workDayId: string;
	taskId: string;
	draft: KnowledgeDraft;
	report: OptimizationReport;
	note: ResearchNote;
	promotionRequest: Record<string, unknown>;
	promotionTaskId?: string | null;
	policySnapshot?: Record<string, unknown> | null;
}) {
	const approvalId = String(input.promotionRequest.id ?? `promotion:${input.draft.id}`);
	const teamId = teamIdForGovernance({ teamId: input.teamId, projectId: input.projectId });
	const sources = unique(input.note.sourceMap.flatMap((entry) => entry.sourceFiles));
	const refs = artifactRefs(input);
	const sourceRefs = sourceMapRefs(input.note);
	const changedPaths = [input.draft.targetPath];
	const verificationPlan = {
		commands: [],
		reviewRequired: true,
		sourceMapRequired: true,
	};
	const recommendation = {
		action: 'approve',
		recommendation: input.report.recommendation,
		totalScore: input.report.totalScore,
		remainingIssues: input.report.remainingIssues,
		criticalIssues: input.report.criticalIssues,
		artifactRefs: refs,
		sourceMapRefs: sourceRefs,
		changedPaths,
		verificationPlan,
	};
	const metadata = {
		approvalKind: 'promote_knowledge_draft',
		draftId: input.draft.id,
		targetPath: input.draft.targetPath,
		sourceQuestionId: input.draft.sourceQuestionId,
		sourceResearchIds: input.draft.sourceResearchIds,
		sourceResearchNoteId: input.note.id,
		optimizationReportId: input.report.id,
		promotionTaskId: input.promotionTaskId ?? null,
		promotionRequest: input.promotionRequest,
		artifactRefs: refs,
		sourceMapRefs: sourceRefs,
		sourceRefs: sources,
		changedPaths,
		verificationPlan,
		policySnapshot: input.policySnapshot ?? {
			approvalPolicy: 'manual',
			requireHumanApprovalForCanonicalKnowledge: true,
			requireHumanApprovalForRelease: true,
		},
	};
	const approval = await input.sdk.createApprovalRequest({
		id: approvalId,
		teamId,
		projectId: input.projectId,
		workDayId: input.workDayId,
		taskId: input.promotionTaskId ?? input.taskId,
		kind: 'promote_knowledge_draft',
		severity: input.report.criticalIssues.length ? 'high' : 'medium',
		requestedByType: 'agent',
		requestedById: 'treeseed-governance-steward',
		title: `Promote ${input.draft.title}`,
		summary: `Promote ${input.draft.targetPath} after source-map and optimization review.`,
		options: approvalOptions(),
		recommendation,
		policySnapshot: metadata.policySnapshot,
		metadata,
	});
	const approvalRecord = approval.payload;
	if (approvalRecord?.state === 'pending') {
		await input.sdk.upsertTeamInboxItem({
			id: `approval:${approvalId}`,
			teamId,
			projectId: input.projectId,
			kind: 'approval_required',
			state: 'waiting_for_approval',
			title: `Approval required: ${input.draft.title}`,
			summary: `Generated knowledge scored ${input.report.totalScore} and is waiting for promotion review.`,
			href: `/app/governance/${encodeURIComponent(approvalId)}`,
			itemKey: `approval:${approvalId}`,
			metadata: {
				approvalId,
				approvalKind: 'promote_knowledge_draft',
				draftId: input.draft.id,
				targetPath: input.draft.targetPath,
				totalScore: input.report.totalScore,
			},
		});
	}
	await input.sdk.appendTaskEvent({
		taskId: input.taskId,
		kind: 'approval_request_created',
		data: { approvalId, approvalKind: 'promote_knowledge_draft', state: approvalRecord?.state ?? 'pending' },
		actor: 'worker',
	});
	await input.sdk.appendTaskEvent({
		taskId: input.taskId,
		kind: 'team_inbox_item_created',
		data: { approvalId, inboxItemId: `approval:${approvalId}`, teamId, state: approvalRecord?.state ?? 'pending' },
		actor: 'worker',
	});
	await input.sdk.createMessage({
		type: 'approval_request_created',
		payload: {
			approvalId,
			approvalKind: 'promote_knowledge_draft',
			draftId: input.draft.id,
			targetPath: input.draft.targetPath,
			totalScore: input.report.totalScore,
		},
		relatedModel: 'approval_request',
		relatedId: approvalId,
		priority: 85,
	});
	await input.sdk.createMessage({
		type: 'team_inbox_item_created',
		payload: {
			approvalId,
			inboxItemId: `approval:${approvalId}`,
			teamId,
			state: approvalRecord?.state === 'pending' ? 'waiting_for_approval' : approvalRecord?.state ?? 'pending',
		},
		relatedModel: 'team_inbox_item',
		relatedId: `approval:${approvalId}`,
		priority: 80,
	});
	return approvalRecord;
}
