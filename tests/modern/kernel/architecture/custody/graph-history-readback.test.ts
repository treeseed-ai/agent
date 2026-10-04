import { describe, expect, it } from 'vitest';
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
	it('retains exact full hundred tail and explicit terminal pages without modifying supplied canonical records', () => {
		const f = input(), before = structuredClone(f), calls: string[] = [];
		expect(completeGraphHistory(f.graph, cursor => { calls.push(cursor); const records = f.records.filter(record => record.revision > Number(cursor)).slice(0, 100);
			return { items: records, nextCursor: records.length ? String(records.at(-1)!.revision) : cursor }; })).toEqual(f.records);
		expect(calls).toEqual(['0', '100', '101']); expect(f).toEqual(before);
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
