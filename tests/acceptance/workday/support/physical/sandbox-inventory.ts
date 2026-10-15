import assert from 'node:assert/strict';
import { basename, isAbsolute, resolve } from 'node:path';
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

/** Exact confirmed native observations, never a caller-supplied path or command. */
function nativeHostDevices(inventory:Row) {
 const scope=row(inventory.scope),confirmation=row(inventory.confirmation),label='ACCEPTANCE_NATIVE_DEVICES';
 assert.equal(scope.procRoot,'/proc/1/root/proc',label);assert.ok(typeof scope.pidNamespace==='string'&&/^pid:\[\d+\]$/u.test(scope.pidNamespace),label);
 for(const key of ['vmProcesses','nbdDevices']){assert.ok(Array.isArray(inventory[key]),label+': Complete owning arrays required');assert.deepEqual(inventory[key],confirmation[key],label+': Native observation changed');}
 const vms=(inventory.vmProcesses as unknown[]).map(row),devices=(inventory.nbdDevices as unknown[]).map(row),pids=new Set<number>(),names=new Set<string>(),blocks=new Set<string>(),images=new Set<string>();
 const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;
 for(const vm of vms){
  assert.equal(vm.failure,null,label);assert.ok(positive(vm.processId)&&!pids.has(Number(vm.processId)),label);pids.add(Number(vm.processId));
  assert.ok(typeof vm.startTicks==='string'&&/^[1-9][0-9]*$/u.test(vm.startTicks),label);
  assert.ok(typeof vm.executable==='string'&&isAbsolute(vm.executable),label);const executable=basename(vm.executable.replace(/ \(deleted\)$/u,''));
  assert.ok(/^qemu-system-[a-zA-Z0-9_]+$/u.test(executable)||executable==='qemu-kvm',label);
  assert.ok(typeof vm.name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/u.test(vm.name)&&!names.has(vm.name),label);names.add(vm.name);
 }
 for(const device of devices){
  assert.equal(device.failure,null,label);assert.ok(typeof device.device==='string'&&/^\/dev\/nbd[0-9]+$/u.test(device.device)&&!blocks.has(device.device),label);blocks.add(device.device);
  if(device.threadId===null){assert.equal(device.processId,null,label);assert.equal(device.executable,null,label);assert.equal(device.image,null,label);continue;}
  assert.ok(positive(device.threadId)&&positive(device.processId),label);
  assert.ok(typeof device.executable==='string'&&isAbsolute(device.executable)&&basename(device.executable.replace(/ \(deleted\)$/u,''))==='qemu-nbd',label+': Attached image must be independently observable');
  assert.ok(typeof device.image==='string'&&isAbsolute(device.image)&&resolve(device.image)===device.image,label);images.add(device.image);
 }
 return{names,images};
}

/** Original owning source journals join completed attempts to released leases
 * and absent disks/builders/verifiers. Execution VMs and NBD need their own
 * complete native inventories; these joins never infer their absence. */
function verifyCompletedSourceAbsence(items: Row[], status: Row,vmNames:Set<string>,nbdImages:Set<string>) {
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
  assert.ok(!vmNames.has(`sandbox-${id}`),'ACCEPTANCE_SOURCE_RESIDUE: Owning builder/verifier VM remains');
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
  assert.ok(!nbdImages.has(String(disk.image)),'ACCEPTANCE_SOURCE_RESIDUE: Owning disk remains attached on a native NBD device');
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
 brokerSocket: string, status: Row,events:readonly Row[]): string[] {
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
 const devices=nativeHostDevices(inventory),ownedVms=new Set<string>();assert.ok(Array.isArray(events),'ACCEPTANCE_SANDBOX_VM: Complete public event history required');
 for(const item of items.filter(value=>Object.hasOwn(row(value.lifecycleOutput),'sandboxId'))){
  const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt),output=row(item.lifecycleOutput);
  const matches:readonly Row[]=events.filter((observation:Row)=>observation.eventType==='provider.sandbox.destroyed'&&observation.assignmentId===attempt.id);
  assert.equal(matches.length,1,'ACCEPTANCE_SANDBOX_VM: Exact original public destruction observation required');const event=matches[0]!,context=row(event.context),vmId=context.vmId;
  assert.equal(event.runId,attempt.workdayId);assert.equal(event.workdayId,attempt.workdayId);assert.equal(event.teamId,attempt.teamId);assert.equal(event.projectId,attempt.projectId);assert.equal(event.status,'recorded');
  assert.equal(context.sandboxId,output.sandboxId);assert.deepEqual(context.teardown,output.teardown);
  assert.ok(timestamp(event.createdAt)>=timestamp(row(output.teardown).completedAt)&&timestamp(event.createdAt)<=started,'ACCEPTANCE_SANDBOX_VM: Native observation predates public destruction');
  assert.ok(typeof vmId==='string'&&/^sandbox-warm-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(vmId)&&!ownedVms.has(vmId),'ACCEPTANCE_SANDBOX_VM: Missing malformed or reused acquired identity');ownedVms.add(vmId);
  assert.ok(!devices.names.has('sandbox-'+vmId),'ACCEPTANCE_SANDBOX_VM: Exact owning execution VM remains');
 }
 verifyCompletedSourceAbsence(items, status,devices.names,devices.images);
 return paths;
}

/** Existing public records identify the exact retired sessions, grants and mutable TreeDX workspaces. */
export async function verifyPublicWorkspaceSessionClosure(items:Row[],sessions:Row[],readWorkspace:(projectId:string,workspaceId:string)=>Row|Promise<Row>):Promise<void>{
 const code='ACCEPTANCE_RESOURCE_CLOSURE',ids=new Set<string>(),workspaces=new Set<string>();assert.ok(items.length>0,code);
 assert.equal(new Set(items.map(item=>item.id)).size,items.length,code);
 for(const session of sessions){assert.ok(typeof session.id==='string'&&session.id&&!ids.has(session.id),code);ids.add(session.id);assert.ok(['open','draining','closed','expired'].includes(String(session.status)),code);}
 for(const item of items){
  const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt);assert.deepEqual(attempt,item.assignmentAttempt,code);
  assert.equal(item.teamId,items[0]!.teamId,code);assert.equal(item.workDayId,items[0]!.workDayId,code);
  assert.equal(item.id,attempt.id,code);assert.equal(item.teamId,attempt.teamId,code);assert.equal(item.projectId,attempt.projectId,code);assert.equal(item.workDayId,attempt.workdayId,code);
  assert.ok(['completed','failed','cancelled','returned','expired'].includes(String(item.status)),code);timestamp(item.completedAt??item.failedAt??item.returnedAt);const updated=timestamp(item.updatedAt);
  assert.ok(typeof item.providerSessionId==='string'&&item.providerSessionId&&typeof item.membershipId==='string'&&item.membershipId,code);
  const found=sessions.filter(value=>value.id===item.providerSessionId);assert.equal(found.length,1,code);const session=found[0]!;
  assert.equal(session.teamId,attempt.teamId,code);assert.equal(session.providerId,attempt.provider.providerId,code);assert.equal(session.membershipId,item.membershipId,code);
  assert.equal(session.status,'closed',code);assert.ok(timestamp(session.closedAt)>=timestamp(session.openedAt),code);
  const proxy=row(item.treedxProxyHandle),context=row(item.workspaceContext),handles=row(item.capabilityHandles);
  assert.equal(proxy.teamId,attempt.teamId,code);assert.equal(proxy.projectId,attempt.projectId,code);assert.equal(proxy.assignmentId,attempt.id,code);
  assert.ok(typeof proxy.id==='string'&&proxy.id,code);assert.equal(proxy.status,'revoked',code);assert.ok(timestamp(proxy.revokedAt)<=updated&&timestamp(proxy.revokedAt)>=timestamp(attempt.createdAt),code);
  assert.deepEqual(context.treedxProxyHandle,proxy,code);assert.deepEqual(context.capabilityHandles,handles,code);
  for(const kind of['repository','treeDx','workflowOperations','secrets']){const entries=handles[kind];assert.ok(Array.isArray(entries),code);for(const value of entries){const handle=row(value);assert.equal(handle.status,'revoked',code);assert.ok(timestamp(handle.revokedAt)<=updated&&timestamp(handle.revokedAt)>=timestamp(attempt.createdAt),code);}}
  if(attempt.workspace.mode!=='treedx'){assert.equal(proxy.workspaceId,null,code);continue;}
  assert.equal(proxy.workspaceId,attempt.workspace.workspaceId,code);assert.equal(proxy.repositoryId,attempt.workspace.repository,code);
  assert.ok(typeof proxy.repositoryProjectId==='string'&&proxy.repositoryProjectId&&typeof proxy.branchName==='string'&&proxy.branchName,code);
  assert.ok(!workspaces.has(attempt.workspace.workspaceId),code);workspaces.add(attempt.workspace.workspaceId);
  const response=await readWorkspace(proxy.repositoryProjectId,attempt.workspace.workspaceId),resource=row(response.result),receipt=row(response.receipt);
  assert.equal(receipt.projectId,proxy.repositoryProjectId,code);assert.equal(resource.workspaceId,attempt.workspace.workspaceId,code);assert.equal(resource.repoId,attempt.workspace.repository,code);
  assert.equal(resource.status,'closed',code);assert.equal(resource.mode,'writable',code);assert.equal(resource.baseCommitSha,attempt.workspace.baseCommit,code);assert.equal(resource.branchName,proxy.branchName,code);
  assert.ok(Array.isArray(resource.allowedPaths)&&Array.isArray(proxy.allowedPaths),code);
  assert.ok(resource.allowedPaths.every(value=>typeof value==='string'&&value)&&new Set(resource.allowedPaths).size===resource.allowedPaths.length,code);
  assert.deepEqual([...resource.allowedPaths].sort(),[...proxy.allowedPaths].sort(),code);
 }
}
