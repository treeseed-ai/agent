import { publicResourceClosureFixture } from '../../../guarantees/preflight/physical/resource-closure-fixture.ts';
import * as physicalResources from '../../../../acceptance/workday/support/physical/sandbox-inventory.ts';
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
 const storageRoot = '/var/lib/treeseed/agent/workspaces', diskId = 'workspace-lease-11111111-1111-4111-8111-111111111111';
 const disk = { id: diskId, directory: `${storageRoot}/leases/${diskId}`, image: `${storageRoot}/leases/${diskId}/work.qcow2`,
  device: '/dev/nbd99', unit: `treeseed-${diskId}.service` };
 const metadata = (name: string, value: Row) => ({ name, type: 'file', digest: 'a'.repeat(64), metadata: value });
 const journals = { jobs: { rootPresent: true, entries: [metadata(`${id}.json`, {
  schemaVersion: 'treeseed.assignment-source-job/v1', state: 'stopped', owner: { assignmentId: attempt.id,
   providerId: attempt.provider.providerId, teamId: attempt.teamId, projectId: attempt.projectId, attempt: attempt.attempt },
  leaseId: 'lease-owned', disk, builderIds: ['sandbox-warm-22222222-2222-4222-8222-222222222222'],
 })] }, candidates: { rootPresent: true, entries: [metadata(`${id}.json`, { state: 'published', assignmentId: attempt.id,
  attempt: attempt.attempt, providerId: attempt.provider.providerId, verifierId: 'sandbox-warm-33333333-3333-4333-8333-333333333333', verifierStopped: true })] },
  results: { rootPresent: true, entries: [metadata(`${id}.json`, { schemaVersion: 'treeseed.source-result/v1', sandboxId: id,
   leaseId: 'lease-owned', status: 'completed', teardownVerified: true, completedAt: '2026-09-13T12:00:01.000Z' })] } };
 const observed = { leaseDirectoryPresent: true, disks: [{ id: 'workspace-lease-44444444-4444-4444-8444-444444444444', type: 'directory', bytes: 4096, device: null }], journals };
 status.workspace = { startedAt: '2026-09-13T12:00:03.000Z', completedAt: '2026-09-13T12:00:04.000Z',
  complete: true, errors: [], scope: { storageRoot, mountNamespace: 'mnt:[1234]' }, initialized: true, images: [],
  leases: [{ id: 'lease-owned', image_id: 'image-owned', provider_id: attempt.provider.providerId,
   assignment_id: attempt.id, attempt: attempt.attempt, mode: 'work', state: 'released', result_artifact_id: `${id}.json` },
   { id: 'lease-unrelated', image_id: 'image-other', provider_id: 'provider-unrelated', assignment_id: 'assignment-unrelated',
    attempt: 1, mode: 'work', state: 'active', result_artifact_id: null }],
  ...observed, confirmation: { ...structuredClone(observed), mountNamespace: 'mnt:[1234]' } };
 const vmId='sandbox-warm-44444444-4444-4444-8444-444444444444',inventory=row(status.inventory);
 const vmProcesses=[{processId:123,startTicks:'12345',executable:'/opt/treeseed/kata/4.1.0/bin/qemu-system-x86_64',name:'sandbox-sandbox-warm-55555555-5555-4555-8555-555555555555',failure:null}];
 // The exact former device is lawfully reused by an unrelated image.
 const nbdDevices=[{device:'/dev/nbd99',threadId:124,processId:125,executable:'/usr/bin/qemu-nbd',image:storageRoot+'/leases/workspace-lease-44444444-4444-4444-8444-444444444444/work.qcow2',failure:null}];
 Object.assign(row(inventory.scope),{procRoot:'/proc/1/root/proc',pidNamespace:'pid:[1234]'});Object.assign(inventory,{vmProcesses,nbdDevices});Object.assign(row(inventory.confirmation),{vmProcesses:structuredClone(vmProcesses),nbdDevices:structuredClone(nbdDevices)});
 const events:Row[]=[{id:'event-destroyed',runId:attempt.workdayId,workdayId:attempt.workdayId,teamId:attempt.teamId,projectId:attempt.projectId,assignmentId:attempt.id,eventIndex:0,eventType:'provider.sandbox.destroyed',status:'recorded',createdAt:'2026-09-13T12:00:01.000Z',context:{sandboxId:id,teardown:structuredClone(row(items[0]!.lifecycleOutput).teardown),vmId},parameters:{},refs:{},metadata:{}}];
 return { items, connections: [{ providerId: attempt.provider.providerId, teamId: attempt.teamId }], brokerSocket, status, id,events,vmId };
}
const verify = (f: ReturnType<typeof supplied>) => verifyPublicSandboxAbsence(f.items, f.connections, f.brokerSocket, f.status,f.events);
describe('public owning sandbox inventory consumption', () => {
 it('accepts exact complete confirmed absence while retaining unrelated live resources and original observations', () => {
  const f = supplied(), before = structuredClone(f);
  expect(verify(f)).toEqual([`/var/lib/treeseed/sandboxes/${f.id}`]); expect(f).toEqual(before);
  const inventory = row(f.status.inventory);
  inventory.tasks = ''; inventory.containers = ''; inventory.confirmation = { ...row(inventory.confirmation),tasks: '', containers: '' };
  inventory.managedDirectory = { rootPresent: false, entries: [] };
  const empty = structuredClone(f); expect(verify(f)).toHaveLength(1); expect(f).toEqual(empty);
  const item = f.items[0]!, attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
  item.status = 'completed'; item.assignmentAttempt = assignmentAttemptSchema.parse({ ...attempt, status: 'completed' });
  delete item.failedAt; item.completedAt = '2026-09-13T12:00:02.000Z';
  item.assignmentResult = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'supplied-result',
   assignmentId: attempt.id, status: 'completed', summary: 'Supplied unit input, not a managed result.', references: [], verification: [],
   usage: { elapsedSeconds: 1, native: { activeSeconds: 1 } }, diagnostics: [], completedAt: item.completedAt });
  const completed = structuredClone(f); expect(verify(f)).toHaveLength(1); expect(f).toEqual(completed);
  const vacant=structuredClone(f),vacantInventory=row(vacant.status.inventory);for(const key of ['vmProcesses','nbdDevices']){vacantInventory[key]=[];row(vacantInventory.confirmation)[key]=[];}expect(verify(vacant)).toHaveLength(1);
  const detached=structuredClone(f),detachedInventory=row(detached.status.inventory),devices=detachedInventory.nbdDevices as Row[];devices.push({device:'/dev/nbd0',threadId:null,processId:null,executable:null,image:null,failure:null});row(detachedInventory.confirmation).nbdDevices=structuredClone(devices);expect(verify(detached)).toHaveLength(1);
  const changes: Array<(f: ReturnType<typeof supplied>) => void> = [
   f => { delete f.status.workspace; }, f => { row(f.status.workspace).complete = false; },
   f => { row(f.status.workspace).errors = ['interrupted']; }, f => { row(f.status.workspace).initialized = false; },
   f => { row(f.status.workspace).leases = null; }, f => { row(f.status.workspace).images = null; },
   f => { row(row(f.status.workspace).scope).storageRoot = '/caller/path'; },
   f => { row(row(f.status.workspace).scope).mountNamespace = 'mnt:[5678]'; },
   f => { row(f.status.workspace).startedAt = '2026-09-13T12:00:00.000Z'; },
   f => { row(f.status.workspace).completedAt = '2026-09-13T12:00:02.000Z'; },
   f => { row(f.status.workspace).journals = null; }, f => { row(f.status.workspace).confirmation = null; },
  ];
  for (const change of changes) {
   const denied = structuredClone(f); change(denied); const before = structuredClone(denied);
   expect(() => verify(denied)).toThrow(); expect(denied).toEqual(before);
  }
  const source = (f: ReturnType<typeof supplied>, kind: string) => row(row(row(f.status.workspace).journals)[kind]);
  const metadata = (f: ReturnType<typeof supplied>, kind: string) => row(row((source(f, kind).entries as Row[])[0]).metadata);
  const lease = (f: ReturnType<typeof supplied>) => row((row(f.status.workspace).leases as Row[])[0]);
  const semanticChanges: Array<(f: ReturnType<typeof supplied>) => void> = [
   f=>{row(row(f.status.inventory).scope).procRoot='/proc';},f=>{row(row(f.status.inventory).scope).pidNamespace=null;},
   f=>{row(f.status.inventory).vmProcesses=null;},f=>{row(row(f.status.inventory).confirmation).vmProcesses=[];},
   f=>{row(f.status.inventory).nbdDevices=null;},f=>{row(row(f.status.inventory).confirmation).nbdDevices=[];},
   f=>{f.events=[];},f=>{f.events.push(structuredClone(f.events[0]!));},f=>{f.events[0]!.assignmentId='foreign';},
   f=>{f.events[0]!.teamId='foreign';},f=>{f.events[0]!.runId='foreign';},f=>{row(f.events[0]!.context).sandboxId='foreign';},
   f=>{row(f.events[0]!.context).vmId=null;},f=>{row(f.events[0]!.context).vmId='foreign';},
   f=>{row(row(f.events[0]!.context).teardown).verified=false;},
   f=>{const inventory=row(f.status.inventory),vms=inventory.vmProcesses as Row[];vms[0]!.name='sandbox-'+f.vmId;row(inventory.confirmation).vmProcesses=structuredClone(vms);},
   f=>{const inventory=row(f.status.inventory),vms=inventory.vmProcesses as Row[];vms[0]!.name='sandbox-sandbox-warm-22222222-2222-4222-8222-222222222222';row(inventory.confirmation).vmProcesses=structuredClone(vms);},
   f=>{const inventory=row(f.status.inventory),devices=inventory.nbdDevices as Row[];devices[0]!.image='/var/lib/treeseed/agent/workspaces/leases/workspace-lease-11111111-1111-4111-8111-111111111111/work.qcow2';row(inventory.confirmation).nbdDevices=structuredClone(devices);},
   f=>{const inventory=row(f.status.inventory),devices=inventory.nbdDevices as Row[];devices[0]!.failure='unreadable';row(inventory.confirmation).nbdDevices=structuredClone(devices);},
   f => { source(f, 'jobs').entries = []; }, f => { source(f, 'results').entries = []; }, f => { source(f, 'candidates').entries = []; },
   f => { source(f, 'jobs').rootPresent = false; }, f => { row((source(f, 'jobs').entries as Row[])[0]).metadata = null; },
   f => { row((source(f, 'jobs').entries as Row[])[0]).digest = ''; },
   f => { (source(f, 'jobs').entries as Row[]).push(structuredClone((source(f, 'jobs').entries as Row[])[0]!)); },
   f => { metadata(f, 'jobs').state = 'attached'; }, f => { metadata(f, 'jobs').schemaVersion = 'foreign'; },
   f => { row(metadata(f, 'jobs').owner).providerId = 'foreign'; }, f => { row(metadata(f, 'jobs').owner).teamId = 'foreign'; },
   f => { row(metadata(f, 'jobs').owner).projectId = 'foreign'; }, f => { row(metadata(f, 'jobs').owner).attempt = 2; },
   f => { metadata(f, 'jobs').leaseId = 'foreign'; }, f => { lease(f).provider_id = 'foreign'; },
   f => { lease(f).state = 'active'; }, f => { lease(f).attempt = 2; }, f => { lease(f).result_artifact_id = 'foreign'; },
   f => { (row(f.status.workspace).leases as Row[]).push(structuredClone(lease(f))); },
   f => { row(metadata(f, 'jobs').disk).directory = '/caller/path'; }, f => { row(metadata(f, 'jobs').disk).image = '/caller/path'; },
   f => { row(metadata(f, 'jobs').disk).unit = 'foreign.service'; }, f => { row(metadata(f, 'jobs').disk).device = '/dev/sda'; },
   f => { row(metadata(f, 'jobs').disk).id = '../escape'; }, f => { metadata(f, 'jobs').builderIds = ['foreign']; },
   f => { metadata(f, 'jobs').builderIds = Array(2).fill('sandbox-warm-22222222-2222-4222-8222-222222222222'); },
   f => { metadata(f, 'results').leaseId = 'foreign'; }, f => { metadata(f, 'results').sandboxId = 'foreign'; },
   f => { metadata(f, 'results').status = 'failed'; }, f => { metadata(f, 'results').teardownVerified = false; },
   f => { metadata(f, 'results').completedAt = '2026-09-13T12:00:03.000Z'; },
   f => { metadata(f, 'candidates').state = 'retained'; }, f => { metadata(f, 'candidates').providerId = 'foreign'; },
   f => { metadata(f, 'candidates').assignmentId = 'foreign'; }, f => { metadata(f, 'candidates').attempt = 2; },
   f => { metadata(f, 'candidates').verifierStopped = false; }, f => { metadata(f, 'candidates').verifierId = 'foreign'; },
  ];
  for (const type of ['directory', 'file', 'symlink', 'other']) semanticChanges.push(f => {
   (row(f.status.workspace).disks as Row[]).push({ id: row(metadata(f, 'jobs').disk).id, type, bytes: null, device: null });
  });
  for (const id of ['sandbox-warm-22222222-2222-4222-8222-222222222222', 'sandbox-warm-33333333-3333-4333-8333-333333333333'])
   for (const suffix of ['', '-ready']) for (const kind of ['tasks', 'containers']) semanticChanges.push(f => {
    row(f.status.inventory)[kind] += `${id}${suffix}\n`; row(row(f.status.inventory).confirmation)[kind] = row(f.status.inventory)[kind];
   });
  semanticChanges.push(f => { row(f.status.inventory).mountInfo += `2 1 0:2 / ${String(row(metadata(f, 'jobs').disk).directory)}/input rw - tmpfs tmpfs rw\n`; });
  for(const [key,values]of Object.entries({processId:[null,0,-1,1.5,'123'],startTicks:[null,'','0','-1','ticks'],executable:[null,'relative','/usr/bin/foreign'],name:[null,'','../foreign','name with spaces'],failure:['unreadable']}))for(const value of values)semanticChanges.push(f=>{
   const inventory=row(f.status.inventory),vms=inventory.vmProcesses as Row[];vms[0]![key]=value;row(inventory.confirmation).vmProcesses=structuredClone(vms);
  });
  for(const [key,values]of Object.entries({device:[null,'','/dev/sda'],threadId:[null,0,-1,1.5,'124'],processId:[null,0,-1,1.5,'125'],executable:[null,'relative','/usr/bin/unknown-client'],image:[null,'relative','/absolute/../changed'],failure:['unreadable']}))for(const value of values)semanticChanges.push(f=>{
   const inventory=row(f.status.inventory),devices=inventory.nbdDevices as Row[];devices[0]![key]=value;row(inventory.confirmation).nbdDevices=structuredClone(devices);
  });
  semanticChanges.push(f=>{const inventory=row(f.status.inventory),vms=inventory.vmProcesses as Row[];vms.push(structuredClone(vms[0]!));row(inventory.confirmation).vmProcesses=structuredClone(vms);},
   f=>{const inventory=row(f.status.inventory),devices=inventory.nbdDevices as Row[];devices.push(structuredClone(devices[0]!));row(inventory.confirmation).nbdDevices=structuredClone(devices);},
   f=>{f.events[0]!.workdayId='foreign';},f=>{f.events[0]!.projectId='foreign';},
   f=>{const inventory=row(f.status.inventory),vms=inventory.vmProcesses as Row[];vms[0]!.name='sandbox-sandbox-warm-33333333-3333-4333-8333-333333333333';row(inventory.confirmation).vmProcesses=structuredClone(vms);});
  for (const change of semanticChanges) {
   const denied = structuredClone(f); change(denied); const workspace = row(denied.status.workspace);
   for (const name of ['leaseDirectoryPresent', 'disks', 'journals']) row(workspace.confirmation)[name] = structuredClone(workspace[name]);
   const before = structuredClone(denied); expect(() => verify(denied)).toThrow(); expect(denied).toEqual(before);
  }
  const analysis = structuredClone(f), original = assignmentAttemptSchema.parse(analysis.items[0]!.assignmentAttempt);
  analysis.items[0]!.assignmentAttempt = assignmentAttemptSchema.parse({ ...original,
   workspace: { mode: 'read-only' }, grant: { ...original.grant, sourceWrite: [], tools: original.grant.tools.filter(tool => tool !== 'source.write') } });
  lease(analysis).mode = 'analysis'; source(analysis, 'candidates').entries = [];
  delete metadata(analysis, 'jobs').builderIds; // Original cache hit has no builder allocation.
  row(row(analysis.status.workspace).confirmation).journals = structuredClone(row(analysis.status.workspace).journals);
  const analysisBefore = structuredClone(analysis); expect(verify(analysis)).toHaveLength(1); expect(analysis).toEqual(analysisBefore);
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

 it('requires exact closed public sessions revoked grants and independently closed mutable workspaces while retaining unrelated resources',async()=>{
  const {exact,attempt,session}=publicResourceClosureFixture();
  const inspect=(value:typeof exact)=>physicalResources.verifyPublicWorkspaceSessionClosure(value.items,value.sessions,(projectId,workspaceId)=>{expect({projectId,workspaceId}).toEqual({projectId:'library-project',workspaceId:'ws_owned'});return value.response;});
  const held=structuredClone(exact);await inspect(exact);expect(exact).toEqual(held);
  for(const mode of['git','read-only']as const){const value=structuredClone(exact),original=assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);value.items[0]!.assignmentAttempt=assignmentAttemptSchema.parse({...original,status:'completed',finishedAt:exact.items[0]!.completedAt,workspace:mode==='git'?original.workspace:{mode:'read-only'},grant:{...original.grant,sourceWrite:mode==='git'?original.grant.sourceWrite:[]}});row(value.items[0]!.treedxProxyHandle).workspaceId=null;const before=structuredClone(value);await physicalResources.verifyPublicWorkspaceSessionClosure(value.items,value.sessions,()=>{throw new Error('Read-only or Git scope cannot request a mutable TreeDX resource');});expect(value).toEqual(before);}

  const changes:Array<(value:typeof exact)=>void>=[value=>{value.items=[];},value=>{value.items.push(structuredClone(value.items[0]!));},value=>{value.items[0]!.status='running';},value=>{value.sessions=[];},value=>{value.sessions.push(session);},value=>{value.items[0]!.providerSessionId='foreign';},value=>{value.items[0]!.treedxProxyHandle={};},value=>{value.items[0]!.workspaceContext={};},value=>{value.items[0]!.capabilityHandles={};},value=>{row((row(value.items[0]!.capabilityHandles).treeDx as Row[])[0]).status='issued';}];
  for(const field of['teamId','providerId','membershipId','status','closedAt'])changes.push(value=>{value.sessions[0]![field]='foreign';});
  for(const field of['workspaceId','repoId','status','mode','baseCommitSha','branchName','allowedPaths'])changes.push(value=>{row(value.response.result)[field]='foreign';});
  changes.push(value=>{row(value.response.receipt).projectId='foreign';},value=>{value.response={};},value=>{row(value.response.result).allowedPaths=['knowledge/**','knowledge/**'];},value=>{value.sessions[0]!.closedAt=attempt.createdAt;});
  for(const change of changes){const failed=structuredClone(exact);change(failed);const before=structuredClone(failed);await expect(inspect(failed)).rejects.toThrow();expect(failed).toEqual(before);}await inspect(exact);expect(exact).toEqual(held);
 });
});
