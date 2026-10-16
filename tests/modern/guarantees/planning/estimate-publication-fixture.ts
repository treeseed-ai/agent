import {createHash} from 'node:crypto';
import {stringify} from 'yaml';
import {assignmentAttemptSchema,assignmentResultSchema} from '@treeseed/sdk/agent-capacity';
import {request} from '../../kernel/provider-kernel-fixture.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

export const estimateClasses=['architect','researcher','tester','engineer','technical-writer','releaser','reviewer'];
/** Controlled input only; not seven model estimates or a governed ready revision. */
export function estimateProposal(projectId='sdk'){
 return {schemaVersion:'treeseed.proposal/v1',id:'proposal',projectId,title:'Controlled estimate authority',request:'Verify exact class-owned estimate publication.',summary:'Controlled proposal input.',status:'draft',executionPlan:{workItems:estimateClasses.slice(0,6).map((agentClass,index)=>({id:'work-'+index,activity:'acting',agentClass,workspace:index<2?'treedx':'git',contextRefs:[{store:'git',model:'repository',id:'sdk-source',repository:'treeseed-ai/sdk',commit:'a'.repeat(40)},...(index<2?[{store:'treedx',model:'repository',id:'sdk-library',repository:'sdk-library',commit:'b'.repeat(40)}]:[])],review:'required',objective:'Verify controlled work '+index+'.',dependsOn:[],requestedPermissions:{content:{read:['proposal'],write:[]},tools:[]},requiredCapabilities:[],acceptanceCriteria:['Retain exact source and owned estimates.'],maximumReviewCycles:2}))}};
}
export function estimatePatch(definition:ReturnType<typeof estimateProposal>,agentClass:string):Row{
 return {...structuredClone(definition),executionPlan:{workItems:definition.executionPlan.workItems.map(item=>({...structuredClone(item),...(agentClass==='reviewer'?{reviewEstimate:{expectedSeconds:1,maximumSeconds:2,rationale:'Controlled reviewer estimate.'}}:item.agentClass===agentClass?{estimate:{expectedSeconds:2,maximumSeconds:3,rationale:'Controlled '+agentClass+' estimate.'}}:{})}))}};
}
export const proposalBody='Controlled immutable proposal body.';
export const proposalBytes=(definition:Row)=>'---\n'+stringify(definition,{lineWidth:0})+'---\n\n'+proposalBody+'\n';
export const proposalFile=(path:string,definition:Row)=>({path,content:proposalBytes(definition),frontmatter:structuredClone(definition)});

/** Correct canonical estimating inputs for the existing mocked public-read oracle. */
export function retainUnitEstimatePublications(items:Row[],replies:Map<string,Row>,run:Row){
 const definition=estimateProposal(),path='proposals/estimate-source.mdx',sourceCommit='e'.repeat(40),repository='sdk-library',sourceBytes=proposalBytes(definition);
 const source={store:'treedx',model:'proposal',id:definition.id,repository,commit:sourceCommit,path,revision:1,digest:'sha256:'+createHash('sha256').update(sourceBytes).digest('hex')};
 const set=(commit:string,value:Row)=>replies.set('library read '+path+' --ref '+commit,{result:{ok:true,repoId:repository,resolvedRef:commit,files:[proposalFile(path,value)]}});set(sourceCommit,definition);
 const ready:Row={...structuredClone(definition),status:'ready',executionPlan:{workItems:definition.executionPlan.workItems.map(item=>({...item,estimate:{expectedSeconds:2,maximumSeconds:3,rationale:'Controlled '+item.agentClass+' estimate.'},reviewEstimate:{expectedSeconds:1,maximumSeconds:2,rationale:'Controlled reviewer estimate.'}}))}};
 const completedEstimates:Row[]=[];
 for(const [index,agentClass]of estimateClasses.entries()){
  const item=items.find(value=>value.id==='estimate-'+agentClass);if(!item)throw new Error('Original estimating fixture item required');
  const planning=items.find(value=>value.id==='planning-1-'+agentClass);if(!planning)throw new Error('Original own planning fixture required');
  Object.assign(row(planning.assignmentAttempt),{id:planning.id,teamId:run.teamId,projectId:definition.projectId,workdayId:run.id,createdAt:planning.createdAt});
  const prior=row(planning.assignmentResult),done=Math.max(Date.parse(String(prior.completedAt)),...(agentClass==='reviewer'?completedEstimates.map(value=>Date.parse(String(value.completedAt))):[]));
  const candidate=estimatePatch(definition,agentClass),commit=(index+1).toString(16).repeat(40),base=assignmentAttemptSchema.parse(request().assignment.assignmentAttempt),createdAt=new Date(done+1).toISOString(),completedAt=new Date(done+1001).toISOString();
  const {workItemId:_workItemId,...scope}=base;
  const attempt=assignmentAttemptSchema.parse({...scope,id:item.id,idempotencyKey:item.id,teamId:run.teamId,projectId:definition.projectId,workdayId:run.id,agentClass,createdAt,deadline:'2026-09-27T00:00:20.000Z',estimate:row(item.assignmentAttempt).estimate,limits:{...base.limits,maximumSeconds:10},status:'completed',finishedAt:completedAt,sourceRef:source,contextRefs:[source],predecessorResultIds:[String(prior.id),...(agentClass==='reviewer'?completedEstimates.map(value=>String(row(value.assignmentResult).id)):[])],effectiveProfile:{...base.effectiveProfile,profileRef:structuredClone(row(row(planning.assignmentAttempt).effectiveProfile).profileRef),activity:'estimating',handler:'estimate',permissionCeiling:{content:{read:['proposal'],write:['proposal']},tools:[]}},workspace:{mode:'treedx',repository,workspaceId:'workspace-'+item.id,baseCommit:sourceCommit,writablePaths:[path]},grant:{contentRead:[source],contentWrite:[source],sourceRead:[],sourceWrite:[],tools:[]}});
  Object.assign(item,{teamId:run.teamId,createdAt,completedAt,assignmentAttempt:attempt,assignmentResult:assignmentResultSchema.parse({...row(item.assignmentResult),completedAt,references:[{kind:'treedx',projectId:definition.projectId,repository,commit,path,workspaceId:'workspace-'+item.id}]})});Object.assign(row(row(row(item.capacityEnvelope).budget).time),{executionStartedAt:createdAt,closeoutStartedAt:completedAt});set(commit,candidate);completedEstimates.push(item);
 }
 // Controlled acting/review clocks follow the actual estimating inputs; original deadlines and duration remain unchanged.
 const after=Math.max(...completedEstimates.map(value=>Date.parse(String(value.completedAt))))+1;
 const issued=items.filter(value=>['acting','reviewing'].includes(String(row(row(value.assignmentAttempt).effectiveProfile).activity))),shift=Math.max(0,after-Math.min(...issued.map(value=>Date.parse(String(value.createdAt)))));
 for(const item of issued){
  const begin=Date.parse(String(item.createdAt));if(!shift)continue;const offset=shift,finish=new Date(Date.parse(String(item.completedAt))+offset).toISOString(),attempt=row(item.assignmentAttempt);if(Date.parse(finish)>Date.parse(String(attempt.deadline)))throw new Error('Original controlled deadline cannot be extended');
  const createdAt=new Date(begin+offset).toISOString();Object.assign(item,{createdAt,completedAt:finish});attempt.createdAt=createdAt;if(attempt.finishedAt!==undefined)attempt.finishedAt=finish;row(item.assignmentResult).completedAt=finish;Object.assign(row(row(row(item.capacityEnvelope).budget).time),{executionStartedAt:createdAt,closeoutStartedAt:finish});
 }
 const readyCommit='f'.repeat(40),digest=createHash('sha256').update(proposalBytes(ready)).digest('hex');set(readyCommit,ready);replies.set('proposals show',{id:definition.id,projectId:definition.projectId,activeVersion:8,activeContentHash:digest,metadata:{contentProvenance:{repositoryId:repository,contentPath:path,commitSha:readyCommit,digest}}});
 return {definition,ready,path,source,readyCommit};
}
