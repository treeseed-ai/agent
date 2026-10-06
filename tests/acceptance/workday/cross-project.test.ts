import assert from 'node:assert/strict';
import test from 'node:test';
import { executionEdgeSchema, executionNodeSchema, assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readGovernedContentFile } from './support/decision-evidence.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';
import { exactFileKey, verifyCrossProjectCustody } from './support/cross-project-custody.ts';
import { readCompleteEvidence } from './support/evidence-pages.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody } from './support/record-custody.ts';
import { readPortfolioAuthority, verifyPortfolioRelations } from './support/portfolio-relations.ts';

function observe() {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? ''; assert.match(id, /^workday-[a-f0-9-]+$/u);
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed', workday = read(['workdays', 'show', id], team), run = row(workday.run);
	assert.equal(run.id, id); assert.equal(run.executionMode, 'simulation'); assert.equal(run.status, 'completed');
	const items = readWorkdayAssignments(id, String(run.startedAt), team), graph = read(['execution', 'graph', 'show'], team);
	assert.ok(Array.isArray(graph.nodes) && Array.isArray(graph.edges));
	const nodes = graph.nodes.map(value => executionNodeSchema.parse(value)), edges = graph.edges.map(value => executionEdgeSchema.parse(value));
	const target = new Set(items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt).nodeId));
	const cache = new Map<string, Row>(), notes = new Map<string, Row>(), decisions = new Map<string, Row>();
	for (const edge of edges) {
		const from = nodes.find(node => node.id === edge.fromNodeId), to = nodes.find(node => node.id === edge.toNodeId);
		if (!from || !to || !target.has(to.id) || from.projectId === to.projectId) continue;
		assert.ok(edge.sourceRef?.model === 'note');
		const owners = nodes.filter(node => node.sourceRef.repository === edge.sourceRef!.repository);
		assert.ok(owners.length > 0 && new Set(owners.map(node => node.projectId)).size === 1, 'ACCEPTANCE_CROSS_PROJECT_NOTE: Ambiguous project library owner');
		const file = readGovernedContentFile(edge.sourceRef, owners[0]!.projectId, team, cache, 'ACCEPTANCE_CROSS_PROJECT_NOTE');
		notes.set(exactFileKey(edge.sourceRef), file);
	}
	for (const item of items.filter(item => item.status === 'completed')) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		if (attempt.effectiveProfile.activity !== 'reviewing') continue;
		for (const reference of assignmentResultSchema.parse(item.assignmentResult).references) {
			if (reference.kind !== 'treedx' || !attempt.grant.contentWrite.some(ref => ref.model === 'decision' && ref.repository === reference.repository && ref.path === reference.path)) continue;
			decisions.set(exactFileKey(reference), readGovernedContentFile(reference, attempt.projectId, team, cache, 'ACCEPTANCE_CROSS_PROJECT_REVIEW'));
		}
	}
	verifyCrossProjectCustody(graph, items, notes, decisions);
	const views: unknown[] = [workday, items], measurements: Row[] = [];
	for (const project of new Set(items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt).projectId))) {
		measurements.push(...readCompleteEvidence(['capacity', 'usage', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CROSS_PROJECT_USAGE'));
		views.push(readCompleteEvidence(['capacity', 'ledger', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CROSS_PROJECT_LEDGER'));
	}
	verifyTerminalRecordCustody(items, publicCanonicalRecords(views, 'treeseed.lease/v1'), publicCanonicalRecords(views, 'treeseed.reservation/v1'),
		publicCanonicalRecords(views, 'treeseed.usage-settlement/v1'), measurements);
	return { id, team, workday, graph, items, notes: [...notes.entries()], decisions: [...decisions.entries()], views, measurements };
}

// Read only existing public commands against a real managed multi-project run.
// No creation/campaign shortcut, private route, synthetic fallback or skip.
test('Cross-project managed graph consumes exact relation notes approved predecessor candidates and secondary read grants before dependent admission', { timeout: 120_000 }, () => {
	observe(); verifyGolden('settlement'); verifyGolden('reporter');
});
test('Cross-project managed repeated public note decision graph and assignment reads retain original custody without new output settlement or graph mutation', { timeout: 120_000 }, () => {
	const first = observe();
	for (let repeat = 0; repeat < 2; repeat++) {
		assert.deepEqual(observe(), first);
		const plan = read(['execution', 'reconcile', '--plan'], first.team); assert.equal(plan.baseRevision, first.graph.revision);
		assert.deepEqual(read(['execution', 'graph', 'show'], first.team), first.graph);
	}
	verifyGolden('settlement'); verifyGolden('reporter');
});

function observePortfolio() {
	const authority = readPortfolioAuthority(), actual = observe();
	const bindings = new Map<string, Row>();
	for (const project of authority.expected.projects) bindings.set(project.slug, read(['projects', 'treedx', 'show', project.slug], actual.team));
	verifyPortfolioRelations(authority.expected, bindings, actual.graph, actual.items, actual.id);
	assert.deepEqual(readPortfolioAuthority(), authority);
	return { authority, bindings: [...bindings.entries()], actual };
}

// The fixed expected inventory is independent of edge-discovered note reads.
// These readback contracts do not create or launch a portfolio campaign, prove
// the expansion trigger/fairness, or substitute for physical teardown evidence.
test('Native portfolio managed graph contains every document-derived fixed relation across all seeded projects with exact note review grant and settlement custody', { timeout: 120_000 }, () => {
	observePortfolio(); verifyGolden('settlement'); verifyGolden('reporter'); readPortfolioAuthority();
});
test('Native portfolio repeated binding note review graph and financial reads retain the complete independent relation inventory without reconciliation mutation', { timeout: 120_000 }, () => {
	const first = observePortfolio();
	for (let repeat = 0; repeat < 2; repeat++) {
		assert.deepEqual(observePortfolio(), first);
		const plan = read(['execution', 'reconcile', '--plan'], first.actual.team); assert.equal(plan.baseRevision, first.actual.graph.revision);
		assert.deepEqual(read(['execution', 'graph', 'show'], first.actual.team), first.actual.graph);
	}
	verifyGolden('settlement'); verifyGolden('reporter'); readPortfolioAuthority();
});
