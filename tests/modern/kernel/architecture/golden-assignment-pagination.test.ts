import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ pages: [] as Row[], calls: [] as string[][] }));
vi.mock('node:test', () => ({ default: () => undefined }));
vi.mock('../../../acceptance/acceptance-cli.ts', async importOriginal => {
	const original = await importOriginal<typeof import('../../../acceptance/acceptance-cli.ts')>();
	return { ...original, read: (args: string[]) => {
		state.calls.push([...args]);
		const value = state.pages[state.calls.length - 1];
		if (!value) throw new Error('Fixture transport exhausted');
		return value;
	} };
});
const { readWorkdayAssignments } = await import('../../../acceptance/sdk-runtime-golden.test.ts');
const startedAt = '2026-10-02T21:00:00.000Z';
const item = (index: number, workDayId = 'workday-target'): Row => ({
	id: `assignment-${String(100 - index).padStart(3, '0')}`, workDayId,
	createdAt: new Date(Date.parse(startedAt) + (100 - index) * 1000).toISOString(),
});
function page(items: Row[], hasMore = false): Row {
	const last = items.at(-1);
	return { items, page: { limit: 50, hasMore, nextCursor: hasMore && last
		? encodeCapacityPageCursor({ id: String(last.id), createdAt: String(last.createdAt) }) : null } };
}
const collect = () => readWorkdayAssignments('workday-target', startedAt, 'team');
const full = () => Array.from({ length: 50 }, (_, index) => item(index));
beforeEach(() => { state.pages = []; state.calls = []; });

// UNIT tests OF the actual managed acceptance reader; these replies are not live records.
describe('complete managed assignment collection custody', () => {
	it('requests the exact workday on every page without dropping failed target evidence or changing supplied pages', () => {
		state.pages = [page(full(), true), page([{ ...item(50), status: 'failed' }])];
		const before = structuredClone(state.pages);
		expect(collect()).toEqual([...full(), { ...item(50), status: 'failed' }]);
		expect(state.calls).toEqual([
			['assignments', 'list', '--workday', 'workday-target', '--limit', '50'],
			['assignments', 'list', '--workday', 'workday-target', '--limit', '50', '--cursor', (state.pages[0]!.page as Row).nextCursor],
		]);
		expect(state.pages).toEqual(before);
	});
	it('collects every exact page and scopes workday rows without mutating input', () => {
		state.pages = [page(full().map((value, index) => index === 1 ? { ...value, workDayId: 'other-workday' } : value), true), page([item(50)])];
		const before = structuredClone(state.pages);
		expect(collect().map(value => value.id)).toEqual([...full().filter((_, index) => index !== 1), item(50)].map(value => value.id));
		expect(state.calls).toEqual([['assignments', 'list', '--workday', 'workday-target', '--limit', '50'],
			['assignments', 'list', '--workday', 'workday-target', '--limit', '50', '--cursor', (state.pages[0]!.page as Row).nextCursor]]);
		expect(state.pages).toEqual(before);
	});
	it('denies absent malformed or contradictory page authority', () => {
		const mutations = [undefined, null, [], {}, { hasMore: false }, { limit: '50', hasMore: false, nextCursor: null },
			{ limit: 51, hasMore: false, nextCursor: null }, { limit: 50, hasMore: 'false', nextCursor: null },
			{ limit: 50, hasMore: false, nextCursor: 'moving' }];
		const admitted = mutations.map(value => {
			state.pages = [{ items: [item(0)], page: value }]; state.calls = [];
			try { collect(); return value; } catch { return undefined; }
		}).filter(value => value !== undefined);
		// Count undefined too: a missing page must also be explicitly denied.
		state.pages = [{ items: [item(0)] }]; state.calls = [];
		expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_PAGE/u);
		expect(admitted).toEqual([]);
	});
	it('denies malformed collection rows identities and creation clocks', () => {
		for (const value of [null, [], {}, { ...item(0), id: '' }, { ...item(0), id: 1 },
			{ ...item(0), createdAt: '' }, { ...item(0), createdAt: 'invalid' }, { ...item(0), workDayId: 1 }]) {
			state.pages = [page([value as Row])]; state.calls = [];
			expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_ROW/u);
		}
	});
	it('denies missing nonarray or oversized collection payloads', () => {
		for (const items of [undefined, null, {}, [...full(), item(50)]]) {
			state.pages = [{ items, page: { limit: 50, hasMore: false, nextCursor: null } }]; state.calls = [];
			expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_PAGE/u);
		}
	});
	it('denies empty or short continuing pages and cursor authority unrelated to the last row', () => {
		for (const candidate of [page([], true), page([item(0)], true),
			{ ...page(full(), true), page: { limit: 50, hasMore: true, nextCursor: 'invalid' } },
			{ ...page(full(), true), page: { limit: 50, hasMore: true, nextCursor: encodeCapacityPageCursor({ id: 'other', createdAt: startedAt }) } }]) {
			state.pages = [candidate, page([item(50)])]; state.calls = [];
			expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_PAGE/u);
		}
	});
	it('denies duplicate records and reversed ordering within or across pages including unrelated workdays', () => {
		for (const pages of [[page([item(0), item(0)])], [page([item(1), item(0)])],
			[page(full(), true), page([item(0)])], [page(full(), true), page([{ ...item(49), workDayId: 'other-workday' }])]]) {
			state.pages = pages; state.calls = [];
			expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_(ROW|ORDER)/u);
		}
	});
	it('does not infer completion from old timestamps or stop before explicit terminal authority', () => {
		const old = full().map(value => ({ ...value, createdAt: '2026-10-01T21:00:00.000Z', workDayId: 'other-workday' }));
		state.pages = [page(old, true), page([{ ...item(50), createdAt: '2026-10-01T21:00:00.000Z' }])];
		// A target workday row predating its authoritative start is corrupt, not absent evidence.
		expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_ROW/u);
		expect(state.calls).toHaveLength(2);
	});
	it('denies missing start authority and target assignments before the original workday start', () => {
		for (const start of ['', 'invalid']) {
			state.pages = [page([item(0)])]; state.calls = [];
			expect(() => readWorkdayAssignments('workday-target', start, 'team')).toThrow(/ACCEPTANCE_ASSIGNMENT_ROW/u);
		}
		state.pages = [page([{ ...item(0), createdAt: '2026-10-01T21:00:00.000Z' }])]; state.calls = [];
		expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_ROW/u);
	});
	it('retains the original forty-page bound and fails instead of accepting a continuing tail', () => {
		state.pages = Array.from({ length: 40 }, (_, pageIndex) => page(Array.from({ length: 50 }, (_, index) => ({
			id: `assignment-${String(2000 - pageIndex * 50 - index).padStart(4, '0')}`, workDayId: 'workday-target',
			createdAt: new Date(Date.parse(startedAt) + (2000 - pageIndex * 50 - index) * 1000).toISOString(),
		})), true));
		expect(() => collect()).toThrow(); expect(state.calls).toHaveLength(40);
	});
	it('accepts equal-clock identity ordering and an explicitly empty terminal page without losing earlier evidence', () => {
		const items = full().map(value => ({ ...value, createdAt: '2026-10-02T21:00:01.000Z' }));
		state.pages = [page(items, true), page([])];
		expect(collect()).toEqual(items); expect(state.calls).toHaveLength(2);
	});
	it('denies repeated cursor authority or transport failure after a valid first page instead of returning partial evidence', () => {
		state.pages = [page(full(), true)];
		expect(() => collect()).toThrow('Fixture transport exhausted'); expect(state.calls).toHaveLength(2);
		const next = Array.from({ length: 50 }, (_, index) => item(index + 50));
		state.pages = [page(full(), true), { ...page(next, true), page: (page(full(), true)).page }]; state.calls = [];
		expect(() => collect()).toThrow(/ACCEPTANCE_ASSIGNMENT_PAGE/u);
	});
});
