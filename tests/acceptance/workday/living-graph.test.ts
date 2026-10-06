import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGraphProvenance, verifyPredecessorCustody } from './support/evidence-pages.ts';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';

// Read only the existing public CLI. No synthetic fallback, optional skip,
// private route, new receipt, or alternate campaign implementation is allowed.
const list = (value: unknown): Row[] => {
	assert.ok(Array.isArray(value), 'ACCEPTANCE_TEAM_GRAPH_COLLECTION: Complete array required');
	return value.map(row);
};
function context() {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_TEAM_GRAPH_WORKDAY: Exact real workday required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const run = row(read(['workdays', 'show', id], team).run);
	assert.equal(run.id, id); assert.equal(run.executionMode, 'simulation');
	return { id, team, run, assignments: readWorkdayAssignments(id, String(run.startedAt), team) };
}
test('Living team graph public views preserve exact nodes edges provenance and frozen predecessor results', { timeout: 120_000 }, () => {
	verifyGolden('graph');
	const f = context(), graph = read(['execution', 'graph', 'show'], f.team);
	verifyGraphProvenance(graph); verifyPredecessorCustody(f.assignments);
	for (const projectId of new Set(list(graph.nodes).map(node => String(node.projectId)))) {
		const filtered = read(['execution', 'graph', 'show', '--project', projectId], f.team);
		const nodes = list(graph.nodes).filter(node => node.projectId === projectId), ids = new Set(nodes.map(node => node.id));
		assert.equal(filtered.revision, graph.revision); assert.equal(filtered.digest, graph.digest);
		assert.deepEqual(filtered.nodes, nodes);
		assert.deepEqual(filtered.edges, list(graph.edges).filter(edge => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)));
	}
});
test('Living graph read-only reconciliation and node inspection preserve assignments usage and every public graph record', { timeout: 120_000 }, () => {
	const f = context(), before = read(['execution', 'graph', 'show'], f.team);
	verifyGraphProvenance(before);
	for (const node of list(before.nodes)) {
		assert.deepEqual(read(['execution', 'node', 'show', String(node.id)], f.team), node);
		const explanation = read(['execution', 'node', 'explain', String(node.id)], f.team);
		assert.deepEqual(explanation.node, node); assert.equal(explanation.graphRevision, before.revision);
		const incoming = list(before.edges).filter(edge => edge.toNodeId === node.id);
		assert.deepEqual(list(explanation.predecessors).map(value => value.edge), incoming);
	}
	for (let repetition = 0; repetition < 3; repetition++) {
		const plan = read(['execution', 'reconcile', '--plan'], f.team);
		assert.equal(plan.baseRevision, before.revision);
		assert.deepEqual(read(['execution', 'graph', 'show'], f.team), before);
		assert.deepEqual(readWorkdayAssignments(f.id, String(f.run.startedAt), f.team), f.assignments);
	}
	verifyGolden('settlement'); verifyGolden('reporter');
});
