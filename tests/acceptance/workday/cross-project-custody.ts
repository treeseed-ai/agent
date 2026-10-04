import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assignmentAttemptSchema, assignmentResultSchema, executionEdgeSchema, executionNodeSchema, exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { exactDependencyLinkSchema, validatePortableContentData } from '@treeseed/sdk/content-validation';
import { row, type Row } from '../acceptance-cli.ts';
import { verifyDecisionContent } from './decision-evidence.ts';

export const exactFileKey = (reference: Pick<ExactEntityReference, 'repository' | 'commit' | 'path'>): string =>
	JSON.stringify([reference.repository, reference.commit, reference.path]);
const collection = (value: unknown): Row[] => { assert.ok(Array.isArray(value), 'ACCEPTANCE_CROSS_PROJECT_COLLECTION: Complete array required'); return value.map(row); };
const endpointMatches = (reference: ExactEntityReference, source: ExactEntityReference, workItem: string | undefined): boolean =>
	reference.store === source.store && reference.model === source.model && reference.id === source.id
	&& reference.revision === source.revision && reference.digest === source.digest && reference.repository === source.repository
	&& reference.commit === source.commit && reference.path === source.path && reference.anchor === `work-item/${workItem}`;
const sameRef = (left: ExactEntityReference, right: ExactEntityReference): boolean =>
	['store', 'model', 'id', 'revision', 'digest', 'repository', 'commit', 'path', 'anchor'].every(key => row(left)[key] === row(right)[key]);

// Readback assertions only, not another runtime policy, receipt/schema, campaign
// runner, producer-completeness oracle or proof of native relation CREATION.
export function verifyCrossProjectCustody(graph: Row, items: Row[], notes: Map<string, Row>, decisions: Map<string, Row>): void {
	const nodes = collection(graph.nodes).map(value => executionNodeSchema.parse(value));
	const edges = collection(graph.edges).map(value => executionEdgeSchema.parse(value));
	assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, 'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Node identity reused');
	assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length, 'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Edge identity reused');
	assert.ok(items.length > 0, 'ACCEPTANCE_CROSS_PROJECT_EMPTY: Real complete assignments required');
	assert.equal(new Set(items.map(item => item.id)).size, items.length, 'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Assignment identity reused');
	const attempts = items.map(item => {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(attempt.id, item.id); assert.equal(attempt.projectId, item.projectId); assert.equal(attempt.nodeId, item.executionNodeId);
		assert.equal(attempt.nodeRevision, item.executionNodeRevision); assert.equal(attempt.workdayId, item.workDayId);
		assert.equal(attempt.teamId, graph.teamId);
		const result = item.status === 'completed' ? assignmentResultSchema.parse(item.assignmentResult) : undefined;
		if (result) { assert.equal(result.assignmentId, item.id); assert.equal(result.status, 'completed'); assert.equal(result.completedAt, item.completedAt); }
		assert.equal(new Set(attempt.predecessorResultIds).size, attempt.predecessorResultIds.length, 'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Predecessor identity repeated');
		return { item, attempt, result };
	});
	const results = attempts.filter(value => value.result);
	assert.equal(new Set(results.map(value => value.result!.id)).size, results.length, 'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Result identity reused');
	const workdays = new Set(attempts.map(value => value.attempt.workdayId)); assert.equal(workdays.size, 1);
	const targetNodes = new Set(attempts.map(value => value.attempt.nodeId));
	const cross = edges.filter(edge => {
		const from = nodes.find(node => node.id === edge.fromNodeId), to = nodes.find(node => node.id === edge.toNodeId);
		return to && targetNodes.has(to.id) && from?.projectId !== to.projectId;
	});
	assert.ok(cross.length > 0, 'ACCEPTANCE_CROSS_PROJECT_EMPTY: A single-project golden cannot satisfy this case');
	assert.equal(new Set(cross.map(edge => JSON.stringify([edge.fromNodeId, edge.toNodeId]))).size, cross.length,
		'ACCEPTANCE_CROSS_PROJECT_DUPLICATE: Same dependency repeated under another edge identity');
	for (const edge of cross) {
		const from = nodes.find(node => node.id === edge.fromNodeId), to = nodes.find(node => node.id === edge.toNodeId);
		assert.ok(from && to); assert.equal(from.teamId, graph.teamId); assert.equal(to.teamId, graph.teamId);
		assert.equal(edge.provenance, 'treedx-link', 'ACCEPTANCE_CROSS_PROJECT_RELATION: Explicit canonical relation required');
		assert.equal(from.pairRole, 'reviewer', 'ACCEPTANCE_CROSS_PROJECT_REVIEW: Approved independent review must govern reviewed predecessor');
		assert.equal(to.pairRole, 'actor');
		const source = edge.sourceRef;
		assert.ok(source?.store === 'treedx' && source.model === 'note' && source.repository && source.commit && source.path && source.digest,
			'ACCEPTANCE_CROSS_PROJECT_NOTE: Exact canonical note source required');
		const file = notes.get(exactFileKey(source)); assert.ok(file, 'ACCEPTANCE_CROSS_PROJECT_NOTE: Independently read exact note missing');
		assert.equal(file.path, source.path);
		assert.equal(typeof file.content, 'string', 'ACCEPTANCE_CROSS_PROJECT_BYTES: Raw exact note bytes required');
		assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, source.digest, 'ACCEPTANCE_CROSS_PROJECT_BYTES: Note byte digest differs');
		const validated = validatePortableContentData('note', file.frontmatter); assert.ok(validated.ok && validated.data);
		const note = row(validated.data); assert.equal(note.id, source.id);
		const owner = nodes.find(node => node.projectId === note.projectId && node.sourceRef.repository === source.repository);
		assert.ok(owner, 'ACCEPTANCE_CROSS_PROJECT_NOTE: Note repository differs from owning project library');
		const links = collection(note.links).map(link => exactDependencyLinkSchema.parse(link));
		assert.equal(links.filter(link => endpointMatches(link.from, from.sourceRef, from.workItemId)
			&& endpointMatches(link.to, to.sourceRef, to.workItemId)).length, 1, 'ACCEPTANCE_CROSS_PROJECT_NOTE: Exact endpoint relation missing or duplicated');
		const pair = edges.filter(value => value.provenance === 'review-pair' && value.toNodeId === from.id);
		assert.equal(pair.length, 1); const actorNode = nodes.find(node => node.id === pair[0]!.fromNodeId);
		assert.ok(actorNode?.pairRole === 'actor' && actorNode.projectId === from.projectId && actorNode.workItemId === from.workItemId);
		const children = attempts.filter(value => value.attempt.nodeId === to.id && value.item.status === 'completed');
		assert.ok(children.length > 0, 'ACCEPTANCE_CROSS_PROJECT_CONSUMER: Actual completed dependent attempt missing');
		for (const child of children) {
			const review: typeof attempts = results.filter(value => value.attempt.nodeId === from.id && child.attempt.predecessorResultIds.includes(value.result!.id));
			const actors: typeof attempts = results.filter(value => value.attempt.nodeId === actorNode.id && child.attempt.predecessorResultIds.includes(value.result!.id));
			assert.equal(review.length, 1, 'ACCEPTANCE_CROSS_PROJECT_PREDECESSOR: Exact consumed review result required');
			assert.equal(actors.length, 1, 'ACCEPTANCE_CROSS_PROJECT_PREDECESSOR: Exact consumed actor candidate required');
			const r = review[0]!, a = actors[0]!;
			assert.equal(r.attempt.effectiveProfile.activity, 'reviewing');
			assert.ok(!sameRef(a.attempt.effectiveProfile.profileRef, r.attempt.effectiveProfile.profileRef),
				'ACCEPTANCE_CROSS_PROJECT_REVIEW: Actor cannot independently approve its own candidate');
			for (const value of [a, r, child]) assert.ok(endpointMatches({ ...value.attempt.sourceRef, anchor: `work-item/${value.attempt.workItemId}` },
				value === child ? to.sourceRef : from.sourceRef, value.attempt.workItemId), 'ACCEPTANCE_CROSS_PROJECT_SOURCE: Frozen proposal endpoint drifted');
			assert.ok(r.attempt.predecessorResultIds.includes(a.result!.id), 'ACCEPTANCE_CROSS_PROJECT_REVIEW: Review did not consume this exact actor');
			const candidate = a.result!.references.filter((reference): reference is Extract<typeof reference, { kind: 'git' }> => reference.kind === 'git');
			const actorWorkspace = a.attempt.workspace; assert.ok(actorWorkspace.mode === 'git');
			const exactCandidate = candidate.filter(reference => reference.repository === actorWorkspace.repository);
			assert.equal(exactCandidate.length, 1, 'ACCEPTANCE_CROSS_PROJECT_CANDIDATE: Sole original actor repository candidate required');
			const reviewRefs = r.result!.references.filter((reference): reference is Extract<typeof reference, { kind: 'treedx' }> => reference.kind === 'treedx' && reference.projectId === from.projectId);
			const approved = reviewRefs.filter(reference => r.attempt.grant.contentWrite.some(grant => grant.model === 'decision'
				&& grant.repository === reference.repository && grant.path === reference.path));
			assert.equal(approved.length, 1, 'ACCEPTANCE_CROSS_PROJECT_REVIEW: Native exact Decision reference required');
			const reviewFile = decisions.get(exactFileKey(approved[0]!)); assert.ok(reviewFile);
			assert.equal(reviewFile.path, approved[0]!.path);
			const decision = verifyDecisionContent(row(reviewFile.frontmatter), from.projectId, 'ACCEPTANCE_CROSS_PROJECT_REVIEW');
			assert.equal(decision.decisionClass, 'work-review'); assert.equal(decision.disposition, 'approved');
			assert.equal(row(decision.subjectRef).store, 'git'); assert.equal(row(decision.subjectRef).repository, exactCandidate[0]!.repository);
			assert.equal(row(decision.subjectRef).commit, exactCandidate[0]!.commit, 'ACCEPTANCE_CROSS_PROJECT_REVIEW: Approval is for another candidate');
			assert.ok(collection(decision.decidedByRefs).some(ref => sameRef(exactEntityReferenceSchema.parse(ref), r.attempt.effectiveProfile.profileRef)),
				'ACCEPTANCE_CROSS_PROJECT_REVIEW: Approval lacks exact independent reviewer profile');
			assert.ok(child.attempt.workspace.mode === 'git', 'ACCEPTANCE_CROSS_PROJECT_WORKSPACE: Own primary Git workspace required');
			assert.notEqual(child.attempt.workspace.repository, actorWorkspace.repository, 'ACCEPTANCE_CROSS_PROJECT_WORKSPACE: Cross-project workspace merged');
			assert.deepEqual(child.attempt.grant.sourceWrite, [child.attempt.workspace.repository], 'ACCEPTANCE_CROSS_PROJECT_WRITE: Foreign source writes');
			assert.deepEqual(child.attempt.grant.contentWrite, [], 'ACCEPTANCE_CROSS_PROJECT_WRITE: Git actor cannot write foreign content');
			const primaryRepository = child.attempt.workspace.repository;
			const primaryPredecessors = results.filter(value => child.attempt.predecessorResultIds.includes(value.result!.id))
				.flatMap(value => value.result!.references).filter(reference => reference.kind === 'git' && reference.repository === primaryRepository);
			if (primaryPredecessors.length === 0) {
				const primaryCommits = [...new Set([child.attempt.sourceRef, ...child.attempt.contextRefs]
					.filter(reference => reference.store === 'git' && reference.repository === primaryRepository).map(reference => reference.commit))];
				assert.equal(primaryCommits.length, 1, 'ACCEPTANCE_CROSS_PROJECT_BASE: One exact original primary source required when predecessors only cite foreign repositories');
				assert.equal(child.attempt.workspace.baseCommit, primaryCommits[0], 'ACCEPTANCE_CROSS_PROJECT_BASE: Foreign evidence cannot replace the original primary writable base');
			}
			const readGrant = child.attempt.grant.contentRead.filter(ref => ref.model === 'decision' && ref.repository === approved[0]!.repository
				&& ref.commit === approved[0]!.commit && ref.path === approved[0]!.path);
			assert.equal(readGrant.length, 1, 'ACCEPTANCE_CROSS_PROJECT_GRANT: Exact secondary review read grant missing or ambiguous');
			assert.ok(child.attempt.contextRefs.some(ref => sameRef(ref, readGrant[0]!)), 'ACCEPTANCE_CROSS_PROJECT_CONTEXT: Exact secondary review context missing');
			const at = (value: unknown) => { assert.equal(typeof value, 'string'); const clock = Date.parse(String(value)); assert.ok(Number.isFinite(clock)); return clock; };
			assert.ok(at(a.result!.completedAt) <= at(r.attempt.createdAt) && at(r.result!.completedAt) <= at(child.attempt.createdAt),
				'ACCEPTANCE_CROSS_PROJECT_CLOCK: Admission preceded exact actor and independent review completion');
			for (const resultId of child.attempt.predecessorResultIds) {
				const value = results.find(value => value.result!.id === resultId); assert.ok(value, 'ACCEPTANCE_CROSS_PROJECT_PREDECESSOR: Missing independent result readback');
				if (value.attempt.projectId === child.attempt.projectId) continue;
				assert.ok(cross.some(origin => origin.toNodeId === to.id && (origin.fromNodeId === value.attempt.nodeId
					|| edges.some(pair => pair.provenance === 'review-pair' && pair.fromNodeId === value.attempt.nodeId && pair.toNodeId === origin.fromNodeId))),
					'ACCEPTANCE_CROSS_PROJECT_RELATION: Unrelated foreign predecessor consumed');
			}
		}
	}
}
