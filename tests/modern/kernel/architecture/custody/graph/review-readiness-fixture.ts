import { assignmentAttemptSchema, assignmentResultSchema, executionEdgeSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../../provider-kernel-fixture.ts';

/** Supplied graph/read-back inputs, never generated governance or model evidence. */
export function reviewedGraphFixture(candidateStore: 'git' | 'treedx' = 'git') {
	const base = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const at = (second: number) => `2026-09-13T12:00:0${second}.000Z`;
	const assignments = ['actor', 'review', 'next'].map((nodeId, index) => {
		const reviewer = nodeId === 'review', workItemId = nodeId === 'next' ? 'next' : 'first';
		const attempt = assignmentAttemptSchema.parse({ ...base, id: `attempt-${nodeId}`, idempotencyKey: `attempt-${nodeId}`,
			nodeId, workItemId, createdAt: at(index * 2), leaseId: `lease-${nodeId}`, reservationId: `reservation-${nodeId}`,
			agentClass: reviewer ? 'configured-auditor' : 'configured-author',
			effectiveProfile: { ...base.effectiveProfile, activity: reviewer ? 'reviewing' : 'acting',
				profileRef: { ...base.effectiveProfile.profileRef, id: reviewer ? 'configured-auditor' : 'configured-author' },
				...(reviewer ? { permissionCeiling: { content: { read: ['proposal', 'decision'], write: ['decision'] },
					tools: ['source.read', 'verification', 'discussion'] } } : {}) },
			...(reviewer ? { grant: { contentRead: [], contentWrite: [{ store: 'treedx', model: 'decision', id: 'native-work-review',
				repository: 'native-library', commit: 'c'.repeat(40), path: 'decisions/review.mdx' }], sourceRead: ['native-source'], sourceWrite: [],
				tools: ['source.read', 'verification', 'discussion'] },
				contextRefs: [{ store: 'git', model: 'source', id: 'native-candidate', repository: 'native-source', commit: 'b'.repeat(40) }],
				workspace: { mode: 'treedx', repository: 'native-library', baseCommit: 'c'.repeat(40), workspaceId: 'review-decisions',
					writablePaths: ['decisions/review.mdx'] } } : {}),
			predecessorResultIds: index === 0 ? [] : index === 1 ? ['result-actor'] : ['result-actor', 'result-review'] });
		return { id: attempt.id, teamId: attempt.teamId, projectId: attempt.projectId, workDayId: attempt.workdayId,
			executionNodeId: nodeId, executionNodeRevision: attempt.nodeRevision, status: 'completed', assignmentAttempt: attempt,
			createdAt: attempt.createdAt, completedAt: at(index * 2 + 1),
			assignmentResult: assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${nodeId}`,
				assignmentId: attempt.id, status: 'completed', summary: 'Supplied immutable read-back input.',
				references: reviewer ? [{ kind: 'treedx', projectId: base.projectId, repository: 'native-library', commit: 'c'.repeat(40), path: 'decisions/review.mdx' }]
					: [{ kind: 'git', repository: 'native-source', commit: 'b'.repeat(40) }], verification: [],
				usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: at(index * 2 + 1) }),
			lifecycleOutput: { activityCompletion: { reviewDisposition: reviewer ? 'approved' : undefined } } };
	});
	const nodes = assignments.map(item => executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1',
		id: item.executionNodeId, teamId: base.teamId, projectId: base.projectId, workItemId: item.assignmentAttempt.workItemId,
		kind: item.executionNodeId === 'review' ? 'reviewing' : 'acting', pairRole: item.executionNodeId === 'review' ? 'reviewer' : 'actor',
		sourceRef: base.sourceRef, authorityRefs: base.authorityRefs, ruleRevision: 1, nodeRevision: 1, agentClass: item.assignmentAttempt.agentClass,
		status: 'completed', estimate: base.estimate, requiredCapabilities: [], requestedPermissions: item.assignmentAttempt.effectiveProfile.permissionCeiling,
		workspace: item.assignmentAttempt.workspace.mode, acceptanceCriteria: base.acceptanceCriteria, maximumReviewCycles: 2, graphRevisionCreated: 1, graphRevisionUpdated: 1 }));
	const edges = [['paired', 'actor', 'review', 'review-pair'], ['dependent', 'review', 'next', 'work-item']].map(([id, fromNodeId, toNodeId, provenance]) =>
		executionEdgeSchema.parse({ schemaVersion: 'treeseed.execution-edge/v1', id, teamId: base.teamId, fromNodeId, toNodeId,
			provenance, sourceRef: base.sourceRef, graphRevisionCreated: 1 }));
	if (candidateStore === 'treedx') {
		const reference = { store: 'treedx' as const, model: 'knowledge' as const, id: 'native-candidate', repository: 'native-source',
			commit: 'b'.repeat(40), path: 'candidate.txt', revision: 1, digest: `sha256:${'f'.repeat(64)}` };
		assignments[0]!.assignmentResult.references = [{ kind: 'treedx', projectId: base.projectId, repository: reference.repository, commit: reference.commit, path: reference.path }];
		const attempt = assignments[1]!.assignmentAttempt;
		attempt.contextRefs = [structuredClone(reference)]; attempt.grant.contentRead = [structuredClone(reference)]; attempt.grant.sourceRead = [];
		attempt.effectiveProfile.permissionCeiling.content.read.push('knowledge');
	}
	return { graph: { teamId: base.teamId, revision: 1, digest: `sha256:${'d'.repeat(64)}`, nodes, edges }, assignments };
}

export function reviewedDecision(f: ReturnType<typeof reviewedGraphFixture>) {
	const actor = f.assignments[0]!, review = f.assignments[1]!, reference = actor.assignmentResult.references[0]!;
	if (reference.kind !== 'git' && reference.kind !== 'treedx') throw new Error('Original candidate reference required');
	return { schemaVersion: 'treeseed.decision/v1', id: 'native-work-review', projectId: review.projectId, decisionClass: 'work-review',
		decisionMethod: 'authority', subjectRef: reference.kind === 'git'
			? { store: 'git', model: 'source', id: 'native-candidate', repository: reference.repository, commit: reference.commit }
			: { store: 'treedx', model: 'knowledge', id: 'native-candidate', repository: reference.repository, commit: reference.commit, path: reference.path },
		disposition: 'approved', rationale: 'Controlled independent candidate review input, not managed model evidence.',
		authorityRefs: [review.assignmentAttempt.sourceRef], decidedByRefs: [review.assignmentAttempt.effectiveProfile.profileRef], decidedAt: review.completedAt };
}

export const readinessFailures = ['omitted-review', 'omitted-actor', 'absent-review', 'review-request-changes', 'review-failed', 'review-late',
	'review-source', 'wrong-review-owner', 'duplicate-result', 'ambiguous-review', 'latest-unfinished', 'foreign-workday', 'missing-edge-source', 'edge-source', 'edge-team', 'actor-bypass',
	'reverse-clock', 'coerced-attempt', 'coerced-result', 'coerced-edge'] as const;
export function mutateReadiness(f: ReturnType<typeof reviewedGraphFixture>, mode: string): void {
	const actor = f.assignments[0]!, review = f.assignments[1]!, next = f.assignments[2]!;
	if (mode === 'omitted-review') next.assignmentAttempt.predecessorResultIds = [actor.assignmentResult.id];
	if (mode === 'omitted-actor') next.assignmentAttempt.predecessorResultIds = [review.assignmentResult.id];
	if (mode === 'absent-review') f.assignments.splice(1, 1);
	if (mode === 'review-request-changes') review.lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
	if (mode === 'review-failed') { review.status = 'failed'; review.assignmentResult.status = 'failed'; }
	if (mode === 'review-late') review.assignmentResult.completedAt = review.completedAt = next.completedAt;
	if (mode === 'review-source') review.assignmentAttempt.sourceRef = { ...review.assignmentAttempt.sourceRef, revision: 2 };
	if (mode === 'wrong-review-owner') review.assignmentResult.assignmentId = 'foreign-attempt';
	if (mode === 'duplicate-result') next.assignmentResult.id = review.assignmentResult.id;
	if (mode === 'ambiguous-review' || mode === 'latest-unfinished') {
		const duplicate = structuredClone(review); duplicate.id = duplicate.assignmentAttempt.id = duplicate.assignmentAttempt.idempotencyKey = 'another-review';
		duplicate.assignmentResult.id = 'another-review-result'; duplicate.assignmentResult.assignmentId = duplicate.id;
		if (mode === 'latest-unfinished') {
			duplicate.createdAt = duplicate.assignmentAttempt.createdAt = '2026-09-13T12:00:03.500Z'; duplicate.status = 'running';
			Reflect.set(duplicate, 'assignmentResult', null); Reflect.deleteProperty(duplicate, 'completedAt');
		}
		f.assignments.push(duplicate);
	}
	if (mode === 'foreign-workday') review.assignmentAttempt.workdayId = review.workDayId = 'foreign-workday';
	if (mode === 'missing-edge-source') delete f.graph.edges[1]!.sourceRef;
	if (mode === 'edge-source') f.graph.edges[1]!.sourceRef = { ...actor.assignmentAttempt.sourceRef, revision: 2 };
	if (mode === 'edge-team') f.graph.edges[1]!.teamId = 'foreign-team';
	if (mode === 'actor-bypass') f.graph.edges[1]!.fromNodeId = 'actor';
	if (mode === 'reverse-clock') actor.completedAt = actor.assignmentResult.completedAt = '2026-09-13T11:59:59.000Z';
	if (mode === 'coerced-attempt') actor.assignmentAttempt.effectiveProfile.profileRef.id = ' configured-author ';
	if (mode === 'coerced-result') actor.assignmentResult.id = ' result-actor ';
	if (mode === 'coerced-edge') f.graph.edges[1]!.sourceRef = { ...actor.assignmentAttempt.sourceRef, id: ' proposal-1 ' };
}
export const reviewFailures = ['project', 'class', 'disposition', 'candidate', 'reviewer', 'authority', 'early', 'late', 'positions'] as const;
export function mutateReview(decision: ReturnType<typeof reviewedDecision>, mode: string): void {
	if (mode === 'project') decision.projectId = 'foreign-project'; if (mode === 'class') decision.decisionClass = 'proposal';
	if (mode === 'disposition') decision.disposition = 'request-changes'; if (mode === 'candidate') decision.subjectRef.commit = 'e'.repeat(40);
	if (mode === 'reviewer') decision.decidedByRefs = [{ ...decision.decidedByRefs[0]!, id: 'unassigned-auditor' }];
	if (mode === 'authority') decision.authorityRefs = [{ ...decision.authorityRefs[0]!, id: 'foreign-proposal' }];
	if (mode === 'early') decision.decidedAt = '2026-09-13T12:00:01.500Z'; if (mode === 'late') decision.decidedAt = '2026-09-13T12:00:05.000Z';
	if (mode === 'positions') decision.decisionMethod = 'vote';
}

export const reviewGrantFailures = ['review-source-write', 'review-source-tool', 'review-candidate-context', 'review-candidate-ref',
	'review-verification', 'review-discussion', 'review-decision', 'review-activity', 'review-decision-target', 'review-decision-id', 'review-extra-workspace-path'] as const;
export function mutateReviewGrant(f: ReturnType<typeof reviewedGraphFixture>, mode: string): void {
	const attempt = f.assignments[1]!.assignmentAttempt;
	if (mode === 'review-source-write') attempt.grant.sourceWrite.push('native-source');
	if (mode === 'review-source-tool') attempt.grant.tools.push('source.write');
	if (mode === 'review-candidate-context') attempt.contextRefs = [];
	if (mode === 'review-candidate-ref') attempt.contextRefs[0]!.commit = 'e'.repeat(40);
	if (mode === 'review-verification') attempt.grant.tools = attempt.grant.tools.filter(value => value !== 'verification');
	if (mode === 'review-discussion') attempt.grant.tools = attempt.grant.tools.filter(value => value !== 'discussion');
	if (mode === 'review-decision') attempt.grant.contentWrite = [];
	if (mode === 'review-activity') attempt.effectiveProfile.activity = 'acting';
	if (mode === 'review-decision-id') attempt.grant.contentWrite[0]!.id = 'foreign-decision';
	if (mode === 'review-extra-workspace-path' && attempt.workspace.mode === 'treedx') attempt.workspace.writablePaths.push('notes/unassigned.mdx');
	if (mode === 'review-decision-target' && attempt.workspace.mode === 'treedx') {
		attempt.grant.contentWrite[0]!.path = 'decisions/foreign.mdx'; attempt.workspace.writablePaths = ['decisions/foreign.mdx'];
	}
}

export const contentReviewFailures = ['content-read', 'content-context', 'content-write', 'content-workspace', 'content-ref', 'content-id', 'content-model', 'content-root-workspace'] as const;
export function mutateContentReview(f: ReturnType<typeof reviewedGraphFixture>, mode: string): void {
	const attempt = f.assignments[1]!.assignmentAttempt, candidate = attempt.contextRefs[0]!;
	if (mode === 'content-read') attempt.grant.contentRead = [];
	if (mode === 'content-context') attempt.contextRefs = [];
	if (mode === 'content-ref') attempt.grant.contentRead[0]!.commit = 'e'.repeat(40);
	if (mode === 'content-id') attempt.grant.contentRead[0]!.id = 'foreign-candidate';
	if (mode === 'content-model') attempt.grant.contentRead[0]!.model = 'note';
	if (mode === 'content-write' || mode === 'content-workspace' || mode === 'content-root-workspace') {
		attempt.workspace = { mode: 'treedx', repository: candidate.repository!, baseCommit: candidate.commit!, workspaceId: 'review-content',
			writablePaths: ['decisions/review.mdx', candidate.path!] };
		attempt.grant.contentWrite = attempt.grant.contentWrite.map(reference => ({ ...reference, repository: candidate.repository, commit: candidate.commit }));
		for (const reference of f.assignments[1]!.assignmentResult.references) if (reference.kind === 'treedx') reference.repository = candidate.repository!;
		if (mode === 'content-root-workspace' && attempt.workspace.mode === 'treedx') attempt.workspace.writablePaths = ['decisions/review.mdx', '.'];
		if (mode === 'content-write') { attempt.grant.contentWrite.push(structuredClone(candidate)); attempt.effectiveProfile.permissionCeiling.content.write.push('knowledge'); }
	}
}

/** Preserve the first request-changes attempt while a later distinct pair is approved. */
export function reviewedRevisionFixture() {
	const f = reviewedGraphFixture(), first = f.assignments[0]!, requested = f.assignments[1]!, next = f.assignments[2]!;
	requested.lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
	const correction = structuredClone(first), approved = structuredClone(requested);
	for (const [item, id, start, end] of [[correction, 'correction', '04', '05'], [approved, 'approval', '06', '07']] as const) {
		item.id = item.assignmentAttempt.id = item.assignmentAttempt.idempotencyKey = id;
		item.assignmentAttempt.leaseId = `lease-${id}`; item.assignmentAttempt.reservationId = `reservation-${id}`;
		item.executionNodeRevision = item.assignmentAttempt.nodeRevision = 2;
		item.createdAt = item.assignmentAttempt.createdAt = `2026-09-13T12:00:${start}.000Z`;
		item.completedAt = item.assignmentResult.completedAt = `2026-09-13T12:00:${end}.000Z`;
		item.assignmentResult.id = `result-${id}`; item.assignmentResult.assignmentId = id;
		if (item.assignmentAttempt.workspace.mode === 'treedx') item.assignmentAttempt.workspace.workspaceId = `workspace-${id}`;
	}
	correction.assignmentAttempt.predecessorResultIds = [requested.assignmentResult.id];
	approved.assignmentAttempt.predecessorResultIds = [correction.assignmentResult.id]; approved.lifecycleOutput.activityCompletion.reviewDisposition = 'approved';
	next.createdAt = next.assignmentAttempt.createdAt = '2026-09-13T12:00:08.000Z';
	next.completedAt = next.assignmentResult.completedAt = '2026-09-13T12:00:09.000Z';
	next.assignmentAttempt.predecessorResultIds = [correction.assignmentResult.id, approved.assignmentResult.id];
	f.assignments = [first, requested, correction, approved, next];
	for (const node of f.graph.nodes.filter(value => value.id !== 'next')) node.nodeRevision = 2;
	return f;
}
