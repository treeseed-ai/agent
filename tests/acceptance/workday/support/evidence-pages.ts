import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { graphRevisionSchema, type GraphRevision, assignmentAttemptSchema, assignmentResultSchema, executionEdgeSchema, executionNodeSchema, validateExecutionGraph } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../../acceptance-cli.ts';

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

/** Reconcile current public inventory against original births and edge removals. */
export function verifyGraphRetention(graph: Row, history: GraphRevision[]): void {
	const label = 'ACCEPTANCE_GRAPH_RETENTION: Current inventory must retain original graph authority';
	try {
		assert.equal(typeof graph.teamId, 'string', label);
		assert.ok(Number.isSafeInteger(graph.revision) && Number(graph.revision) >= 0, label);
		assert.equal(history.length, graph.revision, label);
		const nodes = graphList(graph.nodes).map(value => { const parsed = executionNodeSchema.parse(value); assert.deepEqual(parsed, value, label); return parsed; });
		const edges = graphList(graph.edges).map(value => { const parsed = executionEdgeSchema.parse(value); assert.deepEqual(parsed, value, label); return parsed; });
		const born = new Map<string, number>(), edgeBirth = new Map<string, number>(), active = new Set<string>();
		for (const [index, value] of history.entries()) {
			const record = graphRevisionSchema.parse(value); assert.deepEqual(record, value, label);
			assert.equal(record.teamId, graph.teamId, label); assert.equal(record.revision, index + 1, label);
			for (const id of record.changes.added) { assert.ok(!born.has(id), label); born.set(id, record.revision); }
			for (const field of ['changed', 'completed', 'blocked', 'stale'] as const) {
				const ids = record.changes[field]; assert.equal(new Set(ids).size, ids.length, label);
				assert.ok(ids.every(id => born.has(id)), label);
			}
			for (const id of record.changes.removedEdges) { assert.ok(active.delete(id), label); }
			for (const id of record.changes.addedEdges) { assert.ok(!active.has(id), label); active.add(id); if (!edgeBirth.has(id)) edgeBirth.set(id, record.revision); }
		}
		if (history.length) assert.equal(history.at(-1)!.graphDigest, graph.digest, label);
		assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, label);
		assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length, label);
		assert.deepEqual(new Set(nodes.map(node => node.id)), new Set(born.keys()), label);
		assert.deepEqual(new Set(edges.map(edge => edge.id)), active, label);
		for (const node of nodes) {
			assert.equal(node.teamId, graph.teamId, label); assert.equal(node.graphRevisionCreated, born.get(node.id), label);
			assert.ok(node.graphRevisionUpdated >= node.graphRevisionCreated && node.graphRevisionUpdated <= Number(graph.revision), label);
		}
		for (const edge of edges) {
			assert.equal(edge.teamId, graph.teamId, label); assert.equal(edge.graphRevisionCreated, edgeBirth.get(edge.id), label);
			assert.equal(edge.graphRevisionRemoved, undefined, label);
			assert.ok(born.has(edge.fromNodeId) && born.has(edge.toNodeId), label);
		}
	} catch (cause) { throw new Error(label, { cause }); }
}

export function verifyPredecessorCustody(assignments: Row[], graph: Row): Array<{ review: Row; actor: Row }> {
	verifyGraphProvenance(graph);
	const nodes = graphList(graph.nodes).map(value => executionNodeSchema.parse(value));
	const edges = graphList(graph.edges).map(value => executionEdgeSchema.parse(value));
	assert.equal(new Set(assignments.map(item => item.id)).size, assignments.length, 'ACCEPTANCE_PREDECESSOR_IDENTITY: Duplicate attempt');
	const results = new Map<string, Row>(), attempts = new Map<Row, ReturnType<typeof assignmentAttemptSchema.parse>>();
	for (const item of assignments) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); attempts.set(item, attempt);
		assert.deepEqual(attempt, item.assignmentAttempt, 'ACCEPTANCE_PREDECESSOR_ATTEMPT: Original canonical bytes cannot be repaired on read');
		assert.ok(attempt.id === item.id && attempt.nodeId === item.executionNodeId && attempt.nodeRevision === item.executionNodeRevision
			&& attempt.projectId === item.projectId && attempt.teamId === item.teamId && attempt.teamId === graph.teamId
			&& attempt.workdayId === item.workDayId && attempt.createdAt === item.createdAt,
			'ACCEPTANCE_PREDECESSOR_ATTEMPT: Canonical attempt and owning public identity disagree');
		if (item.assignmentResult !== undefined && item.assignmentResult !== null) {
			const result = assignmentResultSchema.parse(item.assignmentResult);
			assert.deepEqual(result, item.assignmentResult, 'ACCEPTANCE_PREDECESSOR_RESULT: Original canonical result cannot be repaired on read');
			assert.ok(result.assignmentId === item.id && (item.status !== 'completed' || result.status === 'completed') && result.completedAt === item.completedAt
				&& Date.parse(result.completedAt) >= Date.parse(attempt.createdAt) && !results.has(result.id),
				'ACCEPTANCE_PREDECESSOR_RESULT: Unique original result and lawful completion clock required');
			results.set(result.id, item);
		}
	}
	const pairs = new Map<string, { review: Row; actor: Row }>();
	for (const item of assignments) {
		const attempt = attempts.get(item)!;
		assert.equal(new Set(attempt.predecessorResultIds).size, attempt.predecessorResultIds.length, 'ACCEPTANCE_PREDECESSOR_IDENTITY: Duplicate predecessor result');
		for (const resultId of attempt.predecessorResultIds) {
			const predecessor = results.get(resultId);
			assert.ok(predecessor, 'ACCEPTANCE_PREDECESSOR_MISSING: Every declared result needs independent assignment readback');
			assert.equal(predecessor.status, 'completed'); assert.equal(predecessor.projectId, attempt.projectId,
				'ACCEPTANCE_PREDECESSOR_PROJECT: Cross-project consumption needs separate relation/read-grant proof');
			assert.ok(attempts.get(predecessor)!.workdayId === attempt.workdayId && Date.parse(String(predecessor.completedAt)) <= Date.parse(attempt.createdAt),
				'ACCEPTANCE_PREDECESSOR_CLOCK: Exact-workday completion must precede dependent admission');
		}
		const node = nodes.find(value => value.id === attempt.nodeId);
		assert.ok(node && node.projectId === attempt.projectId, 'ACCEPTANCE_REQUIRED_PREDECESSOR: Independent owning graph node required');
		const incoming = edges.filter(edge => edge.toNodeId === node.id && edge.graphRevisionCreated <= attempt.graphRevision
			&& (edge.graphRevisionRemoved === undefined || edge.graphRevisionRemoved > attempt.graphRevision));
		for (const edge of incoming) {
			const source = nodes.find(value => value.id === edge.fromNodeId)!;
			if (source.kind === 'condition') continue; // Existing governed Decision/readiness verifier owns condition authority.
			const candidates = assignments.filter(prior => attempts.get(prior)!.nodeId === source.id
				&& attempts.get(prior)!.workdayId === attempt.workdayId && Date.parse(String(prior.createdAt)) <= Date.parse(attempt.createdAt))
				.sort((a, b) => attempts.get(b)!.nodeRevision - attempts.get(a)!.nodeRevision || Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
			const predecessor = candidates[0], second = candidates[1];
			assert.ok(predecessor && !(second && attempts.get(predecessor)!.nodeRevision === attempts.get(second)!.nodeRevision
				&& predecessor.createdAt === second.createdAt), 'ACCEPTANCE_REQUIRED_PREDECESSOR: Missing or ambiguous original predecessor attempt');
			assert.ok(predecessor.status === 'completed' && Date.parse(String(predecessor.completedAt)) <= Date.parse(attempt.createdAt)
				&& attempt.predecessorResultIds.includes(String(row(predecessor.assignmentResult).id)),
				'ACCEPTANCE_REQUIRED_PREDECESSOR: Every graph predecessor must complete and be consumed before admission');
			assert.deepEqual(attempts.get(predecessor)!.sourceRef, source.sourceRef, 'ACCEPTANCE_REQUIRED_PREDECESSOR: Original predecessor source drifted');
			if (source.pairRole === 'reviewer') {
				assert.equal(row(row(predecessor.lifecycleOutput).activityCompletion).reviewDisposition, 'approved',
					'ACCEPTANCE_REQUIRED_REVIEW: Actor completion or a non-approving review cannot authorize downstream work');
				const pairEdges = edges.filter(pair => pair.provenance === 'review-pair' && pair.toNodeId === source.id
					&& pair.graphRevisionCreated <= attempts.get(predecessor)!.graphRevision
					&& (pair.graphRevisionRemoved === undefined || pair.graphRevisionRemoved > attempts.get(predecessor)!.graphRevision));
				assert.equal(pairEdges.length, 1, 'ACCEPTANCE_REQUIRED_REVIEW: Exactly one original Actor/Reviewer edge required');
				const actor = assignments.find(prior => prior.executionNodeId === pairEdges[0]!.fromNodeId
					&& attempts.get(predecessor)!.predecessorResultIds.includes(String(row(prior.assignmentResult).id)));
				assert.ok(actor && attempt.predecessorResultIds.includes(String(row(actor.assignmentResult).id)),
					'ACCEPTANCE_REQUIRED_REVIEW: Dependent input must retain the exact reviewed Actor result');
				pairs.set(String(predecessor.id), { review: predecessor, actor });
			}
		}
	}
	return [...pairs.values()];
}
/** A preview must prove an identical graph before the supported actual reconciliation. */
export function verifyGraphNoopPlan(graph: Row, plan: Row): void {
	const fail = 'ACCEPTANCE_GRAPH_NOOP: Reconciliation preview differs from held graph authority';
	assert.equal(plan.teamId, graph.teamId, fail); assert.equal(plan.baseRevision, graph.revision, fail);
	assert.equal(plan.desiredDigest, graph.digest, fail);
	const changes = graphRevisionSchema.shape.changes.safeParse(plan.changes);
	assert.ok(changes.success, fail); assert.deepEqual(changes.data, plan.changes, fail);
	assert.ok(Object.values(changes.data).every(ids => ids.length === 0), fail);
}

export function verifyGraphProvenance(graph: Row): void {
	const nodes = graphList(graph.nodes).map(value => { const parsed = executionNodeSchema.parse(value);
		assert.deepEqual(parsed, value, 'ACCEPTANCE_EDGE_PROVENANCE: Original node cannot be repaired'); return parsed; });
	const edges = graphList(graph.edges).map(value => { const parsed = executionEdgeSchema.parse(value);
		assert.deepEqual(parsed, value, 'ACCEPTANCE_EDGE_PROVENANCE: Original edge cannot be repaired'); return parsed; });
	assert.ok(nodes.length > 0 && edges.length > 0, 'ACCEPTANCE_TEAM_GRAPH_EMPTY: Empty projection cannot pass');
	assert.equal(new Set(nodes.map(value => value.id)).size, nodes.length);
	assert.equal(new Set(edges.map(value => value.id)).size, edges.length);
	// Validation owns exact edge parsing; the public schema stays the authority.
	const checked = validateExecutionGraph(nodes, edges);
	assert.ok(checked.ok, 'ACCEPTANCE_TEAM_GRAPH_INVALID: Dangling cyclic or malformed graph');
	for (const edge of edges) {
		const from = nodes.find(value => value.id === edge.fromNodeId), to = nodes.find(value => value.id === edge.toNodeId);
		assert.ok(from && to); assert.equal(from.teamId, graph.teamId); assert.equal(to.teamId, graph.teamId);
		assert.equal(edge.teamId, graph.teamId, 'ACCEPTANCE_EDGE_PROVENANCE: Foreign edge team');
		assert.ok(edge.sourceRef, 'ACCEPTANCE_EDGE_PROVENANCE: Exact source reference required for every edge');
		assert.ok(['profile-agent', 'profile-event', 'work-item', 'review-pair', 'governance', 'treedx-link'].includes(String(edge.provenance)),
			'ACCEPTANCE_EDGE_PROVENANCE: Exact governed edge origin required');
		if (['review-pair', 'profile-agent', 'work-item'].includes(edge.provenance))
			assert.deepEqual(edge.sourceRef, to.sourceRef, 'ACCEPTANCE_EDGE_PROVENANCE: Governed dependency source differs from its owning node');
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
export function readCompleteEvidence(args: string[], team: string, limit: number, prefix: string, direction: 'descending' | 'ascending' = 'descending'): Row[] {
	return collectCompleteEvidence(cursor => read([...args, '--limit', String(limit), ...(cursor ? ['--cursor', cursor] : [])], team), limit, prefix, direction);
}

/** One cursor validator for the existing public CLI and campaign show page. */
export function collectCompleteEvidence(fetchPage: (cursor: string | undefined) => Row, limit: number, prefix: string, direction: 'descending' | 'ascending', clockField: 'createdAt' | 'openedAt' = 'createdAt'): Row[] {
	const records: Row[] = [], identities = new Set<string>(), cursors = new Set<string>();
	let cursor: string | undefined, previous: { id: string; time: number } | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const observed = fetchPage(cursor);
		const page = row(observed.page);
		assert.ok(Array.isArray(observed.items) && observed.items.length <= limit && page.limit === limit
			&& typeof page.hasMore === 'boolean', `${prefix}_PAGE: Complete typed page authority required`);
		for (const value of observed.items) {
			assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${prefix}_ROW: Record required`);
			const item = row(value), id = typeof item.id === 'string' ? item.id : '';
			const time = Date.parse(typeof item[clockField] === 'string' ? String(item[clockField]) : '');
			assert.ok(id && Number.isFinite(time) && !identities.has(id), `${prefix}_ROW: Unique identity and creation clock required`);
			assert.ok(!previous || (direction === 'descending' ? time < previous.time || (time === previous.time && id < previous.id)
				: time > previous.time || (time === previous.time && id > previous.id)), `${prefix}_ORDER: Exact creation/identity order required across all pages`);
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
		assert.ok(next && next.id === last.id && next.createdAt === last[clockField],
			`${prefix}_PAGE: Cursor must bind the actual last record`);
		cursor = page.nextCursor; cursors.add(cursor);
	}
	assert.fail(`${prefix}_PAGE: Complete evidence was not reached within the original forty-page bound`);
}
