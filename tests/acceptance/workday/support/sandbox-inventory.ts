import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { row, type Row } from '../../acceptance-cli.ts';
import { verifySandboxHostAbsence } from './record-custody.ts';

/** Consume the fixed, read-only manager/supervisor observation. No runtime is
 * constructed, caller path executed, or unrelated resource removed here. */
export function verifyPublicSandboxAbsence(items: Row[], connections: Array<{ providerId: string; teamId: string }>,
 brokerSocket: string, status: Row): string[] {
 const inventory = row(status.inventory), scope = row(inventory.scope), confirmation = row(inventory.confirmation);
 assert.equal(status.runtime, 'io.containerd.kata.v2', 'ACCEPTANCE_SANDBOX_RUNTIME: Actual owning Kata runtime required');
 assert.equal(status.ready, true, 'ACCEPTANCE_SANDBOX_HOST: Owning host inspection must be ready');
 assert.equal(inventory.complete, true, 'ACCEPTANCE_SANDBOX_INVENTORY: Incomplete observation cannot prove closure');
 assert.deepEqual(inventory.errors, [], 'ACCEPTANCE_SANDBOX_INVENTORY: Failed observations must remain failures');
 assert.ok(isAbsolute(brokerSocket) && resolve(brokerSocket) === brokerSocket);
 assert.equal(scope.brokerSocket, brokerSocket, 'ACCEPTANCE_SANDBOX_HOST: Observation must belong to the configured provider broker');
 assert.ok(typeof scope.containerdAddress === 'string' && scope.containerdAddress.startsWith('/run/')
  && resolve(scope.containerdAddress) === scope.containerdAddress);
 assert.ok(typeof scope.namespace === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(scope.namespace));
 assert.ok(typeof scope.mountNamespace === 'string' && /^mnt:\[\d+\]$/u.test(scope.mountNamespace));
 assert.ok(typeof scope.stateRoot === 'string' && (scope.stateRoot === '/var/lib/treeseed/sandboxes'
  || scope.stateRoot.startsWith('/var/lib/treeseed/sandboxes/')) && resolve(scope.stateRoot) === scope.stateRoot);
 const timestamp = (value: unknown) => {
  assert.ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
   && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
   'ACCEPTANCE_SANDBOX_OBSERVATION_TIME: Original complete observation times required');
  return Date.parse(value);
 };
 const started = timestamp(inventory.startedAt), completed = timestamp(inventory.completedAt);
 assert.ok(completed >= started, 'ACCEPTANCE_SANDBOX_OBSERVATION_TIME: Observation interval is reversed');
 for (const item of items) if (Object.hasOwn(row(item.lifecycleOutput), 'sandboxId'))
  assert.ok(started >= timestamp(row(row(item.lifecycleOutput).teardown).completedAt),
   'ACCEPTANCE_SANDBOX_OBSERVATION_TIME: Inventory predates the recorded teardown');
 const ids = (value: unknown): string[] => {
  assert.equal(typeof value, 'string', 'ACCEPTANCE_SANDBOX_INVENTORY: Missing native list');
  const entries = value === '' ? [] : (value as string).replace(/\n$/u, '').split('\n');
  assert.ok(entries.every(id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id)) && new Set(entries).size === entries.length,
   'ACCEPTANCE_SANDBOX_INVENTORY: Malformed or duplicate native list');
  return entries.sort();
 };
 for (const name of ['tasks', 'containers']) assert.deepEqual(ids(inventory[name]), ids(confirmation[name]),
  'ACCEPTANCE_SANDBOX_INVENTORY: Native inventory changed or confirmation is incomplete');
 assert.equal(typeof inventory.mountInfo, 'string');
 const paths = verifySandboxHostAbsence(items, connections, scope.stateRoot, inventory.tasks as string,
  inventory.containers as string, inventory.mountInfo as string);
 assert.deepEqual(verifySandboxHostAbsence(items, connections, scope.stateRoot, confirmation.tasks as string,
  confirmation.containers as string, inventory.mountInfo as string), paths);
 assert.ok(paths.length > 0 && new Set(paths).size === paths.length, 'ACCEPTANCE_SANDBOX_PATH: Nonempty distinct owning sandboxes required');
 const directory = row(inventory.managedDirectory);
 assert.equal(typeof directory.rootPresent, 'boolean', 'ACCEPTANCE_SANDBOX_DIRECTORY: Unreadable root cannot prove absence');
 assert.ok(Array.isArray(directory.entries), 'ACCEPTANCE_SANDBOX_DIRECTORY: Complete owning directory inventory required');
 const names = directory.entries.map(value => {
  const entry = row(value);
  assert.ok(typeof entry.name === 'string' && entry.name && !['.', '..'].includes(entry.name) && !/[\/\0\r\n]/u.test(entry.name));
  assert.ok(['directory', 'file', 'symlink', 'other'].includes(String(entry.type)));
  return entry.name;
 });
 assert.equal(new Set(names).size, names.length, 'ACCEPTANCE_SANDBOX_DIRECTORY: Duplicate entries cannot prove completeness');
 if (!directory.rootPresent) assert.deepEqual(names, [], 'ACCEPTANCE_SANDBOX_DIRECTORY: Absent root cannot contain entries');
 for (const path of paths) assert.ok(!names.includes(path.slice(scope.stateRoot.length + 1)),
  'ACCEPTANCE_SANDBOX_RESIDUE: Owning sandbox directory, file or symlink remains');
 return paths;
}
