import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { graphRevisionSchema, type GraphRevision, assignmentAttemptSchema, executionEdgeSchema, executionNodeSchema, validateExecutionGraph } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../acceptance-cli.ts';

/** Complete existing watch contract: empty terminal page retains its cursor.
 * This proves retrieval against the independently read current graph, not that
 * the producer emitted every provider/lease/resource transition. */
export function completeGraphHistory(graph: Row, fetchPage: (cursor: string) => Row): GraphRevision[] {
	assert.equal(typeof graph.teamId, 'string'); assert.ok(Number.isInteger(graph.revision) && Number(graph.revision) > 0);
	assert.match(String(graph.digest), /^sha256:[a-f0-9]{64}$/u);
	let cursor = '0', previousClock = -Infinity;
	const records: GraphRevision[] = [];
	for (;;) {
		const response = fetchPage(cursor);
		assert.ok(Array.isArray(response.items), 'ACCEPTANCE_GRAPH_PAGE: Explicit typed collection required');
		assert.equal(typeof response.nextCursor, 'string', 'ACCEPTANCE_GRAPH_CURSOR: Explicit cursor required');
		if (!response.items.length) {
			assert.equal(response.nextCursor, cursor, 'ACCEPTANCE_GRAPH_TERMINAL: Empty terminal page must retain exact cursor'); break;
		}
		for (const value of response.items) {
			const parsed = graphRevisionSchema.safeParse(value);
			assert.ok(parsed.success, 'ACCEPTANCE_GRAPH_RECORD: Complete canonical graph revision required');
			const record = parsed.data, clock = Date.parse(record.createdAt);
			assert.equal(record.teamId, graph.teamId, 'ACCEPTANCE_GRAPH_SCOPE: Foreign team revision');
			assert.equal(record.revision, records.length + 1, 'ACCEPTANCE_GRAPH_CONTINUITY: Missing duplicate or unordered revision');
			assert.ok(record.revision <= Number(graph.revision), 'ACCEPTANCE_GRAPH_FUTURE: Record beyond held current graph');
			assert.ok(clock >= previousClock, 'ACCEPTANCE_GRAPH_CLOCK: Append order contradicts record clock'); previousClock = clock;
			records.push(record);
		}
		assert.equal(response.nextCursor, String(records.at(-1)!.revision), 'ACCEPTANCE_GRAPH_PROGRESS: Cursor must be exact last row');
		assert.notEqual(response.nextCursor, cursor); cursor = response.nextCursor;
	}
	assert.equal(records.length, graph.revision, 'ACCEPTANCE_GRAPH_COMPLETENESS: Hidden or interrupted final tail');
	assert.equal(records.at(-1)!.graphDigest, graph.digest, 'ACCEPTANCE_GRAPH_DIGEST: Last revision must match independent current graph');
	return records;
}
const graphList = (value: unknown): Row[] => {
	assert.ok(Array.isArray(value), 'ACCEPTANCE_TEAM_GRAPH_COLLECTION: Complete array required');
	return value.map(row);
};
export function verifyPredecessorCustody(assignments: Row[]): void {
	const results = new Map(assignments.map(item => [row(item.assignmentResult).id, item]));
	for (const item of assignments) {
		const parsed = assignmentAttemptSchema.safeParse(item.assignmentAttempt);
		assert.ok(parsed.success, 'ACCEPTANCE_PREDECESSOR_ATTEMPT: Whole canonical frozen attempt required');
		const attempt = parsed.data;
		assert.equal(attempt.id, item.id); assert.equal(attempt.nodeRevision, item.executionNodeRevision);
		assert.equal(new Set(attempt.predecessorResultIds).size, attempt.predecessorResultIds.length,
			'ACCEPTANCE_PREDECESSOR_IDENTITY: Duplicate predecessor result');
		for (const resultId of attempt.predecessorResultIds) {
			const predecessor = results.get(resultId);
			assert.ok(predecessor, 'ACCEPTANCE_PREDECESSOR_MISSING: Every declared result needs independent assignment readback');
			assert.equal(predecessor.status, 'completed');
			assert.equal(predecessor.projectId, attempt.projectId,
				'ACCEPTANCE_PREDECESSOR_PROJECT: Cross-project consumption needs the separate relation/read-grant acceptance case');
			assert.equal(row(predecessor.assignmentResult).assignmentId, predecessor.id);
			const completed = Date.parse(String(predecessor.completedAt)), admitted = Date.parse(String(item.createdAt));
			assert.ok(Number.isFinite(completed) && Number.isFinite(admitted) && completed <= admitted,
				'ACCEPTANCE_PREDECESSOR_CLOCK: Dependent admission must follow actual predecessor completion');
		}
	}
}
export function verifyGraphProvenance(graph: Row): void {
	const nodes = graphList(graph.nodes).map(value => executionNodeSchema.parse(value));
	const edges = graphList(graph.edges).map(value => executionEdgeSchema.parse(value));
	assert.ok(nodes.length > 0 && edges.length > 0, 'ACCEPTANCE_TEAM_GRAPH_EMPTY: Empty projection cannot pass');
	assert.equal(new Set(nodes.map(value => value.id)).size, nodes.length);
	assert.equal(new Set(edges.map(value => value.id)).size, edges.length);
	// Validation owns exact edge parsing; the public schema stays the authority.
	const checked = validateExecutionGraph(nodes, edges);
	assert.ok(checked.ok, 'ACCEPTANCE_TEAM_GRAPH_INVALID: Dangling cyclic or malformed graph');
	for (const edge of edges) {
		const from = nodes.find(value => value.id === edge.fromNodeId), to = nodes.find(value => value.id === edge.toNodeId);
		assert.ok(from && to); assert.equal(from.teamId, graph.teamId); assert.equal(to.teamId, graph.teamId);
		assert.ok(['profile-agent', 'profile-event', 'work-item', 'review-pair', 'governance', 'treedx-link'].includes(String(edge.provenance)),
			'ACCEPTANCE_EDGE_PROVENANCE: Exact governed edge origin required');
		if (edge.provenance === 'review-pair') {
			assert.equal(from.pairRole, 'actor'); assert.equal(to.pairRole, 'reviewer');
			assert.equal(from.workItemId, to.workItemId); assert.equal(from.projectId, to.projectId);
		}
		if (edge.provenance === 'profile-agent' || edge.provenance === 'work-item') {
			assert.ok(from.pairRole !== 'actor' || !edges.some(pair => pair.provenance === 'review-pair' && pair.fromNodeId === from.id),
				'ACCEPTANCE_EDGE_REVIEW: Reviewed dependencies must consume the independent review node');
		}
		if (from.projectId !== to.projectId) assert.ok(edge.provenance === 'treedx-link' && Object.keys(row(edge.sourceRef)).length > 0,
			'ACCEPTANCE_CROSS_PROJECT_RELATION: No implicit cross-project dependency');
	}
}

/** Same public descending cursor contract for assignment and measured-usage readback.
 * This is an acceptance assertion, not a runner or another observation authority. */
export function readCompleteEvidence(args: string[], team: string, limit: number, prefix: string): Row[] {
	const records: Row[] = [], identities = new Set<string>(), cursors = new Set<string>();
	let cursor: string | undefined, previous: { id: string; time: number } | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const observed = read([...args, '--limit', String(limit), ...(cursor ? ['--cursor', cursor] : [])], team);
		const page = row(observed.page);
		assert.ok(Array.isArray(observed.items) && observed.items.length <= limit && page.limit === limit
			&& typeof page.hasMore === 'boolean', `${prefix}_PAGE: Complete typed page authority required`);
		for (const value of observed.items) {
			assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${prefix}_ROW: Record required`);
			const item = row(value), id = typeof item.id === 'string' ? item.id : '';
			const time = Date.parse(typeof item.createdAt === 'string' ? item.createdAt : '');
			assert.ok(id && Number.isFinite(time) && !identities.has(id), `${prefix}_ROW: Unique identity and creation clock required`);
			assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id),
				`${prefix}_ORDER: Exact descending creation/identity order required across all pages`);
			identities.add(id); previous = { id, time }; records.push(item);
		}
		if (!page.hasMore) {
			assert.equal(page.nextCursor, null, `${prefix}_PAGE: Terminal cursor must be explicitly null`);
			return records;
		}
		assert.ok(observed.items.length === limit && typeof page.nextCursor === 'string' && page.nextCursor
			&& !cursors.has(page.nextCursor), `${prefix}_PAGE: Complete progressing page required`);
		let next;
		try { next = decodeCapacityPageCursor(page.nextCursor); }
		catch { assert.fail(`${prefix}_PAGE: Invalid cursor authority`); }
		const last = records.at(-1)!;
		assert.ok(next && next.id === last.id && next.createdAt === last.createdAt,
			`${prefix}_PAGE: Cursor must bind the actual last record`);
		cursor = page.nextCursor; cursors.add(cursor);
	}
	assert.fail(`${prefix}_PAGE: Complete evidence was not reached within the original forty-page bound`);
}
