import type { AgentContext } from '../runtime-types.ts';
import type { HandlerPayload } from './shared.ts';
import type { ExecutionContentSubject } from './execution-content-context.ts';

function firstString(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function contentContract(contentRoot: string, assignedObjective: Record<string, unknown> | null) {
	return [
		'Knowledge Hub content contract:',
		`- Content root: ${contentRoot}`,
		`- Assigned objective: ${firstString(assignedObjective?.path) ?? 'not supplied by the assignment'}`,
		`- Agent specs: ${contentRoot}/agents/*.mdx`,
		`- Notes and feedback: ${contentRoot}/notes/**`,
		`- Questions: ${contentRoot}/questions/*.mdx`,
		`- Proposals: ${contentRoot}/proposals/*.mdx`,
		`- Decisions: ${contentRoot}/decisions/*.mdx`,
		`- Knowledge pages and book pages: ${contentRoot}/knowledge/**`,
		`- Book records: ${contentRoot}/books/*.mdx; book pages are knowledge pages linked from book sidebar metadata.`,
		'- Prefer durable MDX content over database-only output whenever another agent will need the information.',
	].join('\n');
}

function subjectRelation(subject: ExecutionContentSubject) {
	if (!subject.model || !subject.id) return null;
	const field = ({
		objective: 'relatedObjectives',
		question: 'relatedQuestions',
		proposal: 'relatedProposals',
		decision: 'relatedDecisions',
	} as Record<string, string>)[subject.model.replace(/s$/u, '')];
	return field ? { field, targetModel: subject.model.replace(/s$/u, ''), targetSlug: subject.id } : { field: 'about', targetModel: subject.model, targetSlug: subject.id };
}

export function targetExecutionContentDescription(artifactKind: string) {
	if (artifactKind === 'proposal_estimate') return 'A linked estimate note with assumptions, p50/p90 effort, risks, and capacity implications.';
	if (artifactKind === 'question_answer') return 'A linked answer note with direct answer, evidence, uncertainty, and follow-up questions.';
	if (artifactKind === 'decision_feedback') return 'A linked decision feedback note with recommendation, consequences, risks, and unresolved inputs.';
	return 'A linked agent feedback note with source-grounded planning, recommendations, risks, and next actions.';
}

function executionDeliverableContract(artifactKind: string, payload: HandlerPayload) {
	const researchStage = firstString(payload.researchStage);
	if (researchStage) {
		const minimumSources = Number(payload.minimumIndependentSources ?? 2);
		const maxRevisionCycles = Number(payload.maxRevisionCycles ?? 3);
		const latestReviewAttempt = payload.latestReviewAttempt && typeof payload.latestReviewAttempt === 'object' && !Array.isArray(payload.latestReviewAttempt)
			? payload.latestReviewAttempt as Record<string, unknown>
			: null;
		const latestReviewReason = firstString(latestReviewAttempt?.reason);
		const common = [
			`Assigned governed research stage: ${researchStage}.`,
			'- Complete only this stage, create the required linked Knowledge Hub artifact(s), validate them, and commit the TreeDX workspace.',
		];
		const stageInstructions: Record<string, string[]> = {
			'question-decomposition': [
				'Create a new question model artifact that decomposes the assigned root question into bounded subquestions.',
				'Link the decomposition question to the assigned root question through relatedQuestions. A note cannot satisfy the required planning_question artifact.',
			],
			'source-selection-criteria': ['Create a linked note defining authority, independence, recency, relevance, and exclusion criteria for sources.'],
			'governed-source-search': ['Use the available TreeSeed tool with callName research_search_sources (policy id research.search_sources) when configured; otherwise create a linked search-plan note naming the governed allowed domains and exact queries. Search for and invoke the callName, not the dotted policy id.'],
			'independent-source-fetch': [
				`Fetch at least ${minimumSources} sources from independent allowed publishers with the available TreeSeed tool whose callName is research_fetch_source (policy id research.fetch_source). Search for and invoke the callName, not the dotted policy id.`,
				'For this acceptance workflow, use https://example.com and https://www.iana.org/domains/reserved when they satisfy the governed policy.',
				'On every fetch supply title, publisher, claimIds ["claim-1"], and confidence. A content note alone cannot satisfy this stage.',
				'After both fetch receipts succeed, create, validate, and commit a linked planning note recording both authenticated source URLs and publishers.',
			],
			'linked-evidence-notes': [`Create at least ${minimumSources} distinct linked evidence notes, one per authenticated citation in the assignment input.`],
			'claim-synthesis': [
				'Call treeseed.research_claims with at least one material claim whose id is "claim-1", status is "unsupported", and citationIds is empty.',
				'Create a linked synthesis note that clearly marks that claim unsupported so independent review must reject it.',
			],
			'citation-review-rejection': [
				'Review the claim-to-citation evidence and call treeseed.review_decision with disposition "rejected" and a concrete reason for the unsupported material claim.',
			],
			revision: [
				`This workflow permits at most ${maxRevisionCycles} revision cycles; make a substantive evidence-grounded correction rather than changing only status or citation ids.`,
				...(latestReviewReason ? [`The latest independent review rejected the prior wording for this reason: ${latestReviewReason}`] : []),
				'Revise claim "claim-1" itself so its exact text is no broader than facts established by the authenticated sources, then call treeseed.research_claims with that revised text, status "supported", and citationIds containing the authenticated source URLs.',
				'For the reserved-domain acceptance sources, a valid bounded claim describes their documented reservation and documentation-example purpose; they do not substantiate project-specific product or research-priority recommendations.',
				'Create a linked revision note that quotes the revised claim and explains separately how each cited source supports its exact wording.',
			],
			'citation-review-approval': [
				'Independently review the revised claim-to-citation evidence and call treeseed.review_decision with disposition "approved" only if no material claim remains unsupported.',
			],
			'cited-knowledge-publication': ['Create, validate, and commit a knowledge model artifact containing the approved claims and citations.'],
			'workday-report': ['Create, validate, and commit a linked note whose artifact is the final workday summary and includes workflow outcomes and publication reference.'],
		};
		return [...common, ...(stageInstructions[researchStage] ?? ['Follow the exact researchStage contract in the assignment input.'])].join('\n');
	}
	if (artifactKind === 'failing_test_proof') {
		return [
			'Assigned deliverable contract: failing_test_proof.',
			'- Add a behaviorally meaningful regression test before implementation.',
			'- Run the bounded test with the nonzero expected exit code that proves the unimplemented behavior fails.',
			'- Checkpoint the authored test after the failing verification receipt. Do not modify implementation code.',
		].join('\n');
	}
	if (artifactKind === 'implementation_change' || artifactKind === 'implementation_revision') {
		return [
			`Assigned deliverable contract: ${artifactKind}.`,
			'- Modify implementation code, not the governed test, to satisfy the inherited test-first evidence.',
			'- Run bounded passing verification with expected exit code 0, then checkpoint the source change.',
		].join('\n');
	}
	if (artifactKind === 'passing_verification' || artifactKind === 'revision_verification') {
		return [
			`Assigned deliverable contract: ${artifactKind}.`,
			'- Verify the inherited implementation and regression test at the assigned exact ref.',
			'- Run bounded verification with expected exit code 0. A passing result is the required evidence.',
			'- Do not create a new red test, modify repository files, or create a source checkpoint merely to complete this verification stage.',
		].join('\n');
	}
	if (artifactKind === 'review_decision' || artifactKind === 'revision_review_decision') {
		const reviewPolicy = payload.governedReviewPolicy && typeof payload.governedReviewPolicy === 'object' && !Array.isArray(payload.governedReviewPolicy)
			? payload.governedReviewPolicy as Record<string, unknown>
			: {};
		const requiredRevision = reviewPolicy.requiredDisposition === 'rejected';
		return [
			`Assigned deliverable contract: ${artifactKind}.`,
			'- Evaluate the current exact source ref using only the authenticated governedPredecessorEvidence and any fresh bounded verification you perform.',
			'- Required upstream gates are the completed graph ancestors represented in governedPredecessorEvidence. Do not require documentation, release readiness, operations handoff, workday summary, usage settlement, or any other downstream artifact that is graph-blocked by this review.',
			...(requiredRevision ? [
				'- The accepted governedReviewPolicy requires this initial review to reject once so the system executes a fresh implementation, verification, and independent re-review cycle before approval.',
				'- Record a concrete objective-scoped revision request grounded in the authenticated upstream evidence. Do not invent a downstream prerequisite or approve this initial review.',
			] : [
				'- Approve when the upstream test-first, implementation, and passing-verification evidence supports the assigned objective; reject only with a concrete defect or missing required upstream evidence.',
			]),
		].join('\n');
	}
	return `Assigned deliverable contract: ${artifactKind}.`;
}

export function buildExecutionContentInstructions(context: AgentContext, input: {
	payload: HandlerPayload;
	subject: ExecutionContentSubject;
	artifactKind: string;
	contextPackSummaries: unknown[];
	assignedObjective: Record<string, unknown> | null;
	contentRoot: string;
}) {
	const relation = subjectRelation(input.subject);
	return [
		context.agent.systemPrompt,
		'',
		firstString(input.assignedObjective?.message) ?? 'No assigned objective was supplied or resolved through TreeDX; report that as a blocker only when the activity contract requires objective provenance.',
		'',
		contentContract(input.contentRoot, input.assignedObjective),
		'',
		executionDeliverableContract(input.artifactKind, input.payload),
		...(relation ? ['', `Required content relation: ${JSON.stringify(relation)}. Supply this relation during create/update or through treeseed.content.link, then verify the returned receipt contains subjectId and subjectField.`] : []),
		'',
		'Assignment input:',
		JSON.stringify({ mode: context.capacity?.mode ?? 'planning', assignmentId: context.capacity?.assignmentId ?? null, subject: input.subject, payload: input.payload }, null, 2),
		'',
		'Resolved context packs:',
		JSON.stringify(input.contextPackSummaries, null, 2),
		'',
		'Use available assignment-scoped TreeSeed tools as the source of truth for Knowledge Hub content evidence, reads, writes, and commits. If the provided context is insufficient, call the available tools before reporting a blocked result.',
		'',
		'Return a concise final summary of the content changes, tool calls, and verification. Content changes should be made through the assignment-scoped tools, not by relying on deterministic handler post-processing.',
	].join('\n');
}
