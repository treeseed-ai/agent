import assert from 'node:assert/strict';
import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';

type Row = Record<string, unknown>;
function row(value: unknown): Row {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_OBSERVATION: Missing or malformed record');
	return value as Row;
}
function text(value: unknown) {
	assert.ok(typeof value === 'string' && value.trim(), 'ACCEPTANCE_OBSERVATION: Missing exact identity or status');
	return value;
}

/** Acceptance-only custody of existing public workday records; not another event authority. */
export function observeCampaign(observed: unknown, workdayId: string, retained: Map<string, Row>) {
	const data = row(observed), run = row(data.run), scheduling = row(data.scheduling);
	assert.equal(run.id, workdayId, 'ACCEPTANCE_CAMPAIGN_ID: Read-back changed identity');
	assert.equal(scheduling.executionId, workdayId, 'ACCEPTANCE_OBSERVATION: Scheduling changed workday');
	assert.equal(scheduling.executionMode, run.executionMode, 'ACCEPTANCE_OBSERVATION: Scheduling changed mode');
	assert.equal(scheduling.status, run.status, 'ACCEPTANCE_OBSERVATION: Scheduling missing, stale or unavailable');
	let failedBoundary: `assignment_${'failed' | 'returned' | 'expired'}` | `graph_${'failed' | 'returned' | 'expired'}` | undefined;
	for (const [field, kind] of [['assignments', 'assignment'], ['nodes', 'graph']] as const) {
		const items = scheduling[field];
		assert.ok(Array.isArray(items), 'ACCEPTANCE_OBSERVATION: Scheduling rows unavailable');
		const keys = new Set<string>();
		for (const value of items) {
			const item = row(value), status = text(item.status);
			const key = kind === 'graph' ? `${text(item.kind)}:${status}` : status;
			assert.ok(!keys.has(key), 'ACCEPTANCE_OBSERVATION: Duplicate scheduling rows'); keys.add(key);
			assert.ok(typeof item.count === 'number' && Number.isSafeInteger(item.count) && item.count >= 0,
				'ACCEPTANCE_OBSERVATION: Malformed scheduling count');
			if (item.count > 0 && (status === 'failed' || status === 'returned' || status === 'expired'))
				failedBoundary ??= `${kind}_${status}`;
		}
	}
	const page = row(data.eventPage);
	assert.ok(typeof page.limit === 'number', 'ACCEPTANCE_OBSERVATION: Missing event page limit');
	try { normalizeCapacityPageLimit(page.limit); } catch { assert.fail('ACCEPTANCE_OBSERVATION: Invalid event page limit'); }
	// The supported CLI currently exposes show, not later event pages. Never invent
	// a command or infer completion from the first page; the missing route blocks.
	assert.equal(page.hasMore, false, 'ACCEPTANCE_OBSERVATION: Incomplete event pagination');
	assert.equal(page.nextCursor, null, 'ACCEPTANCE_OBSERVATION: Unconsumed event cursor');
	assert.ok(Array.isArray(data.events), 'ACCEPTANCE_OBSERVATION: Missing event observations');
	assert.ok(data.events.length <= page.limit, 'ACCEPTANCE_OBSERVATION: Event page exceeds declared limit');
	const current = new Map<string, Row>(), indexes = new Set<number>();
	for (const value of data.events) {
		const event = row(value), id = text(event.id);
		assert.equal(event.runId, workdayId, 'ACCEPTANCE_OBSERVATION: Foreign event workday');
		assert.equal(event.teamId, text(run.teamId), 'ACCEPTANCE_OBSERVATION: Foreign event team');
		text(event.eventType); text(event.status);
		assert.ok(Number.isFinite(Date.parse(text(event.createdAt))), 'ACCEPTANCE_OBSERVATION: Malformed event clock');
		assert.ok(typeof event.eventIndex === 'number' && Number.isSafeInteger(event.eventIndex) && event.eventIndex >= 0,
			'ACCEPTANCE_OBSERVATION: Malformed event index');
		assert.ok(!current.has(id) && !indexes.has(event.eventIndex), 'ACCEPTANCE_OBSERVATION: Duplicate event authority');
		for (const field of ['parameters', 'context', 'refs', 'metadata']) row(event[field]);
		assert.ok(event.status !== 'failed' && event.status !== 'error', 'ACCEPTANCE_OBSERVATION: Historical failed event');
		current.set(id, event); indexes.add(event.eventIndex);
	}
	assert.deepEqual([...indexes].sort((a, b) => a - b), Array.from({ length: indexes.size }, (_, i) => i),
		'ACCEPTANCE_OBSERVATION: Missing event transition');
	for (const [id, previous] of retained) assert.deepEqual(current.get(id), previous,
		'ACCEPTANCE_OBSERVATION: Previously observed event mutated or disappeared');
	for (const [id, event] of current) retained.set(id, structuredClone(event));
	return { run, failedBoundary };
}
