import assert from 'node:assert/strict';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { read, row, type Row } from '../acceptance-cli.ts';

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
