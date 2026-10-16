import{readCapturedCampaignManifest}from'../../../freeze-integrity.ts';
import{frozenCampaignDraftReference}from'../preflight/campaign-proposals.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseDocument} from 'yaml';
import {assignmentAttemptSchema,assignmentResultSchema,exactEntityReferenceSchema,estimateSchema} from '@treeseed/sdk/agent-capacity';
import {validatePortableContentData} from '@treeseed/sdk/content-validation';
import {read,row,type Row} from '../../../acceptance-cli.ts';

const code='ACCEPTANCE_ESTIMATE_AUTHORITY';
const rows=(value:unknown):Row[]=>{assert.ok(Array.isArray(value),code);return value.map(row);};
const fixed=(definition:Row)=>{const {status:_status,...rest}=definition;return {...rest,executionPlan:{...row(definition.executionPlan),workItems:rows(row(definition.executionPlan).workItems).map(item=>{const {estimate:_estimate,reviewEstimate:_review,...rest}=item;return rest;})}};};

/** Original raw proposal bytes and canonical parsed content, never a receipt-only estimate. */
function proposalFile(reference:Row,file:Row,projectId:string):Row{
 assert.equal(file.path,reference.path,code);assert.ok(typeof file.content==='string'&&Buffer.byteLength(file.content)>0&&Buffer.byteLength(file.content)<=1_048_576,code);
 if(reference.digest!==undefined)assert.equal('sha256:'+createHash('sha256').update(file.content).digest('hex'),reference.digest,code);
 const parts=file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);assert.ok(parts,code);const document=parseDocument(parts[1]!,{uniqueKeys:true});assert.equal(document.errors.length,0,code);
 const value=row(document.toJS({maxAliasCount:0}));assert.deepEqual(value,file.frontmatter,code);const checked=validatePortableContentData('proposal',value);assert.ok(checked.ok&&checked.data,code);assert.deepEqual(checked.data,value,code);
 assert.equal(value.projectId,projectId,code);if(reference.id!==undefined)assert.equal(value.id,reference.id,code);return value;
}

const proposalBody=(file:Row)=>{const raw=String(file.content),match=raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u);assert.ok(match,code);return raw.slice(match[0].length);};

/** Each actual estimator must publish its owned patch; the latest exact results supply ready estimates. */
export function verifyEstimatePublications(assignments:Row[],run:Row,readyReference:Row,readyFile:Row,readFile:(reference:Row,projectId:string)=>Row,draftReference:unknown):void{
 const completed=assignments.filter(item=>item.status==='completed'&&row(row(item.assignmentAttempt).effectiveProfile).activity==='estimating');assert.ok(completed.length>0,code);
 const projectId=String(readyReference.projectId??completed[0]!.projectId),ready=proposalFile(readyReference,readyFile,projectId),work=rows(row(ready.executionPlan).workItems),original=frozenCampaignDraftReference(draftReference,code);
 assert.equal(original.id,ready.id,code);assert.equal(original.repository,readyReference.repository,code);assert.equal(original.path,readyReference.path,code);
 const originalFile=readFile(original,projectId),draft=proposalFile(original,originalFile,projectId);assert.equal(draft.status,'draft',code);assert.deepEqual(fixed(draft),fixed(ready),code);assert.equal(proposalBody(originalFile),proposalBody(readyFile),code);

 assert.equal(ready.status,'ready','ACCEPTANCE_ESTIMATE_ROLES: Original proposal is not ready yet');assert.ok(work.length>0&&new Set(work.map(item=>item.id)).size===work.length,code);
 assert.deepEqual(row(run.parameters).proposalIds,[ready.id],code);
 const expected=[...new Set(work.map(item=>String(item.agentClass)))];assert.ok(!expected.includes('reviewer'),code);expected.push('reviewer');
 assert.deepEqual([...new Set(completed.map(item=>row(item.assignmentAttempt).agentClass))].sort(),expected.sort(),code);
 const latest=new Map<string,{finished:number;values:Map<string,unknown>}>(),resultIds=new Set<string>(),owners=new Set<string>();
 for(const item of completed){
  const checked=assignmentAttemptSchema.safeParse(item.assignmentAttempt),resultCheck=assignmentResultSchema.safeParse(item.assignmentResult);assert.ok(checked.success&&resultCheck.success,code);const attempt=checked.data,result=resultCheck.data;
  assert.deepEqual(attempt,item.assignmentAttempt,code);assert.deepEqual(result,item.assignmentResult,code);assert.equal(item.id,attempt.id,code);assert.equal(result.assignmentId,item.id,code);assert.equal(result.status,'completed',code);
  assert.ok(!owners.has(item.id as string)&&!resultIds.has(result.id),code);owners.add(String(item.id));resultIds.add(result.id);
  assert.equal(attempt.workdayId,run.id,code);assert.equal(attempt.teamId,run.teamId,code);assert.equal(item.projectId,attempt.projectId,code);
  const start=Date.parse(attempt.createdAt),finish=Date.parse(result.completedAt);assert.ok(start>=Date.parse(String(run.startedAt))&&finish>=start&&finish<=Date.parse(attempt.deadline),code);assert.equal(item.completedAt,result.completedAt,code);
  const source=attempt.sourceRef;assert.ok(source.store==='treedx'&&source.model==='proposal'&&source.id===ready.id&&source.repository===readyReference.repository&&source.path===readyReference.path,code);
  assert.ok(attempt.workspace.mode==='treedx'&&attempt.workspace.repository===source.repository&&attempt.workspace.baseCommit===source.commit,code);
  const grants=attempt.grant.contentWrite.filter(value=>value.model==='proposal'&&value.id===source.id&&value.repository===source.repository&&value.path===source.path);assert.equal(grants.length,1,code);
  const publications=result.references.filter(value=>value.kind==='treedx'&&value.projectId===attempt.projectId&&value.repository===source.repository&&value.path===source.path);assert.equal(publications.length,1,code);const publication=publications[0]!;
  assert.ok(publication.kind==='treedx'&&publication.workspaceId===attempt.workspace.workspaceId,code);
  const frozenFile=readFile(source,attempt.projectId),candidateFile=readFile(publication,attempt.projectId);
  const frozen=proposalFile(source,frozenFile,attempt.projectId),candidate=proposalFile(publication,candidateFile,attempt.projectId);
  assert.equal(proposalBody(candidateFile),proposalBody(frozenFile),code);assert.equal(proposalBody(readyFile),proposalBody(frozenFile),code);
  assert.deepEqual(fixed(frozen),fixed(ready),code);assert.deepEqual(fixed(candidate),fixed(frozen),code);assert.equal(candidate.status,frozen.status,code);
  const candidateItems=rows(row(candidate.executionPlan).workItems),frozenItems=rows(row(frozen.executionPlan).workItems),reviewer=attempt.agentClass==='reviewer',field=reviewer?'reviewEstimate':'estimate',values=new Map<string,unknown>();
  for(const [index,value]of candidateItems.entries()){
   const before=frozenItems[index]!,owned=(reviewer?value.review==='required':value.agentClass===attempt.agentClass)&&(!attempt.workItemId||value.id===attempt.workItemId);
   for(const name of ['estimate','reviewEstimate'])if(!owned||name!==field)assert.deepEqual(value[name],before[name],code);
   if(!owned)continue;const estimate=estimateSchema.safeParse(value[field]);assert.ok(estimate.success,code);assert.deepEqual(estimate.data,value[field],code);assert.ok(typeof row(value[field]).rationale==='string'&&String(row(value[field]).rationale).trim(),code);values.set(String(value.id),value[field]);
  }
  assert.ok(values.size>0,code);for(const [id,value]of values){const key=attempt.agentClass+':'+id,prior=latest.get(key);assert.ok(!prior||prior.finished!==finish,code);if(!prior||prior.finished<finish)latest.set(key,{finished:finish,values:new Map([[id,value]])});}
 }
 for(const item of work)for(const [agentClass,field]of [[String(item.agentClass),'estimate'],['reviewer','reviewEstimate']]){assert.equal(item.activity,'acting',code);assert.equal(item.review,'required',code);assert.ok(typeof item.objective==='string'&&item.objective.trim(),code);const original=latest.get(agentClass+':'+String(item.id));assert.ok(original,code);assert.deepEqual(item[field],original.values.get(String(item.id)),code);}
}

/** Match genuine estimating results with their original consumed planning
 * inventory; role-specific responsibilities remain in governed profiles. */
export function verifyEstimatingPlanningPredecessors(assignments:Row[],run:Row):void{
 const label='ACCEPTANCE_ESTIMATE_PLANNING';
 try{
  const selection=row(run.parameters).proposalIds;
  assert.ok(selection===undefined||Array.isArray(selection)&&selection.every(value=>typeof value==='string'&&value.trim()===value&&value.length>0)&&new Set(selection).size===selection.length,label+': Exact selected proposal inventory required');
  const estimating=assignments.filter(item=>item.status==='completed'&&row(row(item.assignmentAttempt).effectiveProfile).activity==='estimating');
  if(!selection?.length){assert.equal(estimating.length,0,label+': Subjectless estimating is forbidden');return;}
  assert.ok(estimating.length>0,label+': Selected proposals require actual estimating results');
  const start=Date.parse(String(run.startedAt));assert.ok(Number.isFinite(start),label+': Original workday start required');
  const inventory=assignments.flatMap(item=>item.assignmentResult==null?[]:[{item,result:row(item.assignmentResult)}]);
  for(const item of estimating){
   const checked=assignmentAttemptSchema.parse(item.assignmentAttempt);assert.deepEqual(checked,item.assignmentAttempt,label+': Original canonical estimating authority required');
   assert.equal(item.id,checked.id,label);assert.equal(checked.teamId,run.teamId,label);assert.equal(checked.workdayId,run.id,label);assert.equal(item.projectId,checked.projectId,label);
   assert.ok(checked.sourceRef.model==='proposal'&&selection.includes(checked.sourceRef.id),label+': Estimator lacks its exact selected subject');
   const created=Date.parse(checked.createdAt);assert.ok(Number.isFinite(created)&&created>=start,label);assert.equal(item.createdAt,checked.createdAt,label);
   const consumed=checked.predecessorResultIds.map(id=>{const matches=inventory.filter(value=>value.result.id===id);assert.equal(matches.length,1,label+': Missing or ambiguous original predecessor');return matches[0]!;});
   const own=consumed.filter(value=>row(row(value.item.assignmentAttempt).effectiveProfile).activity==='planning'&&row(value.item.assignmentAttempt).agentClass===checked.agentClass);
   assert.ok(own.length>0,label+': Exact own planning contribution was not consumed');
   const owner=exactEntityReferenceSchema.parse(checked.effectiveProfile.profileRef);
   for(const value of own){
    const prior=row(value.item.assignmentAttempt);assert.equal(value.item.status,'completed',label);assert.equal(value.result.status,'completed',label);
    assert.equal(value.result.assignmentId,value.item.id,label);assert.equal(prior.id,value.item.id,label);assert.equal(prior.teamId,run.teamId,label);assert.equal(prior.workdayId,run.id,label);
    assert.equal(value.item.workDayId,run.id,label);assert.equal(prior.projectId,checked.projectId,label);assert.equal(value.item.projectId,checked.projectId,label);
    const supplied=row(row(prior.effectiveProfile).profileRef),profile=exactEntityReferenceSchema.parse(supplied);assert.deepEqual(profile,supplied,label+': Planning profile cannot be normalized');
    for(const key of ['store','model','id','repository','commit','path','revision','digest'])assert.deepEqual(Reflect.get(profile,key),Reflect.get(owner,key),label+': Original configured owner changed '+key);
    const begin=Date.parse(String(prior.createdAt)),finish=Date.parse(String(value.result.completedAt));assert.ok(Number.isFinite(begin)&&Number.isFinite(finish)&&begin>=start&&finish>=begin&&finish<=created,label+': Estimating preceded its original completed planning contribution');
    assert.equal(value.item.createdAt,prior.createdAt,label);assert.equal(value.item.completedAt,value.result.completedAt,label);
   }
  }
 }catch(cause){if(cause instanceof Error&&cause.message.startsWith(label))throw cause;throw new Error(label+': Original planning predecessor custody failed',{cause});}
}

/** Read the current governed proposal through the same supported public boundary used for approval. */
export function verifyManagedEstimates(assignments:Row[],run:Row,team:string):void{
 const item=assignments.find(value=>row(row(value.assignmentAttempt).effectiveProfile).activity==='estimating');assert.ok(item,code);const source=row(row(item.assignmentAttempt).sourceRef),projectId=String(item.projectId);
 const freezePath=process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;assert.ok(freezePath,code+': Original captured campaign freeze required');const manifest=readCapturedCampaignManifest(freezePath),selected=rows(manifest.proposals).filter(value=>value.id===source.id&&value.projectId===projectId);assert.equal(selected.length,1,code+': One original frozen proposal required');const original=frozenCampaignDraftReference(selected[0]!.draftRef,code);
 const proposal=read(['proposals','show',String(source.id),'--server','local','--project',projectId],team,true),provenance=row(row(proposal.metadata).contentProvenance);
 assert.equal(proposal.id,source.id,code);assert.equal(proposal.projectId,projectId,code);assert.equal(proposal.activeContentHash,provenance.digest,code);
 const reference=exactEntityReferenceSchema.parse({store:'treedx',model:'proposal',id:proposal.id,revision:proposal.activeVersion,digest:'sha256:'+String(provenance.digest),repository:provenance.repositoryId,commit:provenance.commitSha,path:provenance.contentPath}),cache=new Map<string,Row>();
 const readFile=(ref:Row,project:string)=>{const key=JSON.stringify([project,ref.repository,ref.commit,ref.path]);let file=cache.get(key);if(!file){const response=read(['library','read',project,String(ref.path),'--ref',String(ref.commit)],team,true),observed=row(response.result??response);assert.equal(observed.repoId,ref.repository,code);assert.equal(observed.resolvedRef,ref.commit,code);assert.ok(Array.isArray(observed.files)&&observed.files.length===1,code);file=row(observed.files[0]);cache.set(key,file);}return file;},ready=readFile(reference,projectId);
 verifyEstimatePublications(assignments,run,reference,ready,readFile,original);
 verifyEstimatingPlanningPredecessors(assignments,run);
 assert.deepEqual(read(['proposals','show',String(source.id),'--server','local','--project',projectId],team,true),proposal,code);
 for(const item of assignments.filter(value=>row(row(value.assignmentAttempt).effectiveProfile).activity==='acting'))assert.ok(Date.parse(String(item.createdAt))>=Math.max(...assignments.filter(value=>row(row(value.assignmentAttempt).effectiveProfile).activity==='estimating'&&value.status==='completed').map(value=>Date.parse(String(value.completedAt)))),code);
}
