import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { assignmentNeedsSourceWorkspace } from '@treeseed/agent';
import { row, type Row } from '../../../acceptance-cli.ts';
import { sandboxMountPaths, verifySandboxHostAbsence } from '../record-custody.ts';

function timestamp(value: unknown) {
 assert.ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'ACCEPTANCE_SANDBOX_OBSERVATION_TIME: Original complete observation times required');
 return Date.parse(value);
}

/** Original owning source journals join completed attempts to released leases
 * and absent disks/builders/verifiers. Execution VMs and NBD need their own
 * complete native inventories; these joins never infer their absence. */
function verifyCompletedSourceAbsence(items: Row[], status: Row) {
 const completed = items.filter(item => item.status === 'completed' && Object.hasOwn(row(item.lifecycleOutput), 'sandboxId'));
 const sourced = completed.filter(item => assignmentNeedsSourceWorkspace(assignmentAttemptSchema.safeParse(item.assignmentAttempt)));
 if (!sourced.length) return;
 const workspace = row(status.workspace), scope = row(workspace.scope), inventory = row(status.inventory), confirmation = row(workspace.confirmation);
 assert.equal(workspace.complete, true, 'ACCEPTANCE_SOURCE_INVENTORY: Complete owning source observations required');
 assert.deepEqual(workspace.errors, [], 'ACCEPTANCE_SOURCE_INVENTORY: Original failures cannot certify closure');
 assert.equal(workspace.initialized, true, 'ACCEPTANCE_SOURCE_CATALOG: Original canonical catalog required');
 assert.equal(scope.storageRoot, '/var/lib/treeseed/agent/workspaces', 'ACCEPTANCE_SOURCE_SCOPE: Fixed owning storage required');
 assert.equal(scope.mountNamespace, row(inventory.scope).mountNamespace, 'ACCEPTANCE_SOURCE_SCOPE: Same owning host namespace required');
 assert.equal(confirmation.mountNamespace, scope.mountNamespace, 'ACCEPTANCE_SOURCE_SCOPE: Namespace changed');
 const started = timestamp(workspace.startedAt); assert.ok(timestamp(workspace.completedAt) >= started);
 for (const name of ['leaseDirectoryPresent', 'disks', 'journals']) assert.deepEqual(workspace[name], confirmation[name],
  'ACCEPTANCE_SOURCE_INVENTORY: Original inventory changed or confirmation is incomplete');
 assert.equal(typeof workspace.leaseDirectoryPresent, 'boolean');
 const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value), 'ACCEPTANCE_SOURCE_INVENTORY: Complete original array required'); return value.map(row); };
 const leases = rows(workspace.leases), images = rows(workspace.images), disks = rows(workspace.disks), journals = row(workspace.journals);
 for (const values of [leases, images, disks]) {
  const ids = values.map(value => value.id);
  assert.ok(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'ACCEPTANCE_SOURCE_INVENTORY: Missing or duplicate owning identities');
 }
 for (const lease of leases) {
  assert.ok(['image_id', 'provider_id', 'assignment_id'].every(name => typeof lease[name] === 'string' && lease[name]));
  assert.ok(Number.isSafeInteger(lease.attempt) && Number(lease.attempt) >= 1);
  assert.ok(['analysis', 'work'].includes(String(lease.mode)) && ['active', 'quarantined', 'released'].includes(String(lease.state)));
 }
 for (const disk of disks) {
  assert.ok(typeof disk.id === 'string' && /^workspace-lease-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(disk.id));
  assert.ok(['directory', 'file', 'symlink', 'other'].includes(String(disk.type)));
  assert.ok(disk.bytes === null || (Number.isSafeInteger(disk.bytes) && Number(disk.bytes) >= 0));
  if (disk.device !== null) { const device = row(disk.device); assert.equal(device.id, disk.id); assert.ok(typeof device.device === 'string' && /^\/dev\/nbd\d+$/u.test(device.device)); }
 }
 if (!workspace.leaseDirectoryPresent) assert.deepEqual(disks, []);
 const entries = (kind: string) => {
  const directory = row(journals[kind]); assert.equal(typeof directory.rootPresent, 'boolean');
  const values = rows(directory.entries), names = values.map(value => value.name);
  assert.equal(new Set(names).size, names.length, 'ACCEPTANCE_SOURCE_JOURNAL: Duplicate original journal identity');
  if (!directory.rootPresent) assert.deepEqual(values, []);
  for (const value of values) {
   assert.ok(typeof value.name === 'string' && /^sandbox-[a-zA-Z0-9-]{1,128}\.json$/u.test(value.name));
   assert.equal(value.type, 'file'); assert.ok(typeof value.digest === 'string' && /^[a-f0-9]{64}$/u.test(value.digest));
   assert.ok(Object.keys(row(value.metadata)).length, 'ACCEPTANCE_SOURCE_JOURNAL: Missing original metadata');
  }
  return values;
 };
 const jobs = entries('jobs'), candidates = entries('candidates'), results = entries('results');
 const taskIds = String(inventory.tasks).split('\n'), containerIds = String(inventory.containers).split('\n'), mounts = sandboxMountPaths(String(inventory.mountInfo));
 const absentVm = (id: unknown) => {
  assert.ok(typeof id === 'string' && /^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id));
  for (const name of [id, `${id}-ready`]) assert.ok(!taskIds.includes(name) && !containerIds.includes(name), 'ACCEPTANCE_SOURCE_RESIDUE: Owning builder/verifier remains');
 };
 for (const item of sourced) {
  const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), output = row(item.lifecycleOutput), name = `${String(output.sandboxId)}.json`;
  assert.ok(started >= timestamp(row(output.teardown).completedAt), 'ACCEPTANCE_SOURCE_OBSERVATION_TIME: Source inspection predates teardown');
  const ownJobs = jobs.filter(value => value.name === name); assert.equal(ownJobs.length, 1, 'ACCEPTANCE_SOURCE_JOB: Original owning source job missing');
  const job = row(ownJobs[0]!.metadata), owner = row(job.owner);
  assert.equal(job.schemaVersion, 'treeseed.assignment-source-job/v1'); assert.equal(job.state, 'stopped');
  assert.deepEqual(owner, { assignmentId: attempt.id, providerId: attempt.provider.providerId,
   teamId: attempt.teamId, projectId: attempt.projectId, attempt: attempt.attempt }, 'ACCEPTANCE_SOURCE_OWNER: Original exact assignment/provider custody required');
  const owned = leases.filter(lease => lease.assignment_id === attempt.id);
  assert.ok(owned.every(lease => lease.provider_id === attempt.provider.providerId && lease.state === 'released'),
   'ACCEPTANCE_SOURCE_LEASE: Foreign or live owning lease remains');
  const current = owned.filter(lease => lease.attempt === attempt.attempt);
  assert.equal(current.length, 1, 'ACCEPTANCE_SOURCE_LEASE: Exact original lease missing or duplicated');
  const lease = current[0]!; assert.equal(lease.id, job.leaseId); assert.equal(lease.result_artifact_id, name);
  assert.ok(['analysis', 'work'].includes(String(lease.mode)));
  const disk = row(job.disk); assert.ok(typeof disk.id === 'string' && /^workspace-lease-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(disk.id));
  const path: string = `${String(scope.storageRoot)}/leases/${disk.id}`;
  assert.equal(disk.directory, path); assert.equal(disk.image, `${path}/work.qcow2`);
  assert.ok(typeof disk.device === 'string' && /^\/dev\/nbd\d+$/u.test(disk.device)); assert.equal(disk.unit, `treeseed-${disk.id}.service`);
  assert.ok(!disks.some(value => value.id === disk.id), 'ACCEPTANCE_SOURCE_RESIDUE: Owning disk directory/file/symlink remains');
  assert.ok(!mounts.some(mount => mount === path || mount.startsWith(`${path}/`)), 'ACCEPTANCE_SOURCE_RESIDUE: Owning source mount remains');
  if (job.builderIds !== undefined) {
   const ids = job.builderIds; assert.ok(Array.isArray(ids) && new Set(ids).size === ids.length); for (const id of ids) absentVm(id);
  }
  const ownResults = results.filter(value => value.name === name); assert.equal(ownResults.length, 1, 'ACCEPTANCE_SOURCE_RESULT: Original durable result missing');
  const result = row(ownResults[0]!.metadata);
  assert.equal(result.schemaVersion, 'treeseed.source-result/v1'); assert.equal(result.sandboxId, output.sandboxId);
  assert.equal(result.leaseId, lease.id); assert.equal(result.status, 'completed'); assert.equal(result.teardownVerified, true);
  assert.ok(timestamp(result.completedAt) <= timestamp(row(output.teardown).completedAt), 'ACCEPTANCE_SOURCE_RESULT: Durable result follows claimed teardown');
  const ownCandidates = candidates.filter(value => value.name === name);
  if (lease.mode === 'work') {
   assert.equal(ownCandidates.length, 1, 'ACCEPTANCE_SOURCE_CANDIDATE: Owning work publication missing');
   const candidate = row(ownCandidates[0]!.metadata); assert.equal(candidate.state, 'published');
   assert.equal(candidate.assignmentId, attempt.id); assert.equal(candidate.providerId, attempt.provider.providerId); assert.equal(candidate.attempt, attempt.attempt);
   assert.equal(candidate.verifierStopped, true); absentVm(candidate.verifierId);
  } else assert.deepEqual(ownCandidates, [], 'ACCEPTANCE_SOURCE_CANDIDATE: Analysis scope cannot publish work');
 }
}

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
 verifyCompletedSourceAbsence(items, status);
 return paths;
}
