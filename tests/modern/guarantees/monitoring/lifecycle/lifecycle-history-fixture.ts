import{createHash}from'node:crypto';
import{compileWorkday,DEFAULT_WORKDAY_POLICY}from'@treeseed/sdk/agent-capacity';
import{canonicalStandardsJson}from'@treeseed/sdk/standards';
type Row=Record<string,unknown>;
/** Controlled canonical API observations. No model turn, usage or report artifact is claimed. */
export function lifecycleHistoryFixture(){
 const startsAt='2026-10-16T12:00:00.000Z',plan=compileWorkday({id:'controlled-workday',teamId:'controlled-team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt,agentIds:[],policy:DEFAULT_WORKDAY_POLICY});
 const active={...plan,state:'active' as const,activatedAt:startsAt};
 const rounds=[{round:1,state:'complete' as const,assignmentIds:['controlled-turn'],startedAt:startsAt,completedAt:'2026-10-16T12:01:00.000Z'}];
 const plannedRound={...active,planningRounds:rounds},closing={...plannedRound,state:'closing' as const,closingAt:'2026-10-16T12:02:00.000Z'},ended={...closing,state:'ended' as const,endedAt:'2026-10-16T12:03:00.000Z',reportRef:{kind:'treedx' as const,projectId:'controlled-project',repository:'controlled-library',commit:'a'.repeat(40),path:'notes/controlled-report.mdx'}};
 const snapshots=[plan,active,plannedRound,closing,ended];
 const events:Row[]=snapshots.slice(1).map((value,index)=>{const context={previousStatus:'running',status:index===3?'completed':'running',previousPlan:snapshots[index],plan:value};return{id:'workday-lifecycle:'+plan.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex'),eventType:'workday.lifecycle.changed',eventIndex:index,runId:plan.id,workdayId:plan.id,teamId:plan.teamId,projectId:null,assignmentId:null,status:'recorded',title:null,message:null,parameters:{},context,refs:{},metadata:{},createdAt:index<2?rounds[0]!.completedAt:index===2?closing.closingAt:ended.endedAt};});
 const run={id:plan.id,teamId:plan.teamId,status:'completed',executionMode:'simulation',startedAt:startsAt,completedAt:ended.endedAt,reportRefs:{},parameters:{...plan.policySnapshot,deadlineAt:plan.endsAt,appliedPlan:ended}};
 return{run,events,snapshots};
}
