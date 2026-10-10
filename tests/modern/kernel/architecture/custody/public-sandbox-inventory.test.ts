import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../provider-kernel-fixture.ts';
import { row, type Row } from '../../../../acceptance/acceptance-cli.ts';
import { verifyPublicSandboxAbsence } from '../../../../acceptance/workday/support/physical/sandbox-inventory.ts';

function supplied() {
 const original = request().assignment.assignmentAttempt;
 if (!original) throw new Error('Original complete attempt required');
 const attempt = assignmentAttemptSchema.parse({ ...original, status: 'failed' });
 const id = 'sandbox-owned-attempt-1-abcdef12';
 const items: Row[] = [{ id: attempt.id, status: 'failed', assignmentAttempt: attempt, failedAt: '2026-09-13T12:00:02.000Z',
  capacityEnvelope: { budget: { time: { executionStartedAt: '2026-09-13T12:00:00.000Z' } } },
  lifecycleOutput: { sandboxId: id, teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } } }];
 const brokerSocket = '/run/treeseed/sandbox/broker.sock';
 const status: Row = { ready: true, runtime: 'io.containerd.kata.v2', inventory: {
  startedAt: '2026-09-13T12:00:03.000Z', completedAt: '2026-09-13T12:00:04.000Z', complete: true, errors: [],
  scope: { brokerSocket, containerdAddress: '/run/containerd/containerd.sock', namespace: 'configured-owner',
   stateRoot: '/var/lib/treeseed/sandboxes', mountNamespace: 'mnt:[1234]' },
  tasks: 'unrelated-live-task\n', containers: 'unrelated-live-container\n',
  confirmation: { tasks: 'unrelated-live-task\n', containers: 'unrelated-live-container\n' },
  mountInfo: '1 0 0:1 / / rw - rootfs rootfs rw\n',
  managedDirectory: { rootPresent: true, entries: [{ name: 'unrelated-live-directory', type: 'directory' }] },
 } };
 return { items, connections: [{ providerId: attempt.provider.providerId, teamId: attempt.teamId }], brokerSocket, status, id };
}
const verify = (f: ReturnType<typeof supplied>) => verifyPublicSandboxAbsence(f.items, f.connections, f.brokerSocket, f.status);
describe('public owning sandbox inventory consumption', () => {
 it('accepts exact complete confirmed absence while retaining unrelated live resources and original observations', () => {
  const f = supplied(), before = structuredClone(f);
  expect(verify(f)).toEqual([`/var/lib/treeseed/sandboxes/${f.id}`]); expect(f).toEqual(before);
  const inventory = row(f.status.inventory);
  inventory.tasks = ''; inventory.containers = ''; inventory.confirmation = { tasks: '', containers: '' };
  inventory.managedDirectory = { rootPresent: false, entries: [] };
  const empty = structuredClone(f); expect(verify(f)).toHaveLength(1); expect(f).toEqual(empty);
  const item = f.items[0]!, attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
  item.status = 'completed'; item.assignmentAttempt = assignmentAttemptSchema.parse({ ...attempt, status: 'completed' });
  delete item.failedAt; item.completedAt = '2026-09-13T12:00:02.000Z';
  item.assignmentResult = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'supplied-result',
   assignmentId: attempt.id, status: 'completed', summary: 'Supplied unit input, not a managed result.', references: [], verification: [],
   usage: { elapsedSeconds: 1, native: { activeSeconds: 1 } }, diagnostics: [], completedAt: item.completedAt });
  const completed = structuredClone(f); expect(verify(f)).toHaveLength(1); expect(f).toEqual(completed);
 });
 it('denies missing incomplete failed foreign malformed and stale observations without repairing failed history', () => {
  const changes: Array<(f: ReturnType<typeof supplied>) => void> = [
   f => { delete f.status.inventory; }, f => { f.status.runtime = 'foreign'; }, f => { f.status.ready = false; },
   f => { row(f.status.inventory).complete = false; }, f => { row(f.status.inventory).errors = ['interrupted']; },
   f => { delete row(f.status.inventory).errors; }, f => { row(row(f.status.inventory).scope).brokerSocket = '/run/foreign.sock'; },
   f => { row(row(f.status.inventory).scope).containerdAddress = '/run/../foreign'; },
   f => { row(row(f.status.inventory).scope).namespace = 'caller command'; },
   f => { row(row(f.status.inventory).scope).stateRoot = '/var/lib/foreign'; },
   f => { row(row(f.status.inventory).scope).mountNamespace = null; },
   f => { row(f.status.inventory).startedAt = '2026-09-13T12:00:00.000Z'; },
   f => { row(f.status.inventory).completedAt = '2026-09-13T12:00:02.000Z'; },
   f => { row(f.status.inventory).startedAt = '2026-09-31T12:00:03.000Z'; row(f.status.inventory).completedAt = '2026-10-01T12:00:04.000Z'; },
   f => { row(f.status.inventory).startedAt = ''; }, f => { row(f.status.inventory).completedAt = 'invalid'; },
   f => { f.connections[0]!.providerId = 'foreign'; }, f => { f.connections[0]!.teamId = 'foreign'; },
   f => { f.connections.length = 0; }, f => { f.items.length = 0; },
   f => { f.items.push(structuredClone(f.items[0]!)); },
   f => { row(row(f.items[0]!.lifecycleOutput).teardown).verified = false; },
  ];
  for (const change of changes) { const f = supplied(); change(f); const before = structuredClone(f); expect(() => verify(f)).toThrow(); expect(f).toEqual(before); }
 });
 it('denies missing malformed duplicated changed and residual native task container and mount inventories', () => {
  for (const name of ['tasks', 'containers']) for (const value of [null, 0, 'duplicate\nduplicate\n', 'unexpected whitespace\n', '\n', `${supplied().id}\n`]) {
   const f = supplied(), inventory = row(f.status.inventory);
   inventory[name] = value; row(inventory.confirmation)[name] = value;
   const before = structuredClone(f); expect(() => verify(f)).toThrow(); expect(f).toEqual(before);
  }
  for (const name of ['tasks', 'containers']) {
   const f = supplied(); row(row(f.status.inventory).confirmation)[name] = '';
   const before = structuredClone(f); expect(() => verify(f)).toThrow(); expect(f).toEqual(before);
  }
  for (const mountInfo of ['', null, 'permission denied', `1 0 0:1 / /var/lib/treeseed/sandboxes/${supplied().id}/input rw - tmpfs tmpfs rw\n`]) {
   const f = supplied(); row(f.status.inventory).mountInfo = mountInfo;
   const before = structuredClone(f); expect(() => verify(f)).toThrow(); expect(f).toEqual(before);
  }
 });
 it('denies unreadable incomplete duplicate malformed and residual directory entries of every native kind', () => {
  const directories: unknown[] = [null, {}, { rootPresent: null, entries: [] }, { rootPresent: true, entries: null },
   { rootPresent: false, entries: [{ name: 'retained', type: 'directory' }] }];
  for (const type of ['directory', 'file', 'symlink', 'other']) directories.push({ rootPresent: true, entries: [{ name: supplied().id, type }] });
  for (const name of ['', '.', '..', '../foreign', 'line\nbreak']) directories.push({ rootPresent: true, entries: [{ name, type: 'directory' }] });
  directories.push({ rootPresent: true, entries: [{ name: 'unknown', type: 'unreadable' }] },
   { rootPresent: true, entries: [{ name: 'duplicate', type: 'directory' }, { name: 'duplicate', type: 'file' }] });
  for (const directory of directories) {
   const f = supplied(); row(f.status.inventory).managedDirectory = directory;
   const before = structuredClone(f); expect(() => verify(f)).toThrow(); expect(f).toEqual(before);
  }
 });
});
