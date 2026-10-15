import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import {request} from '../../kernel/provider-kernel-fixture.ts';
import {createHash} from 'node:crypto';
import {stringify} from 'yaml';
import {state} from '../../kernel/architecture/golden-readback-fixture.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

/** Controlled public inputs; native API551 owns actual PostgreSQL/TreeDX publication proof. */
export function proposalFeedbackFixture(){
 const items=structuredClone((state.replies.get('assignments list')!.items as Row[]).filter(item=>row(row(item.assignmentAttempt).effectiveProfile).activity==='acting'));
 const base=assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);for(const item of items){const old=row(item.assignmentAttempt);item.assignmentAttempt=assignmentAttemptSchema.parse({...base,...old,id:item.id,idempotencyKey:item.id,teamId:base.teamId,projectId:item.projectId,workdayId:item.workDayId,status:'completed',limits:{...base.limits,...row(old.limits)}});}
 const attempt=row(items[0]!.assignmentAttempt),source=row(attempt.sourceRef),authority=(attempt.authorityRefs as Row[]).find(ref=>ref.id==='decision-1')!;
 const files=new Map<string,Row>();const original=structuredClone(state.replies.get('library read decisions/decision-1.mdx')!) as Row;files.set(String(authority.commit)+':'+String(authority.path),original);
 const content=(model:string,id:string,commit:string,frontmatter:Row)=>{const path=model+'s/'+id+'.mdx',raw='---\n'+stringify(frontmatter,{lineWidth:0})+'---\n\nControlled exact original publication.\n';const ref={store:'treedx',model,id,repository:source.repository,commit,path,revision:1,digest:'sha256:'+createHash('sha256').update(raw).digest('hex')};files.set(commit+':'+path,{result:{repoId:source.repository,resolvedRef:commit,files:[{path,content:raw,frontmatter}]}});return ref;};
 const time=String(row(row((row(original.result).files as Row[])[0]).frontmatter).decidedAt);
 const questionRef=content('question','controlled-question','b'.repeat(40),{schemaVersion:'treeseed.question/v1',id:'controlled-question',projectId:attempt.projectId,subjectRef:source,question:'Is the original boundary resolved?',status:'open',askedAt:time});
 const resolutionRef=content('discussion-message','controlled-resolution','c'.repeat(40),{schemaVersion:'treeseed.discussion-message/v1',id:'controlled-resolution',projectId:attempt.projectId,createdAt:time});
 const proposal:Row={id:source.id,status:'accepted',activeVersion:source.revision,activeContentHash:String(source.digest).replace(/^sha256:/u,''),readiness:{votingReady:true,executionPlanReady:true,unresolvedBlockerCount:0},decision:{id:'decision-1',createdAt:time},events:[]};
 const blockers:Row[]=[{id:'blocking-question',eventType:'proposal.discussion',createdAt:time,proposalVersion:source.revision,evidence:{kind:'question',questionRef}},{id:'original-resolution',eventType:'proposal.discussion',createdAt:time,proposalVersion:source.revision,evidence:{resolvesEventId:'blocking-question',resolutionRef}}];
 const calls:string[][]=[];const read=(args:string[],_team:string,_library=false):Row=>{calls.push([...args]);if(args[0]==='proposals')return proposal;const key=args[args.indexOf('--ref')+1]+':'+args[3],value=files.get(key);if(!value)throw new Error('Original exact controlled publication missing: '+key);return value;};
 return{items,proposal,blockers,files,read,calls,source,attempt,questionRef,resolutionRef};
}
