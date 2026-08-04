import type { AgentContext } from '../runtime/runtime-types.ts';
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
		'- For a new artifact, create it before validation. Never validate or read back a target path that has not yet been created.',
		'- When validating a created or updated artifact, pass its exact changedPaths entry back as placement.path. A slug-only validation checks a newly rendered default-path record and is not evidence for the hierarchical artifact you wrote.',
		'- The validate tool does not accept a top-level path field. Supply the exact path only as placement.path.',
		'- Never batch-read inferred repository paths. Discover each record through TreeSeed content query or TreeDX search/context first, then read only exact paths returned by those operations. If no exact path is returned, report missing evidence instead of probing likely filenames.',
		'- For content reads, when the assignment or a query result supplies contentPath or path, pass that exact value as the read tool\'s top-level path. Do not replace a supplied path with an ID-derived default path.',
		'- A content commit makes the assignment workspace immutable. Complete every create, update, link, and validate operation first; commit exactly once as the final mutating action. After commit, perform read-only inspection only.',
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
	if (artifactKind === 'planning_proposal') {
		return [
			'Assigned deliverable contract: planning_proposal.',
			'- Research the assigned objective and inspect prior questions, notes, proposals, decisions, and relevant Guide content before drafting.',
			'- Create exactly one proposal linked through relatedObjectives to the durable objective supplied by the assignment.',
			'- Set primaryContributor to your configured agent identity and choose editorial or structural proposalType according to your responsibility.',
			'- Supply evidenceRefs that identify the exact research notes, content paths, or authenticated sources supporting the plan.',
			'- Supply a structured plan object containing desiredOutcome, currentProblem, proposedApproach, scope, nonGoals, deliverables, acceptanceCriteria, risks, dependencies, alternatives, verification, and openQuestions.',
			'- desiredOutcome, currentProblem, and proposedApproach must be substantive explanations, not labels or authorization boilerplate.',
			'- The proposal body must explain the recommendation for human review. It must never approve itself, authorize acting, or manufacture a decision.',
			'- Validate the proposal, repair every proposal_plan_incomplete diagnostic, then commit it through TreeDX.',
		].join('\n');
	}
	if (artifactKind === 'proposal_feedback_note') {
		return [
			'Assigned deliverable contract: proposal_feedback_note.',
			'- Read the exact generated proposal and its cited evidence before reviewing it.',
			'- Create one note linked to the proposal with feedbackKind set to support or concern; use concern when revision is required.',
			'- State the reviewed criteria, evidence, consequences, and a concrete requested revision where applicable.',
			'- Create a linked question instead when evidence is insufficient to reach either review disposition.',
			'- Validate and commit the feedback through TreeDX. Do not vote, approve, or decide the proposal.',
		].join('\n');
	}
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
	editorialInstructions?: string | null;
	contentRoot: string;
}) {
	const relation = subjectRelation(input.subject);
	return [
		context.agent.systemPrompt,
		'',
		firstString(input.assignedObjective?.message) ?? 'No assigned objective was supplied or resolved through TreeDX; report that as a blocker only when the activity contract requires objective provenance.',
		...(input.editorialInstructions ? ['', input.editorialInstructions] : []),
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
