import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, graphRevisionSchema } from '@treeseed/sdk/agent-capacity';
import { state } from '../golden-readback-fixture.ts';
import { request } from '../../provider-kernel-fixture.ts';
import { completeGraphHistory } from '../../../../acceptance/workday/support/evidence-pages.ts';
await import('../../../../acceptance/workday/graph-history.test.ts');

function input() {
	const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	if (!attempt) throw new Error('Whole canonical attempt required');
	const records = Array.from({ length: 101 }, (_, index) => graphRevisionSchema.parse({
		schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team', revision: index + 1, ruleRevision: 1,
		changedSourceRefs: [attempt.sourceRef], graphDigest: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
		changes: { added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] },
		createdAt: new Date(Date.parse(attempt.createdAt) + index).toISOString(),
	}));
	return { records, graph: { teamId: 'team', revision: 101, digest: records.at(-1)!.graphDigest } };
}
describe('complete managed graph watch assertion', () => {
	it('retains exact full hundred tail and explicit terminal pages without modifying supplied canonical records', async () => {
		const f = input(), before = structuredClone(f), calls: string[] = [];
		expect(completeGraphHistory(f.graph, cursor => { calls.push(cursor); const records = f.records.filter(record => record.revision > Number(cursor)).slice(0, 100);
			return { items: records, nextCursor: records.length ? String(records.at(-1)!.revision) : cursor }; })).toEqual(f.records);
		expect(calls).toEqual(['0', '100', '101']); expect(f).toEqual(before);
		const observe: unknown = Reflect.get(await import('../../../../acceptance/workday/support/monitoring/live-graph-revisions.ts'), 'observeLiveGraphRevisions');
		expect(typeof observe).toBe('function'); if (typeof observe !== 'function') throw new Error('Original live graph inspection is missing');
		const retained = new Map(), snapshots: unknown[] = [];
		const watch = (cursor: string) => { const items = f.records.filter(record => record.revision > Number(cursor)).slice(0, 100);
			return { items, nextCursor: items.length ? String(items.at(-1)!.revision) : cursor }; };
		const current = () => f.graph;
		await Reflect.apply(observe, undefined, ['team', current, watch, retained, (revision: unknown) => snapshots.push(structuredClone(revision))]);
		expect([...retained.values()]).toEqual(f.records); expect(snapshots).toEqual(f.records);
		await Reflect.apply(observe, undefined, ['team', current, watch, retained, () => { throw new Error('Exact replay must not duplicate snapshots'); }]);
		expect([...retained.values()]).toEqual(f.records); expect(f).toEqual(before);
		const original = structuredClone([...retained]);
		for (const mode of ['hidden', 'duplicate', 'foreign', 'changed', 'missing', 'cursor', 'interrupted']) {
			const denied = (cursor: string) => {
				if (mode === 'interrupted') throw new Error('retained live watch interruption');
				const page = structuredClone(watch(cursor)); if (mode === 'hidden') return { items: [], nextCursor: cursor };
				if (mode === 'missing') return {}; if (mode === 'cursor') page.nextCursor = cursor;
				if (page.items[0]) { if (mode === 'duplicate') page.items.push(structuredClone(page.items[0]));
					if (mode === 'foreign') page.items[0].teamId = 'foreign'; if (mode === 'changed') page.items[0].ruleRevision++; }
				return page;
			};
			await expect(Reflect.apply(observe, undefined, ['team', current, denied, retained, () => { throw new Error('Denied history cannot produce a snapshot'); }]), mode).rejects.toThrow();
			expect([...retained]).toEqual(original); expect(f).toEqual(before);
		}
		let published = 1, advanced = false; const moved = new Map(), emitted: unknown[] = [];
		await Reflect.apply(observe, undefined, ['team', () => ({ teamId: 'team', revision: published, digest: f.records[published - 1]!.graphDigest }),
			(cursor: string) => { const items = f.records.slice(Number(cursor), published); const page = { items, nextCursor: items.length ? String(items.at(-1)!.revision) : cursor };
				if (!items.length && !advanced) { published = 2; advanced = true; } return page; }, moved,
			(record: unknown) => emitted.push(structuredClone(record))]);
		expect(emitted).toEqual(f.records.slice(0, 2)); expect([...moved.values()]).toEqual(f.records.slice(0, 2)); expect(f).toEqual(before);
		const empty = new Map();
		await Reflect.apply(observe, undefined, ['team', () => ({ teamId: 'team', revision: 0, digest: '' }), () => ({ items: [], nextCursor: '0' }), empty,
			() => { throw new Error('An initial empty graph cannot fabricate a revision'); }]); expect(empty.size).toBe(0);
		for (const changedHead of [{ ...f.graph, teamId: 'foreign' }, { ...f.graph, revision: 100 }, { ...f.graph, digest: 'sha256:' + 'f'.repeat(64) }]) {
			await expect(Reflect.apply(observe, undefined, ['team', () => changedHead, watch, retained, () => {}])).rejects.toThrow();
			expect([...retained]).toEqual(original);
		}
		await expect(Reflect.apply(observe, undefined, ['team', current, watch, new Map([[0, undefined]]), () => {}])).rejects.toThrow();
		const time = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
		try { await expect(Reflect.apply(observe, undefined, ['team', current, () => { throw new Error('Expired inspection must not read another page'); }, retained, () => {}]))
			.rejects.toThrow('Original inspection bound elapsed'); } finally { time.mockRestore(); }
		expect([...retained]).toEqual(original); expect(f).toEqual(before);



	});
	it('denies skipped duplicated unordered foreign malformed and mismatched-digest revision tails', () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['skip', 'duplicate', 'unordered', 'foreign', 'malformed', 'digest']) {
			const f = input(), records = structuredClone(f.records);
			if (mutation === 'skip') records.splice(50, 1);
			if (mutation === 'duplicate') records[50] = records[49]!;
			if (mutation === 'unordered') [records[49], records[50]] = [records[50]!, records[49]!];
			if (mutation === 'foreign') records[100]!.teamId = 'foreign-team';
			if (mutation === 'malformed') records[100]!.createdAt = 'malformed';
			if (mutation === 'digest') records[100]!.graphDigest = `sha256:${'f'.repeat(64)}`;
			try { completeGraphHistory(f.graph, cursor => ({ items: cursor === '0' ? records.slice(0, 100) : cursor === '100' ? records.slice(100) : [],
				nextCursor: cursor === '0' ? '100' : '101' })); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true, true, true]);
	});
	it('denies hidden last tails wrong nonprogressing cursors absent page fields and interrupted transport', () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['hidden-tail', 'cursor', 'nonprogress', 'missing', 'interrupted']) {
			const f = input();
			try { completeGraphHistory(f.graph, cursor => {
				if (mutation === 'missing') return {};
				if (cursor === '0') return { items: f.records.slice(0, 100), nextCursor: mutation === 'cursor' ? '99' : mutation === 'nonprogress' ? '0' : '100' };
				if (mutation === 'interrupted') throw new Error('isolated transport interruption');
				return { items: [], nextCursor: cursor };
			}); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true, true]);
	});
	it('registers the complete native watch separately from supplied unit pages without executing a campaign', () => {
		expect(state.cases.has('Complete graph watch retains every canonical revision through explicit terminal read and stable independent current graph')).toBe(true);
	});
});
