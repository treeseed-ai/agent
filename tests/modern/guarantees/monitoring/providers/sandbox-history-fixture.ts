import{assignmentAttemptSchema}from'@treeseed/sdk/agent-capacity';import{liveAssignmentRecord}from'../live-assignment-fixture.ts';
type Row=Record<string,unknown>;
export function sandboxHistoryFixture(){
 const item=liveAssignmentRecord(),attempt=assignmentAttemptSchema.parse(item.assignmentAttempt),time=(second:number)=>new Date(Date.parse(attempt.createdAt)+second*1000).toISOString(),sandboxId='controlled-native-sandbox',vmId='sandbox-warm-11111111-1111-4111-8111-111111111111';
 const teardown={verified:true,completedAt:time(9)};item.status='completed';item.completedAt=time(10);item.lifecycleOutput={sandboxId,teardown};
 const run={id:attempt.workdayId,teamId:attempt.teamId,executionMode:'simulation'};
 const values:Array<[string,Row,number]>=[['sandbox.created',{profile:'configured-profile'},1],['sandbox.ready',{},2],['execution.started',{model:'configured-model'},4],['execution.progress',{stage:'vm.assigned',vmId,warmed:true},5],['tool.requested',{requestId:'configured-request'},6],['tool.completed',{requestId:'configured-request',ok:true},6],['execution.completed',{},7],['sandbox.destroyed',{verified:true,vmId},8]];
 const raw=values.map(([type,payload,second],sequence)=>({schemaVersion:'treeseed.sandbox-event/v1',sandboxId,assignmentId:attempt.id,sequence,occurredAt:time(second),type,payload}));
 const envelope={runId:run.id,teamId:run.teamId,projectId:attempt.projectId,workdayId:run.id,assignmentId:attempt.id,status:'recorded'};
 const events:Row[]=[{...envelope,id:'controlled-created',eventIndex:0,eventType:'provider.sandbox.created',createdAt:time(3),context:{sandboxId}},
  {...envelope,id:'controlled-destroyed',eventIndex:1,eventType:'provider.sandbox.destroyed',createdAt:time(10),context:{sandboxId,teardown,vmId},protectedPayload:{sandboxEvents:raw}}];
 return{item,run,events,raw,attempt,sandboxId,vmId,time};
}
