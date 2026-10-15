import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import {request} from '../../../kernel/provider-kernel-fixture.ts';
import type {Row} from '../../../../acceptance/acceptance-cli.ts';
export function publicResourceClosureFixture(){
  const original=assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);const clock='2026-09-13T12:00:02.000Z',closed='2026-09-13T12:00:03.000Z';
  const attempt=assignmentAttemptSchema.parse({...original,status:'completed',finishedAt:clock,workspace:{mode:'treedx',workspaceId:'ws_owned',repository:'library-owned',baseCommit:'a'.repeat(40),writablePaths:['knowledge']},grant:{...original.grant,sourceWrite:[]}});
  const proxy={id:'handle-owned',teamId:attempt.teamId,projectId:attempt.projectId,assignmentId:attempt.id,workspaceId:'ws_owned',repositoryId:'library-owned',repositoryProjectId:'library-project',branchName:'refs/heads/'+attempt.id,allowedPaths:['knowledge/**'],status:'revoked',revokedAt:clock};
  const handles={repository:[],treeDx:[{id:'owned-capability',status:'revoked',revokedAt:clock}],workflowOperations:[],secrets:[]};
  const item:Row={id:attempt.id,teamId:attempt.teamId,projectId:attempt.projectId,workDayId:attempt.workdayId,status:'completed',completedAt:clock,membershipId:'membership-owned',providerSessionId:'session-owned',assignmentAttempt:attempt,treedxProxyHandle:proxy,capabilityHandles:handles,workspaceContext:{treedxProxyHandle:proxy,capabilityHandles:handles}};
  const session:Row={id:'session-owned',teamId:attempt.teamId,providerId:attempt.provider.providerId,membershipId:'membership-owned',status:'closed',openedAt:attempt.createdAt,closedAt:closed};
  const response:Row={result:{workspaceId:'ws_owned',repoId:'library-owned',status:'closed',mode:'writable',baseCommitSha:'a'.repeat(40),branchName:proxy.branchName,allowedPaths:['knowledge/**']},receipt:{projectId:'library-project'}};
  const exact={items:[item],sessions:[session,{...session,id:'unrelated-open',status:'open',closedAt:null}],response};
 return {exact,attempt,session,proxy,clock};
}
