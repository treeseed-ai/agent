import { beforeEach, describe, expect, it } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { gate, state, workdayId, type Row } from './golden-readback-fixture.ts';

const usage = (): Row => state.replies.get('capacity usage')!;
const assignments = (): Row[] => state.replies.get('assignments list')!.items;
const ordered = (values: Row[]) => [...values].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
	|| (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
function page(items: Row[], hasMore = false): Row {
	const last = items.at(-1);
	return { items, page: { limit: 100, hasMore, nextCursor: hasMore && last
		? encodeCapacityPageCursor({ id: last.id, createdAt: last.createdAt }) : null } };
}
function measured(item: Row, index = 0): Row {
	return { id: `${item.id}:aggregate`, idempotencyKey: `usage-${item.id}`, assignmentId: item.id,
		projectId: item.projectId, workDayId: workdayId, assignmentAttempt: index, accountingMode: 'aggregate',
		usageDimension: 'aggregate', activeSeconds: 1, elapsedSeconds: 1,
		nativeUsage: { activeSeconds: 1 }, createdAt: item.completedAt, metadata: { settlementKey: item.id } };
}
beforeEach(() => { state.replies.set('capacity usage', page(ordered(assignments().map(value => measured(value))))); });
function outcomes(candidates: Row[]): string[] {
	return candidates.map(candidate => {
		state.replies.set('capacity usage', candidate); state.usagePages = undefined;
		try { gate('settlement'); return 'ADMITTED'; } catch (error) { return String(error); }
	});
}
// UNIT tests OF actual managed settlement assertions. Supplied measurement DTOs
// are not actual provider usage, canonical UsageSettlements or real settlement receipts.
describe('complete scoped measured usage evidence for managed settlement', () => {
	it('accepts complete scoped measurements without changing the authoritative input records', () => {
		const before = structuredClone([...state.replies]); expect(() => gate('settlement')).not.toThrow();
		expect([...state.replies]).toEqual(before);
	});
	it('denies missing malformed or contradictory usage page authority even when every aggregate appears present', () => {
		const original = structuredClone(usage());
		const pages = [undefined, null, [], {}, { hasMore: false }, { limit: '100', hasMore: false, nextCursor: null },
			{ limit: 101, hasMore: false, nextCursor: null }, { limit: 100, hasMore: 0, nextCursor: null },
			{ limit: 100, hasMore: false, nextCursor: 'moving' }];
		expect(outcomes(pages.map(value => ({ ...original, page: value })))).toEqual(pages.map(() => expect.stringMatching(/ACCEPTANCE_USAGE_PAGE/u)));
	});
	it('denies malformed collections rows clocks and duplicate usage identity before counting settlements', () => {
		const original = structuredClone(usage()), first = original.items[0];
		const candidates = [undefined, null, {}, [...original.items, null], [...original.items, []],
			[...original.items, { ...first, id: '' }], [...original.items, { ...first, id: 'malformed-clock', createdAt: 'invalid' }],
			[...original.items, structuredClone(first)]];
		expect(outcomes(candidates.map(items => ({ ...original, items })))).toEqual(candidates.map(() => expect.stringMatching(/ACCEPTANCE_USAGE_(PAGE|ROW)/u)));
	});
	it('denies wrong project workday or assignment scope despite matching aggregate IDs and nonempty keys', () => {
		const original = structuredClone(usage());
		const mutations = [{ projectId: 'foreign-project' }, { workDayId: 'foreign-workday' }, { projectId: '' },
			{ workDayId: undefined }, { assignmentId: '' }, { idempotencyKey: '' },
			{ metadata: { settlementKey: original.items[1].metadata.settlementKey } }];
		expect(outcomes(mutations.map(change => ({ ...original, items: [{ ...original.items[0], ...change }, ...original.items.slice(1)] }))))
			.toEqual(mutations.map(() => expect.stringMatching(/ACCEPTANCE_USAGE_(SCOPE|IDENTITY)/u)));
	});
	it('denies informational suffix impostors and duplicate aggregate accounting independent of identifier spelling', () => {
		const original = structuredClone(usage()), first = original.items[0];
		expect(outcomes([{ ...original, items: [{ ...first, accountingMode: 'informational' }, ...original.items.slice(1)] },
			{ ...original, items: [...original.items, { ...first, id: 'second-authoritative-aggregate', idempotencyKey: 'second-key' }] }]))
			.toEqual([expect.stringMatching(/ACCEPTANCE_SETTLEMENT_COUNT/u), expect.stringMatching(/ACCEPTANCE_SETTLEMENT_COUNT/u)]);
	});
	it('denies nonfinite coerced negative or unmeasured elapsed and native usage', () => {
		const original = structuredClone(usage());
		const mutations = [{ activeSeconds: -1 }, { activeSeconds: '1' }, { elapsedSeconds: '1' }, { activeSeconds: Infinity },
			{ elapsedSeconds: NaN }, { activeSeconds: 0, elapsedSeconds: 1 }, { nativeUsage: { activeSeconds: -1 } },
			{ nativeUsage: { activeSeconds: '1' } }, { nativeUsage: { activeSeconds: Infinity } }];
		expect(outcomes(mutations.map(change => ({ ...original, items: [{ ...original.items[0], ...change }, ...original.items.slice(1)] }))))
			.toEqual(mutations.map(() => expect.stringMatching(/ACCEPTANCE_USAGE_MEASURED/u)));
	});
	it('requires all terminal stopped attempts to settle exactly once without losing failure or cancellation evidence', () => {
		const stopped = state.cases.get('Stopped simulation retains terminal leases teardown and exactly-once settlement')!;
		const run = state.replies.get('workdays show')!.run; run.status = 'failed';
		const selected = assignments().slice(0, 5);
		['completed', 'failed', 'returned', 'cancelled', 'expired'].forEach((status, index) => { selected[index]!.status = status; });
		state.replies.get('assignments list')!.items = selected; state.replies.set('capacity usage', page(ordered(selected.map(value => measured(value)))));
		expect(stopped).not.toThrow();
		usage().items.pop(); expect(stopped).toThrow(/Exactly one actual settlement/u);
	});
	it('never accepts partial measurements after a continuing page or transport failure', () => {
		const original = structuredClone(usage());
		state.replies.set('capacity usage', { ...original, page: { limit: 100, hasMore: true, nextCursor: 'invalid' } });
		state.usagePages = [state.replies.get('capacity usage')!, page([])];
		expect(() => gate('settlement')).toThrow(/ACCEPTANCE_USAGE_PAGE/u);
	});
});
