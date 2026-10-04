import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, executionEdgeSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { state } from '../golden-readback-fixture.ts';
import { request } from '../../provider-kernel-fixture.ts';
import { verifyGraphProvenance, verifyPredecessorCustody } from '../../../../acceptance/workday/support/evidence-pages.ts';
await import('../../../../acceptance/workday/living-graph.test.ts');

function graphInput() {
	const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const node = (id: string, workItemId: string, pairRole: 'actor' | 'reviewer') => executionNodeSchema.parse({
		schemaVersion: 'treeseed.execution-node/v1', id, teamId: attempt.teamId, projectId: attempt.projectId, workItemId,
		kind: pairRole === 'actor' ? 'acting' : 'reviewing', pairRole, sourceRef: attempt.sourceRef, authorityRefs: attempt.authorityRefs,
		ruleRevision: 1, nodeRevision: 1, agentClass: pairRole === 'actor' ? 'configured-builder' : 'reviewer', status: 'completed',
		estimate: attempt.estimate, requiredCapabilities: [], requestedPermissions: attempt.effectiveProfile.permissionCeiling,
		workspace: pairRole === 'actor' ? 'git' : 'treedx', acceptanceCriteria: attempt.acceptanceCriteria,
		maximumReviewCycles: 2, graphRevisionCreated: 1, graphRevisionUpdated: 1,
	});
	const nodes = [node('actor', 'first', 'actor'), node('review', 'first', 'reviewer'), node('next', 'next', 'actor')];
	const edge = (id: string, fromNodeId: string, toNodeId: string, provenance: 'review-pair' | 'work-item') => executionEdgeSchema.parse({
		schemaVersion: 'treeseed.execution-edge/v1', id, teamId: attempt.teamId, fromNodeId, toNodeId, provenance,
		sourceRef: attempt.sourceRef, graphRevisionCreated: 1,
	});
	return { teamId: attempt.teamId, revision: 1, digest: `sha256:${'d'.repeat(64)}`, nodes,
		edges: [edge('paired', 'actor', 'review', 'review-pair'), edge('dependent', 'review', 'next', 'work-item')] };
}
function predecessorInput() {
	const first = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const next = assignmentAttemptSchema.parse({ ...first, id: 'dependent', idempotencyKey: 'dependent',
		createdAt: '2026-09-13T12:00:03.000Z', predecessorResultIds: ['result-first'] });
	return [
		{ id: first.id, projectId: first.projectId, executionNodeRevision: first.nodeRevision, status: 'completed', assignmentAttempt: first,
			createdAt: first.createdAt, completedAt: '2026-09-13T12:00:02.000Z', assignmentResult: { id: 'result-first', assignmentId: first.id } },
		{ id: next.id, projectId: next.projectId, executionNodeRevision: next.nodeRevision, status: 'completed', assignmentAttempt: next,
			createdAt: next.createdAt, completedAt: '2026-09-13T12:00:04.000Z', assignmentResult: { id: 'result-next', assignmentId: next.id } },
	];
}
// UNIT of newly authored native read-back assertions, not a live graph receipt.
describe('living team graph managed assertion contract', () => {
	it('retains exact reviewed provenance and canonical predecessor readback without rewriting evidence', () => {
		const graph = graphInput(), assignments = predecessorInput(), before = structuredClone({ graph, assignments });
		expect(() => verifyGraphProvenance(graph)).not.toThrow(); expect(() => verifyPredecessorCustody(assignments)).not.toThrow();
		expect({ graph, assignments }).toEqual(before);
	});
	it('denies duplicate dangling cyclic and foreign-team graph edges before trusting completed status', () => {
		const outcomes: boolean[] = [];
		for (const mode of ['duplicate', 'dangling', 'cycle', 'foreign-team']) {
			const graph = graphInput();
			if (mode === 'duplicate') graph.edges.push(structuredClone(graph.edges[0]!));
			if (mode === 'dangling') graph.edges[1]!.fromNodeId = 'missing';
			if (mode === 'cycle') graph.edges.push({ ...graph.edges[1]!, id: 'cycle', fromNodeId: 'next', toNodeId: 'actor' });
			if (mode === 'foreign-team') graph.nodes[0]!.teamId = 'other-team';
			try { verifyGraphProvenance(graph); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true]);
	});
	it('denies actor-only downstream edges and cross-project dependencies without exact relation provenance', () => {
		const graph = graphInput(); graph.edges[1]!.fromNodeId = 'actor';
		expect(() => verifyGraphProvenance(graph)).toThrow(/ACCEPTANCE_EDGE_REVIEW/u);
		const cross = graphInput(); cross.nodes[2]!.projectId = 'foreign-project';
		expect(() => verifyGraphProvenance(cross)).toThrow(/ACCEPTANCE_CROSS_PROJECT_RELATION/u);
	});
	it('denies missing duplicated unfinished foreign or future predecessor results against whole frozen attempts', () => {
		const outcomes: boolean[] = [];
		for (const mode of ['missing', 'duplicate', 'unfinished', 'foreign-project', 'future', 'wrong-result-owner']) {
			const rows = predecessorInput();
			if (mode === 'missing') rows[1]!.assignmentAttempt.predecessorResultIds = ['missing'];
			if (mode === 'duplicate') rows[1]!.assignmentAttempt.predecessorResultIds = ['result-first', 'result-first'];
			if (mode === 'unfinished') rows[0]!.status = 'failed';
			if (mode === 'foreign-project') rows[0]!.projectId = 'foreign-project';
			if (mode === 'future') rows[0]!.completedAt = '2026-09-13T12:00:04.000Z';
			if (mode === 'wrong-result-owner') rows[0]!.assignmentResult.assignmentId = 'unrelated';
			try { verifyPredecessorCustody(rows); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true, true, true]);
	});
	it('registers separate live graph and read-only replay cases without invoking a campaign from unit fixtures', () => {
		expect(state.cases.has('Living team graph public views preserve exact nodes edges provenance and frozen predecessor results')).toBe(true);
		expect(state.cases.has('Living graph read-only reconciliation and node inspection preserve assignments usage and every public graph record')).toBe(true);
	});
});
