import { describe, expect, it } from 'vitest';
import { state, workdayId } from '../golden-readback-fixture.ts';
import { reviewedGraphFixture } from './graph/review-readiness-fixture.ts';
import { verifyGraphProvenance, verifyPredecessorCustody } from '../../../../acceptance/workday/support/evidence-pages.ts';
await import('../../../../acceptance/workday/living-graph.test.ts');

const graphInput = () => reviewedGraphFixture().graph;
const predecessorInput = () => reviewedGraphFixture().assignments;
// UNIT of newly authored native read-back assertions, not a live graph receipt.
describe('living team graph managed assertion contract', () => {
	it('denies omitted graph-required review results even when every declared predecessor agrees', () => {
		const f = reviewedGraphFixture(); f.assignments[2]!.assignmentAttempt.predecessorResultIds = ['result-actor'];
		const held = structuredClone(f); verifyGraphProvenance(f.graph);
		expect(() => verifyPredecessorCustody(f.assignments, f.graph)).toThrow(); expect(f).toEqual(held);
	});
	it('denies missing exact edge source authority rather than accepting provenance labels alone', () => {
		const graph = graphInput(); delete graph.edges[1]!.sourceRef; const held = structuredClone(graph);
		expect(() => verifyGraphProvenance(graph)).toThrow(); expect(graph).toEqual(held);
	});
	it('retains exact reviewed provenance and canonical predecessor readback without rewriting evidence', () => {
		const graph = graphInput(), assignments = predecessorInput(), before = structuredClone({ graph, assignments });
		expect(() => verifyGraphProvenance(graph)).not.toThrow(); expect(() => verifyPredecessorCustody(assignments, graph)).not.toThrow();
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
			try { verifyPredecessorCustody(rows, graphInput()); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true, true, true]);
	});
	it('rejects a changed reconciliation preview before performing an actual noop or accepting unchanged public reads', () => {
		const graph = graphInput();
		state.replies.get('workdays show')!.run.id = workdayId;
		state.replies.set('execution graph', graph);
		for (const node of graph.nodes) {
			state.replies.set(`execution node show ${node.id}`, node);
			state.replies.set(`execution node explain ${node.id}`, { node, graphRevision: graph.revision,
				predecessors: graph.edges.filter(edge => edge.toNodeId === node.id).map(edge => ({ edge })) });
		}
		const changes = { added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] };
		const plan = { teamId: graph.teamId, baseRevision: graph.revision, desiredRevision: 2, desiredDigest: graph.digest, changes };
		const revision = { schemaVersion: 'treeseed.graph-revision/v1', teamId: graph.teamId, revision: graph.revision, ruleRevision: 1,
			graphDigest: graph.digest, changedSourceRefs: [graph.nodes[0]!.sourceRef], changes: { ...changes, added: ['original-node'] },
			createdAt: '2026-09-13T12:00:00.000Z' };
		state.replies.set('execution graph watch --cursor 0', { items: [revision], nextCursor: '1' });
		state.replies.set('execution graph watch --cursor 1', { items: [], nextCursor: '1' });
		state.replies.set('execution reconcile --plan --server', plan);
		state.replies.set('execution reconcile', revision);
		const observe = state.cases.get('Living graph identical reconciliation and node inspection preserve assignments usage and every public graph record')!;
		observe();
		const invalid = [
			...Object.keys(changes).map(key => ({ ...plan, changes: { ...changes, [key]: ['foreign-node'] } })),
			{ ...plan, teamId: 'foreign-team' }, { ...plan, baseRevision: 2 }, { ...plan, desiredDigest: `sha256:${'f'.repeat(64)}` },
			{ ...plan, changes: null }, { ...plan, changes: {} }, { ...plan, changes: { ...changes, alternate: [] } },
		];
		const held = structuredClone({ graph, plan, revision, invalid });
		for (const changed of invalid) {
			state.replies.set('execution reconcile --plan --server', changed);
			const start = state.calls.length;
			expect(observe).toThrow(/ACCEPTANCE_GRAPH_NOOP/u);
			expect(state.calls.slice(start).filter(args => args[0] === 'execution' && args[1] === 'reconcile' && !args.includes('--plan'))).toEqual([]);
		}
		state.replies.set('execution reconcile --plan --server', plan);
		state.replies.set('execution reconcile', { ...revision, ruleRevision: 2 });
		expect(observe).toThrow(/ACCEPTANCE_GRAPH_NOOP/u);
		state.replies.set('execution reconcile', revision); observe();
		expect({ graph, plan, revision, invalid }).toEqual(held);
	});
	it('registers separate live graph and identical replay cases without invoking a campaign from unit fixtures', () => {
		expect(state.cases.has('Living team graph public views preserve exact nodes edges provenance and frozen predecessor results')).toBe(true);
		expect(state.cases.has('Living graph identical reconciliation and node inspection preserve assignments usage and every public graph record')).toBe(true);
	});
});
