import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { read, row, type Row } from '../../../acceptance-cli.ts';

export function availabilityHistory(team: string) {
	const sessions = [], identities = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
	let previous: { id: string; time: number } | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
		const observed = read(['capacity', 'status', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], team), page = row(observed.page);
		assert.ok(Array.isArray(observed.items) && observed.items.length <= 100 && page.limit === 100 && typeof page.hasMore === 'boolean',
			'ACCEPTANCE_AVAILABILITY_PAGE: Original complete page authority required');
		for (const value of observed.items) {
			const session = row(value), id = typeof session.id === 'string' ? session.id : '', time = Date.parse(String(session.openedAt));
			assert.ok(id && Number.isFinite(time) && !identities.has(id), 'ACCEPTANCE_AVAILABILITY_PAGE: Unique session identity and owning opening clock required');
			assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id), 'ACCEPTANCE_AVAILABILITY_PAGE: Original descending opening order required');
			identities.add(id); previous = { id, time }; sessions.push(session);
		}
		if (!page.hasMore) { assert.equal(page.nextCursor, null, 'ACCEPTANCE_AVAILABILITY_PAGE: Explicit terminal cursor required'); return sessions; }
		assert.ok(observed.items.length === 100 && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor),
			'ACCEPTANCE_AVAILABILITY_PAGE: Complete progressing inventory required');
		const next = decodeCapacityPageCursor(page.nextCursor), last = sessions.at(-1)!;
		// Original repository creation/opening clocks are the same publication input.
		assert.ok(next && next.id === last.id && next.createdAt === last.openedAt, 'ACCEPTANCE_AVAILABILITY_PAGE: Cursor must bind the actual last session');
		cursor = page.nextCursor; cursors.add(cursor);
	}
	assert.fail('ACCEPTANCE_AVAILABILITY_PAGE: Complete inventory exceeds the original forty-page acceptance bound');
}
