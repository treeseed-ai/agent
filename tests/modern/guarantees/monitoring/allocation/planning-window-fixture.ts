import {assignmentAttemptSchema,allocateWorkdayCapacity,compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import type {Row} from '../../../../acceptance/acceptance-cli.ts';

/** Controlled original public scope/receipt inputs, never managed admission truth. */
export function planningWindowScope(item:Row){
 const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt),startsAt=new Date(Date.parse(attempt.createdAt)-1200_000).toISOString();
 const plan={...compileWorkday({id:attempt.workdayId,teamId:attempt.teamId,executionMode:'simulation',policyId:'default',policyRevision:1,startsAt,agentIds:[],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3,maximumConcurrency:5,communicationConcurrency:5}}),state:'active' as const};
 const activity=attempt.effectiveProfile.activity,seconds=attempt.limits.maximumSeconds;
 const opportunity=allocateWorkdayCapacity({remainingSeconds:seconds,now:attempt.createdAt,workdays:[{plan,committedSeconds:0,planningCommittedSeconds:0,maximumAdditionalSeconds:seconds,actingReady:['acting','reviewing','reporting'].includes(activity)}]})[plan.id]!;
 return {run:{id:plan.id,teamId:plan.teamId,executionMode:plan.executionMode,startedAt:plan.startsAt,parameters:{...plan.policySnapshot,deadlineAt:plan.endsAt,appliedPlan:plan,scheduledProjectIds:[attempt.projectId]}},opportunity};
}
