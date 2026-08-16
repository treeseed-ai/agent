import type { AgentContext } from '../runtime/runtime-types.ts';
import type { HandlerPayload } from './shared.ts';
import type { ExecutionContentSubject } from './execution-content-context.ts';
import { assignmentTimeWindow } from '@treeseed/sdk/agent-capacity';

function firstString(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
		'- Before the first create or update for each model, call treeseed.content.describe with that model and follow the returned canonical fields, required values, and enums exactly. Never guess a status, type, or field from another model.',
		'- For a new artifact, create it before validation. Never validate or read back a target path that has not yet been created.',
		'- When one new artifact relates to another artifact created in this assignment, create the target first and use the exact canonical id returned in its create receipt. Never construct or guess a hierarchical relation id from the placement path.',
		'- Content validation resolves every stored relation against current TreeDX workspace data. A missing target or a target whose canonical id differs from the stored id is invalid even when the MDX schema itself parses.',
		'- When validating a created or updated artifact, pass its exact changedPaths entry back as placement.path. A slug-only validation checks a newly rendered default-path record and is not evidence for the hierarchical artifact you wrote.',
		'- The validate tool does not accept a top-level path field. Supply the exact path only as placement.path.',
		'- Never batch-read inferred repository paths. Discover each record through TreeSeed content query or TreeDX search/context first, then read only exact paths returned by those operations. If no exact path is returned, report missing evidence instead of probing likely filenames.',
		'- For content reads, when the assignment or a query result supplies contentPath or path, pass that exact value as the read tool\'s top-level path. Do not replace a supplied path with an ID-derived default path.',
		'- Dynamic context-query result payloads are transient execution input. They are never stored or committed as query results. Durable query evidence is limited to the exact definition revision, observed source ref, status, semantic assertions, aggregate statistics, and digests; do not describe the injected result text as persisted assignment evidence.',
		'- A permission or path denial is a failed integrity operation, not ordinary search evidence. Do not probe a path unless the exact path is present in admitted context or returned by a successful scoped query.',
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

export function assignmentTimeGuidance(context: AgentContext, nowMs = Date.now()) {
	const assignment = record(context.capacity?.assignment);
	const envelope = record(context.capacity?.envelope);
	const allocatedSeconds = Math.max(0, Math.floor(Number(envelope.reservedSeconds ?? envelope.requestedSeconds ?? 0)));
	const suppliedStart = firstString(assignment.claimedAt, assignment.assignedAt, envelope.startedAt);
	const parsedStart = suppliedStart ? Date.parse(suppliedStart) : Number.NaN;
	const startedAtMs = Number.isFinite(parsedStart) ? parsedStart : nowMs;
	const budget = record(envelope.budget);
	const budgetTime = record(budget.time);
	const suppliedDeadline = firstString(budgetTime.hardDeadlineAt, budget.deadline, budget.hardDeadlineAt, envelope.deadline, envelope.hardDeadlineAt);
	const parsedDeadline = suppliedDeadline ? Date.parse(suppliedDeadline) : Number.NaN;
	const deadlineMs = Number.isFinite(parsedDeadline) ? parsedDeadline : allocatedSeconds > 0 ? startedAtMs + allocatedSeconds * 1_000 : null;
	const configuredCloseout = Number(budgetTime.closeoutWarningSeconds ?? envelope.closeoutWarningSeconds);
	const closeoutWarningSeconds = Number.isInteger(configuredCloseout) && configuredCloseout > 0
		? configuredCloseout
		: allocatedSeconds > 0 ? Math.min(180, Math.max(1, Math.floor(allocatedSeconds * .2))) : 180;
	const effectiveDeadline = suppliedDeadline ?? (deadlineMs === null ? null : new Date(deadlineMs).toISOString());
	const effectiveTime = effectiveDeadline === null ? budgetTime : { ...budgetTime, hardDeadlineAt: effectiveDeadline, closeoutWarningSeconds };
	const window=assignmentTimeWindow(effectiveTime,nowMs);
	const remainingSeconds=window.phase==='preparation'?window.preparationRemainingSeconds:window.phase==='working'?window.executionRemainingSeconds:window.closeoutRemainingSeconds;
	const phaseDeadline=firstString(window.deadlineAt,suppliedDeadline);
	return {
		startedAt: new Date(startedAtMs).toISOString(),
		allocatedSeconds,
		deadlineAt: phaseDeadline ?? (deadlineMs == null ? null : new Date(deadlineMs).toISOString()),
		remainingSeconds,
		closeoutWarningSeconds,
		phase:window.phase,shouldCloseOut: window.shouldCloseOut,
	};
}

export function targetExecutionContentDescription(artifactKind: string) {
	if (artifactKind === 'discussion_response') return 'One authoritative, durable Discussion response linked to the exact addressed source message.';
	if (artifactKind === 'proposal_estimate') return 'A linked estimate note with assumptions, p50/p90 effort, risks, and capacity implications.';
	if (artifactKind === 'question_answer') return 'A linked answer note with direct answer, evidence, uncertainty, and follow-up questions.';
	if (artifactKind === 'decision_feedback') return 'A linked decision feedback note with recommendation, consequences, risks, and unresolved inputs.';
	return 'A linked agent feedback note with source-grounded planning, recommendations, risks, and next actions.';
}

function executionDeliverableContract(artifactKind: string, payload: HandlerPayload) {
	if (artifactKind === 'discussion_response') {
		return [
			'Assigned deliverable contract: discussion_response.',
			'- Read the exact committed source message and current Discussion thread before answering.',
			'- Use treeseed.discussion.respond exactly once for the authoritative final response. Do not create a discussion_message through generic content tools.',
			'- treeseed.discussion.respond performs the final TreeDX commit for this assignment. After it succeeds, do not call treeseed.content.commit; only perform read-only status/reporting steps.',
			'- Preserve the exact discussion, replyTo, sourceMessageRefs, and intended recipients supplied by the assignment.',
			'- Distinguish repository evidence from inference and answer only the requested scope.',
			'- Linked notes, questions, or proposals are optional supporting artifacts and never replace the final Discussion response.',
			'- If a human response is required, call treeseed.discussion.respond with requiredResponse=true immediately after drafting the exact question and a fresh status read.',
			'- A required-response call owns suspended-summary authoring, the TreeDX assignment checkpoint, lease release, and terminal suspension. Do not write a terminal summary or call treeseed.content.commit before it, and do not retry with requiredResponse=false if it fails.',
		].join('\n');
	}
	if (artifactKind === 'planning_proposal') {
		return [
			'Assigned deliverable contract: planning_proposal.',
			'- Research the assigned objective and inspect prior questions, notes, proposals, decisions, and relevant Guide content before drafting.',
			'- Create exactly one proposal linked through relatedObjectives to the durable objective supplied by the assignment.',
			'- Set primaryContributor to your configured agent identity and choose the project-declared proposalType assigned by your planning profile.',
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
	instructionTemplates?: Array<Record<string,unknown>>;
	contentRoot: string;
}) {
	const relation = subjectRelation(input.subject);
	const timing = assignmentTimeGuidance(context);
	return [
		context.agent.systemPrompt,
		'',
		'Execution-time contract:',
		`- Assignment started: ${timing.startedAt}.`,
		`- Allocated agent time: ${timing.allocatedSeconds > 0 ? `${timing.allocatedSeconds} seconds` : 'no explicit allocation supplied'}.`,
		`- Initial phase: ${timing.phase}. Productive execution starts only after the initial assignment plan passes read-back.`,
		`- Current phase deadline: ${timing.deadlineAt ?? 'provider-managed'}.`,
		`- Current phase time remaining when this prompt was assembled: ${timing.remainingSeconds == null ? 'provider-managed' : `${timing.remainingSeconds} seconds`}.`,
		`- Protected closeout allocation: ${timing.closeoutWarningSeconds} seconds outside productive execution.`,
		'- Call treeseed.status at the start, after each major phase, before any long-running verification or mutation, and whenever your own estimate approaches the closeout threshold. Its wall-clock result is authoritative over the prompt snapshot.',
		'- Track elapsed time throughout execution. Prefer a small durable, validated result over unfinished broad work.',
		'- The allocation is a maximum, not a target. Finish early when all acceptance criteria are satisfied and no important in-scope work remains.',
		'- Never invent extra work, broaden scope, prolong discussion, or consume tokens simply because capacity remains.',
		'- An early completion must verify the result, persist required artifacts, and report acceptance checks, durable artifact references, remaining budget, completion reason, and noUsefulScopedWorkRemaining=true.',
		'- Missing evidence, authority, credentials, or dependencies is blocked work, not early completion.',
		'- Before closeout begins, checkpoint the assignment plan after each substantive deliverable mutation so completed and remaining work are already resumable. Never defer the first plan update until the closeout threshold.',
		'- Before the single final content commit, update the assignment plan, append a terminal assignment status, write the mandatory assignment summary, and request every declared signal publication. These records and requests must exist before the final response; operational content cannot be written after the commit makes the workspace immutable. For a normal discussion_response, treeseed.discussion.respond is that final commit, so never call treeseed.content.commit after it succeeds. The required-human-response Discussion path is the only exception: treeseed.discussion.respond with requiredResponse=true owns its suspended summary and checkpoint, so invoke it before any terminal summary or content commit. In the summary, describe the commit and signal requests as closeout mechanics being submitted with the same checkpoint, not as remaining editorial scope; never claim integration or publication before authoritative control-plane read-back proves it.',
		'- When treeseed.status reports shouldCloseOut=true, start mandatory closeout immediately: stop new exploration and scope expansion; preserve only coherent, valid work; validate every content artifact with its Zod-backed model; persist the plan/status/summary closeout records; commit content exactly once or verify and checkpoint source changes; then report completed scope, remaining scope, exact artifact/checkpoint refs, verification state, blockers, and precise resume instructions.',
		'- If valuable assigned scope remains, and the assignment grants proposal creation for a project-declared extension proposal type, create and Zod-validate a proposal requesting additional capacity before the final commit. The proposal does not extend this assignment and cannot self-authorize more time. If that capability is absent or time is insufficient, explicitly report extensionRequested=true with the requested seconds and reason for a coordinator or human to decide.',
		...(Array.isArray(input.payload.proposalTypes) && input.payload.proposalTypes.length
			? [`- Immutable proposal-type allowlist: ${input.payload.proposalTypes.map(String).join(', ')}. Every proposalType/proposalTypes value must come from this list; do not invent adjacent classifications.`]
			: []),
		'- A deadline is enforced by the runtime. Do not rely on this instruction as permission to exceed it.',
		'',
		firstString(input.assignedObjective?.message) ?? 'No assigned objective was supplied or resolved through TreeDX; report that as a blocker only when the activity contract requires objective provenance.',
		...(input.editorialInstructions ? ['', input.editorialInstructions] : []),
		...(input.instructionTemplates?.length ? ['', 'Exact assignment presentation templates:',JSON.stringify(input.instructionTemplates,null,2),'Use these instructions and skeletons for the corresponding plan, status, message, and summary records.'] : []),
		...(firstString(input.payload.stageInstructions) ? ['', 'Synchronized planning-stage directive:', firstString(input.payload.stageInstructions)!] : []),
		'',
		contentContract(input.contentRoot, input.assignedObjective),
		'',
		executionDeliverableContract(input.artifactKind, input.payload),
		...(relation ? ['', `Required content relation: ${JSON.stringify(relation)}. Supply this relation during create/update or through treeseed.content.link, then verify the returned receipt contains subjectId and subjectField.`] : []),
		'',
		'Assignment input:',
		JSON.stringify({ mode: context.capacity?.mode ?? 'planning', assignmentId: context.capacity?.assignmentId ?? null, subject: input.subject, payload: input.payload }, null, 2),
		...(Object.keys(record(input.payload.signalContracts)).length ? ['', 'Signal publication contracts:', JSON.stringify(input.payload.signalContracts, null, 2), 'Every declared publication is a required completion gate. Use treeseed.publish_signal exactly once for each contract after its evidence-producing artifact mutation succeeds and before returning a final response. Satisfy the exact subject, payload, evidence, and idempotency policy above. subjectGroupIds classify the signal subject, not the output artifact or producing agent. Include them only when the assignment supplies the subject\'s exact frozen project group IDs; otherwise omit subjectGroupIds so the control plane can apply its frozen primary-group fallback. Never infer group IDs from an artifact path, editorial category, provider, role, or agent class.'] : []),
		'',
		'Resolved context packs:',
		JSON.stringify(input.contextPackSummaries, null, 2),
		'',
		'Use available assignment-scoped TreeSeed tools as the source of truth for Knowledge Hub content evidence, reads, writes, and commits. If the provided context is insufficient, call the available tools before reporting a blocked result.',
		'',
		'Return a concise final summary of the content changes, tool calls, and verification. Content changes should be made through the assignment-scoped tools, not by relying on deterministic handler post-processing.',
	].join('\n');
}
