import assert from 'node:assert/strict';
import { completeGraphHistory } from '../evidence-pages.ts';
import type { GraphRevision } from '@treeseed/sdk/agent-capacity';
type Row = Record<string, unknown>;

/** Retain every original revision in the existing campaign output; no event or graph authority is created. */
export async function observeLiveGraphRevisions(teamId: string, current: () => Row | Promise<Row>,
  watch: (cursor: string) => Row | Promise<Row>, retained: Map<number, GraphRevision>, snapshot: (revision: GraphRevision, graph: Row) => void) {
  const label = 'ACCEPTANCE_LIVE_GRAPH', deadline = Date.now() + 120_000;
  const pages = new Map<string, Row>(); let cursor = '0', graph = structuredClone(await current());
  const checkHead = (value: Row) => {
    assert.equal(value.teamId, teamId, label); assert.ok(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, label);
    assert.ok(Number(value.revision) >= Number(cursor), label);
  };
  checkHead(graph);
  for (;;) {
    assert.ok(Date.now() <= deadline, label + ': Original inspection bound elapsed');
    const response = await watch(cursor);
    assert.ok(response && typeof response === 'object' && Array.isArray(response.items) && typeof response.nextCursor === 'string', label);
    pages.set(cursor, structuredClone(response));
    if (response.items.length === 0) {
      assert.equal(response.nextCursor, cursor, label); assert.equal(Number(cursor), graph.revision, label + ': A known native revision is missing');
      const fresh = structuredClone(await current()); checkHead(fresh);
      if (Number(fresh.revision) > Number(cursor)) { graph = fresh; pages.delete(cursor); continue; }
      graph = fresh;
      const records = Number(graph.revision) === 0 ? [] : completeGraphHistory(graph, key => {
        const page = pages.get(key); assert.ok(page, label + ': Original page missing'); return page;
      });
      for (const [revision, original] of retained) {
        assert.ok(Number.isSafeInteger(revision) && revision > 0 && original?.revision === revision && original.teamId === teamId, label);
        assert.deepEqual(records[revision - 1], original, label + ': Original revision changed or disappeared');
      }
      for (const record of records) if (!retained.has(record.revision)) {
        snapshot(structuredClone(record), { teamId: graph.teamId, revision: graph.revision, digest: graph.digest }); retained.set(record.revision, structuredClone(record));
      }
      return;
    }
    assert.ok(/^\d+$/u.test(response.nextCursor) && Number.isSafeInteger(Number(response.nextCursor)) && Number(response.nextCursor) > Number(cursor), label);
    cursor = response.nextCursor;
    if (Number(cursor) > Number(graph.revision)) { graph = structuredClone(await current()); checkHead(graph); }
  }
}
