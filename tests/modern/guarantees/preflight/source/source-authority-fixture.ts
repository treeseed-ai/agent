import {assignmentAttemptSchema,type AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
import {request} from '../../../kernel/provider-kernel-fixture.ts';
import type {Row} from '../../../../acceptance/acceptance-cli.ts';
/** Controlled owning observations; the native caller supplies its actual Kernel source identity. */
export function sourceAuthorityFixture(input?:AssignmentAttempt){
 const original=input??assignmentAttemptSchema.parse(request().assignment.assignmentAttempt),items:Row[]=[],entries:Row[]=[];
 for(const [index,mode]of (['git','read-only','treedx']as const).entries()){
  const id=original.id+'-source-'+index,workspace=mode==='git'?original.workspace:mode==='read-only'?{mode:'read-only' as const}:{mode:'treedx' as const,workspaceId:'ws_source',repository:'library-source',baseCommit:'b'.repeat(40),writablePaths:['knowledge']};
  const attempt=assignmentAttemptSchema.parse({...original,id,idempotencyKey:id,leaseId:'lease-'+id,reservationId:'reservation-'+id,status:'completed',workspace,
   grant:{...original.grant,sourceWrite:mode==='git'?original.grant.sourceWrite:[],tools:mode==='git'?original.grant.tools:original.grant.tools.filter(tool=>tool!=='source.write')}});
  const sourceRef=attempt.contextRefs.find(ref=>ref.store==='git'&&ref.repository&&ref.commit);if(!sourceRef?.repository||!sourceRef.commit)throw new Error('Original exact source required');
  const sandboxId='sandbox-source-scope-'+index,item:Row={id,status:'completed',assignmentAttempt:attempt,lifecycleOutput:{sandboxId}};
  const authority={schemaVersion:'treeseed.source-workspace-authorization/v1',id:'authority-'+id,assignmentId:id,providerId:attempt.provider.providerId,attempt:attempt.attempt,
   source:{controlPlaneId:'controlled-source',teamId:attempt.teamId,projectId:attempt.projectId,repositoryId:sourceRef.repository,commit:mode==='git'&&workspace.mode==='git'?workspace.baseCommit:sourceRef.commit,formatVersion:1,profile:'source-only'},
   mode:mode==='git'?'work':'analysis',acquisition:'upstream-public',publication:mode==='git'?'simulation-branch':'denied',...(mode==='git'&&workspace.mode==='git'?{publicationRef:workspace.branch}:{}),issuedAt:attempt.createdAt,expiresAt:new Date(Date.parse(attempt.createdAt)+30_000).toISOString()};
  entries.push({name:sandboxId+'.json',type:'file',digest:'a'.repeat(64),metadata:{schemaVersion:'treeseed.assignment-source-job/v1',state:'stopped',owner:{assignmentId:id,providerId:attempt.provider.providerId,teamId:attempt.teamId,projectId:attempt.projectId,attempt:attempt.attempt},authority}});items.push(item);
 }
 const unrelated=structuredClone(entries[0]!);unrelated.name='sandbox-unrelated-source.json';const metadata=unrelated.metadata as Row,owner=metadata.owner as Row;owner.assignmentId='unrelated-assignment';owner.teamId='unrelated-team';const a=metadata.authority as Row;a.assignmentId=owner.assignmentId;(a.source as Row).teamId=owner.teamId;a.acquisition='upstream-authorized';a.publication='assignment-branch';a.publicationRef='treeseed/assignments/unrelated';a.credentialBindingId='unrelated-opaque-binding';entries.push(unrelated);
 const journals={jobs:{rootPresent:true,entries}},status:Row={workspace:{complete:true,initialized:true,errors:[],scope:{storageRoot:'/var/lib/treeseed/agent/workspaces'},journals,confirmation:{journals:structuredClone(journals)}}};
 return{items,status};
}
