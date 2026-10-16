import { createServer } from 'node:http';
import { expect } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { row } from '../../../../acceptance/acceptance-cli.ts';
import { collectCompleteEvidence } from '../../../../acceptance/workday/support/evidence-pages.ts';
import * as observations from '../../../../acceptance/workday/support/campaign-observation.ts';
import { accountingHistoryFixture, type Row } from './accounting-history-fixture.ts';

/** Extend the original native SDK history case. HTTP rows/token are controlled
 * inputs; native PostgreSQL producer proof belongs to API553/554. */
export async function proveNativeAccountingHistoryTransport() {
 const f = accountingHistoryFixture(), held = structuredClone(f), history: Array<{ method: string; path: string; body: string }> = [], failures: Row[] = [];
 const source = { events: f.events, usage: [...f.usage].reverse(), ledger: f.ledger };
 let mode = 'exact';
 const server = createServer((request, response) => {
  let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); }); request.on('end', () => {
   history.push({ method: request.method ?? '', path: request.url ?? '', body }); response.setHeader('content-type', 'application/json');
   const url = new URL(request.url ?? '', 'http://127.0.0.1'), kind = url.pathname === `/v1/teams/${f.run.teamId}/workday-runs/${f.run.id}/events` ? 'events'
    : url.pathname === `/v1/teams/${f.run.teamId}/capacity/usage` ? 'usage' : url.pathname === `/v1/teams/${f.run.teamId}/capacity/ledger` ? 'ledger' : undefined;
   if (!kind || request.method !== 'GET' || body || url.searchParams.get('limit') !== '1'
    || kind !== 'events' && (url.searchParams.get('projectId') !== f.items[0]!.projectId || url.searchParams.get('workDayId') !== f.run.id)) { response.writeHead(400).end('{}'); return; }
   const original = source[kind], cursor = url.searchParams.get('cursor'), position = cursor === null ? 0 : original.findIndex(value => encodeCapacityPageCursor(value) === cursor) + 1;
   if (cursor !== null && position === 0) { response.writeHead(400).end('{}'); return; }
   if (mode === '403' && kind === 'events' && position === 1 || mode === '503' && kind === 'ledger') { response.writeHead(mode === '403' ? 403 : 503).end(JSON.stringify({ status: Number(mode), code: 'controlled_accounting_read_denied', title: 'Retained native denial' })); return; }
   if (mode === 'json' && kind === 'usage') { response.end('{'); return; }
   const items: Row[] = structuredClone(original.slice(position, position + 1));
   if (kind === 'events' && items.length) {
    if (mode === 'foreign' && position === 1) items[0]!.assignmentId = 'foreign';
    if (mode === 'duplicate' && position === 2) items[0] = structuredClone(f.events[0]!);
    if (mode === 'changed-usage' && position === 1) items[0]!.context.usageActual.activeSeconds = 9;
    if (mode === 'changed-supply' && position === 1) items[0]!.context.remainingSupply[0].remainingAmount = 99;
    if (mode === 'truncated' && position === 2) items.length = 0;
   }
   const omitted = kind === 'usage' && mode === 'omitted-usage' || kind === 'ledger' && mode === 'omitted-ledger';
   if (omitted) items.length = 0;
   const hasMore = !omitted && position < original.length - 1;
   response.end(JSON.stringify({ data: { items, page: { limit: 1, hasMore, nextCursor: hasMore ? encodeCapacityPageCursor(original[position]!) : null } } }));
  });
 });
 try {
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Allocated original native accounting server required');
  const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-accounting-input' });
  const readPages = async (kind: keyof typeof source) => {
   const pages = new Map<string | undefined, Row>();
   // Known controlled page boundaries drive real original SDK requests. The
   // existing collector, not a replacement pagination algorithm, validates them.
   for (const cursor of [undefined, ...source[kind].slice(0, -1).map(value => encodeCapacityPageCursor(value))]) {
    const query = { limit: 1, ...(cursor ? { cursor } : {}) }, scope = { projectId: f.items[0]!.projectId, workDayId: f.run.id };
    const value = kind === 'events' ? await client.invoke(controlPlaneOperation('workdays.events.list'), { path: { teamId: f.run.teamId, runId: f.run.id }, query, body: undefined })
     : kind === 'usage' ? await client.invoke(controlPlaneOperation('capacity.usage'), { path: { teamId: f.run.teamId }, query: { ...query, ...scope }, body: undefined })
     : await client.invoke(controlPlaneOperation('capacity.ledger'), { path: { teamId: f.run.teamId }, query: { ...query, ...scope }, body: undefined });
    pages.set(cursor, row(value.data));
   }
   return collectCompleteEvidence(cursor => { const page = pages.get(cursor); if (!page) throw new Error('Original native page missing'); return page; }, 1, 'ACCEPTANCE_NATIVE_ACCOUNTING', kind === 'events' ? 'ascending' : 'descending');
  };
  const execute = async () => {
   const captured: Row = { mode }; let error = '';
   try {
    const [events, usage, ledger] = await Promise.all([readPages('events'), readPages('usage'), readPages('ledger')]); Object.assign(captured, { events, usage, ledger });
    const verify = Reflect.get(observations, 'verifyAccountingTransitionHistory') as ((run: Row, items: Row[], usage: Row[], ledger: Row[], events: Row[]) => void) | undefined;
    expect(verify).toBeTypeOf('function'); if (!verify) throw new Error('Original accounting observer required');
    verify(f.run, f.items, usage, ledger, events);
   } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
   failures.push({ ...captured, error }); expect(f).toEqual(held); return error;
  };
  expect(await execute(), JSON.stringify(failures)).toBe('');
  for (const fault of ['foreign', 'duplicate', 'changed-usage', 'changed-supply', 'truncated', 'omitted-usage', 'omitted-ledger', '403', '503', 'json']) { mode = fault; expect(await execute(), fault).not.toBe(''); }
  const retained = structuredClone(failures), requests = structuredClone(history); mode = 'exact'; expect(await execute(), JSON.stringify(failures)).toBe('');
  expect(failures.slice(0, retained.length)).toEqual(retained); expect(history.slice(0, requests.length)).toEqual(requests); expect(history.every(value => value.method === 'GET' && value.body === '')).toBe(true);
 } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
 expect(server.listening).toBe(false); expect(f).toEqual(held);
}
