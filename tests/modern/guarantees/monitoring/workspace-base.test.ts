import { expect, it } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { liveAssignmentGraph, liveAssignmentRecord } from './live-assignment-fixture.ts';
import { verifyLiveWorkspaceBase } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';

const repository = 'treeseed-ai/sdk';
function source(id: string, commit: string, predecessors: string[] = [], nodeId = id): Row {
	const attempt = assignmentAttemptSchema.parse(liveAssignmentRecord().assignmentAttempt);
	Object.assign(attempt, { id, idempotencyKey: id, nodeId, predecessorResultIds: predecessors, status: 'completed',
		startedAt: attempt.createdAt, finishedAt: new Date(Date.parse(attempt.createdAt) + 1).toISOString() });
	const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${id}`, assignmentId: id,
		status: 'completed', summary: 'Controlled original source result.', references: [{ kind: 'git', repository, commit }],
		verification: [], usage: { elapsedSeconds: 0 }, diagnostics: [], completedAt: attempt.finishedAt });
	return { ...liveAssignmentRecord(attempt), status: 'completed', leaseState: 'released', completedAt: result.completedAt, assignmentResult: result };
}
function fixture(items: Row[] = []) {
	const child = liveAssignmentRecord(), attempt = row(child.assignmentAttempt), workspace = row(attempt.workspace), base = String(workspace.baseCommit);
	attempt.createdAt = child.createdAt = new Date(Date.parse(String(attempt.createdAt)) + 10).toISOString();
	attempt.predecessorResultIds = items.map(value => row(value.assignmentResult).id);
	return { child, items, base, frozen: { [repository]: base }, graph: liveAssignmentGraph(child) };
}
function check(f: ReturnType<typeof fixture>) {
	verifyLiveWorkspaceBase(f.child, [...f.items, f.child], f.frozen, f.graph);
}

it('requires the frozen first base and exact single predecessor base without changing original authority', () => {
	for (const items of [[], [source('first', 'b'.repeat(40))]]) {
		const f = fixture(items), expected = items.length ? 'b'.repeat(40) : f.base; row(row(f.child.assignmentAttempt).workspace).baseCommit = expected;
		const before = structuredClone(f); check(f); expect(f).toEqual(before);
		for (const value of ['', 'staging', 'f'.repeat(40), ...items.length ? [f.base] : []]) {
			row(row(f.child.assignmentAttempt).workspace).baseCommit = value;
			expect(() => check(f)).toThrow();
		}
	}
});

it('requires the terminal consumed source lineage and rejects older unrelated cyclic duplicate or ambiguous source results', () => {
	const first = source('first', 'b'.repeat(40)), last = source('last', 'c'.repeat(40), ['result-first']);
	const f = fixture([first, last]); row(row(f.child.assignmentAttempt).workspace).baseCommit = 'c'.repeat(40);
	const before = structuredClone(f); check(f); expect(f).toEqual(before);
	for (const change of [
		() => { row(row(f.child.assignmentAttempt).workspace).baseCommit = 'b'.repeat(40); },
		() => { row(row(f.child.assignmentAttempt).workspace).baseCommit = f.base; },
		() => { row(f.items[1]!.assignmentAttempt).predecessorResultIds = []; },
		() => { row(f.items[0]!.assignmentAttempt).predecessorResultIds = ['result-last']; },
		() => { f.items.push(structuredClone(f.items[0]!)); },
		() => { (row(f.items[0]!.assignmentResult).references as Row[]).push({ kind: 'git', repository, commit: 'd'.repeat(40) }); },
	]) {
		Object.assign(f, structuredClone(before)); change(); const failed = structuredClone(f);
		expect(() => check(f)).toThrow('ACCEPTANCE_LIVE_SOURCE_BASE'); expect(f).toEqual(failed);
	}
	Object.assign(f, structuredClone(before)); check(f);
});

it('retains explicit release integration on the frozen base with every independent input instead of silently selecting a branch', () => {
	const f = fixture([source('left', 'b'.repeat(40)), source('right', 'c'.repeat(40))]);
	(row(row(f.child.assignmentAttempt).grant).tools as string[]).push('release');
	(row(row(row(f.child.assignmentAttempt).effectiveProfile).permissionCeiling).tools as string[]).push('release');
	const before = structuredClone(f); check(f); expect(f).toEqual(before);
	for (const value of ['b'.repeat(40), 'c'.repeat(40)]) {
		row(row(f.child.assignmentAttempt).workspace).baseCommit = value; expect(() => check(f)).toThrow('ACCEPTANCE_LIVE_SOURCE_BASE');
	}
});

it('retains a revised Actor own older candidate while selecting only its original immediate reviewed upstream base', () => {
	const upstream = source('upstream', 'b'.repeat(40)), previous = source('previous-self', 'c'.repeat(40));
	const f = fixture([upstream, previous]), attempt = row(f.child.assignmentAttempt); attempt.nodeRevision = 2;
	row(previous.assignmentAttempt).nodeId = attempt.nodeId; f.graph = liveAssignmentGraph(f.child);
	const upstreamNode = (liveAssignmentGraph(upstream).nodes as Row[])[0]!, reviewNode = { ...upstreamNode, id: 'upstream-review', kind: 'reviewing', pairRole: 'reviewer' };
	(f.graph.nodes as Row[]).push(upstreamNode, reviewNode);
	(f.graph.edges as Row[]).push({ id: 'original-pair', fromNodeId: 'upstream', toNodeId: 'upstream-review', provenance: 'review-pair', graphRevisionCreated: 1 },
		{ id: 'original-immediate', fromNodeId: 'upstream-review', toNodeId: attempt.nodeId, provenance: 'work-item', graphRevisionCreated: 1 });
	row(attempt.workspace).baseCommit = 'b'.repeat(40); const before = structuredClone(f); check(f); expect(f).toEqual(before);
	for (const change of [
		() => { row(row(f.child.assignmentAttempt).workspace).baseCommit = 'c'.repeat(40); },
		() => { f.graph.teamId = 'foreign-team'; },
		() => { f.graph.nodes = []; },
		() => { (f.graph.nodes as Row[])[0]!.pairRole = null; },
		() => { f.graph.edges = []; },
		() => { (f.graph.edges as Row[]).splice(-2, 1); },
	]) {
		Object.assign(f, structuredClone(before)); change(); const failed = structuredClone(f);
		expect(() => check(f)).toThrow('ACCEPTANCE_LIVE_SOURCE_BASE'); expect(f).toEqual(failed);
	}
});

it('rejects a missing or mutable frozen base and preserves non-Git workspace authority unchanged', () => {
	const f = fixture();
	for (const frozen of [{}, { [repository]: '' }, { [repository]: 'staging' }])
		expect(() => verifyLiveWorkspaceBase(f.child, [f.child], frozen, f.graph)).toThrow('ACCEPTANCE_LIVE_SOURCE_BASE');
	row(f.child.assignmentAttempt).workspace = { mode: 'read-only' };
	row(row(f.child.assignmentAttempt).grant).sourceWrite = [];
	row(row(f.child.assignmentAttempt).grant).tools = ['source.read']; const before = structuredClone(f);
	verifyLiveWorkspaceBase(f.child, [f.child], {}, f.graph); expect(f).toEqual(before);
});
