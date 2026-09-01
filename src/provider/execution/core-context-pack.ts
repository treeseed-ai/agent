import { createHash } from 'node:crypto';
import { compileAssignmentContextPack } from '@treeseed/sdk/agent-capacity';
import { providerContextCapacitySchema } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutionRequest } from './contracts.ts';

type Row=Record<string,unknown>;
const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const strings=(value:unknown)=>Array.isArray(value)?[...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]:[];
const digest=(value:string)=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const payload=(value:unknown)=>{const envelope=record(value),data=record(envelope.data??envelope),result=record(data.result??data);return record(result.data??result);};
const items=(value:Row)=>['files','entries','items','paths','results'].flatMap((key)=>Array.isArray(value[key])?value[key] as unknown[]:[]).map(record);
const filePath=(file:Row)=>text(file.requestedPath)||text(file.path)||text(file.sourcePath)||text(file.logicalPath);
const fileContent=(file:Row)=>typeof file.content==='string'?file.content:typeof file.body==='string'?file.body:'';

interface LibrarySource { projectId:string;repositoryId:string;baseRef:string;teamId:string;source:'current-project'|'team-library'; }
async function invoke(request:AgentExecutionRequest,source:LibrarySource,operation:string,body:Row){return payload(await request.treeDx.invoke(operation,{path:{projectId:source.projectId,repoId:source.repositoryId},body}));}
async function list(request:AgentExecutionRequest,source:LibrarySource,paths:string[]){return items(await invoke(request,source,'treedx.repositories.paths.list',{paths,kinds:['blob'],limit:500,allowProtected:true})).map(filePath).filter(Boolean).sort();}
async function read(request:AgentExecutionRequest,source:LibrarySource,paths:string[]){const output:Row[]=[];for(let index=0;index<paths.length;index+=20)output.push(...items(await invoke(request,source,'treedx.repositories.files.read',{paths:paths.slice(index,index+20),encoding:'utf8',parseFrontmatter:true,allowProtected:true})));return output;}
function profileRoster(files:Row[],projectSlug:string){return files.map((file)=>{const value=record(file.frontmatter),activities=record(value.activityProfiles);return {handle:`@${projectSlug}/${text(value.slug)||text(value.id)}`,identity:record(value.identity),responsibilities:strings(value.responsibilities).length?strings(value.responsibilities):[text(value.summary),text(value.description)].filter(Boolean),groups:strings(value.groupIds??value.group_ids),capabilities:Array.isArray(value.capabilityRequirements)?value.capabilityRequirements:[],enabledActivities:Object.entries(activities).flatMap(([name,profile])=>record(profile).enabled===false?[]:[name]),authoritySummary:{canWrite:Object.values(activities).some((profile)=>Object.keys(record(record(record(profile).permissions).content)).length>0)},producedArtifacts:Object.values(activities).flatMap((profile)=>Object.keys(record(record(profile).outputContract)))};}).sort((left,right)=>left.handle.localeCompare(right.handle));}
function applicableObjective(file:Row,groups:Set<string>){const frontmatter=record(file.frontmatter),status=text(frontmatter.status).toLowerCase(),objectiveGroups=strings(frontmatter.groupIds??frontmatter.group_ids);return status!=='draft'&&(!objectiveGroups.length||objectiveGroups.some((group)=>groups.has(group)));}
function objectiveSummary(file:Row){const frontmatter=record(file.frontmatter);return `# ${text(frontmatter.title)||filePath(file)}\n\n${text(frontmatter.description)||text(frontmatter.summary)||text(frontmatter.objective)||'Applicable objective; read the full source through TreeDX when needed.'}`;}

export async function readCoreContextPack(request:AgentExecutionRequest,input:{identity:{manifest:Row;sources:Row[]};focused:Row;message:Row}){
	const metadata=record(request.assignment.metadata),manifest=input.identity.manifest,teamLibrary=record(manifest.teamLibrary);
	const current:LibrarySource={teamId:text(manifest.teamId),projectId:text(manifest.projectId),repositoryId:request.treeDx.repositoryId??'',baseRef:request.treeDx.baseRef??'',source:'current-project'};
	const team:LibrarySource={teamId:text(manifest.teamId),projectId:text(teamLibrary.projectId),repositoryId:text(teamLibrary.repositoryId),baseRef:text(teamLibrary.immutableRef),source:'team-library'};
	if(!current.repositoryId||!current.baseRef||!team.projectId||!team.repositoryId||!team.baseRef)throw new Error('Mandatory project and Team Library TreeDX authority is incomplete.');
	const profilePath=text(record(manifest.agentProfile).path),agentsIndex=profilePath.lastIndexOf('agents/'),contentPrefix=agentsIndex>=0?profilePath.slice(0,agentsIndex):'';
	const [projectPaths,teamPaths]=await Promise.all([list(request,current,[`${contentPrefix}agents/**`,`${contentPrefix}objectives/**`]),list(request,team,['objectives/**'])]);
	const agentPaths=projectPaths.filter((path)=>/(?:^|\/)agents\/[^/]+\.(?:md|mdx|yaml|yml)$/u.test(path));
	const projectObjectivePaths=projectPaths.filter((path)=>/(?:^|\/)objectives\/[^/]+\.(?:md|mdx)$/u.test(path)&&!/(?:^|\/)objectives\/core\.(?:md|mdx)$/u.test(path));
	const teamObjectivePaths=teamPaths.filter((path)=>/(?:^|\/)objectives\/[^/]+\.(?:md|mdx)$/u.test(path)&&!/(?:^|\/)objectives\/core\.(?:md|mdx)$/u.test(path));
	const [agentFiles,projectObjectives,teamObjectives,teamAnchors]=await Promise.all([read(request,current,agentPaths),read(request,current,projectObjectivePaths),read(request,team,teamObjectivePaths),read(request,team,['README.md','objectives/core'])]);
	if(agentFiles.length!==agentPaths.length)throw new Error('TreeDX did not return every project agent profile required to compile the roster.');
	const teamReadme=teamAnchors.find((file)=>filePath(file)==='README.md'),teamCore=teamAnchors.find((file)=>text(file.logicalPath)==='objectives/core'||filePath(file).replace(/\.(?:md|mdx)$/u,'')==='objectives/core');
	if(!teamReadme||!fileContent(teamReadme)||!teamCore||!fileContent(teamCore))throw new Error('The Team Library README.md and objectives/core are mandatory.');
	const activeProfile=agentFiles.find((file)=>filePath(file)===profilePath||text(file.logicalPath)===profilePath.replace(/\.(?:md|mdx|ya?ml)$/u,''));
	if(!activeProfile)throw new Error('The active agent profile is missing from the verified roster inputs.');
	const activeFrontmatter=record(activeProfile.frontmatter),groups=new Set(strings(activeFrontmatter.groupIds??activeFrontmatter.group_ids));
	const applicable=[...projectObjectives.filter((file)=>applicableObjective(file,groups)).map((file)=>({file,source:current})),...teamObjectives.filter((file)=>applicableObjective(file,groups)).map((file)=>({file,source:team}))];
	const roster=JSON.stringify(profileRoster(agentFiles,text(manifest.projectSlug)),null,2),materials=new Map<string,{content:string;summary?:string}>(),seen=new Map<string,string>(),candidates:any[]=[];
	const add=(source:LibrarySource,layer:'core'|'agent'|'activity'|'live',kind:string,path:string|null,content:string,required:boolean,priority:number,summary?:string,options:Row={})=>{const id=`${source.projectId}:${path??kind}:${layer}`,dedupKey=`${source.projectId}:${path??`${kind}:${digest(content)}`}`,duplicateOf=seen.get(dedupKey);materials.set(id,{content,summary});if(!duplicateOf)seen.set(dedupKey,id);candidates.push({source:{id,layer,kind,teamId:source.teamId,projectId:source.projectId,path,digest:digest(content),required,metadata:{source:source.source,immutableRef:source.baseRef,...(duplicateOf?{duplicateOf}:{})}},measurement:{unit:'bytes',amount:Buffer.byteLength(content),provenance:'utf8-byte-length'},priority,mandatory:options.mandatory===true,...(duplicateOf?{omissionReason:`duplicate_of:${duplicateOf}`}:{ }),...(Number(options.minimumBudget)>0?{minimumBudget:Number(options.minimumBudget)}:{}),...(Number(options.maximumBudget)>0?{maximumBudget:Number(options.maximumBudget)}:{}),...(summary?{summaryMeasurement:{unit:'bytes',amount:Buffer.byteLength(summary),provenance:'utf8-byte-length:deterministic-summary'}}:{})});};
	for(const source of input.identity.sources){const kind=text(source.kind),path=text(source.path);if(['agent-profile','core-objective','project-readme'].includes(kind))add(current,'core',kind,path,text(source.content),true,100,undefined,{mandatory:true});else add(current,'activity',kind,path,text(source.content),true,90);}
	add(team,'core','team-readme','README.md',fileContent(teamReadme),true,100,undefined,{mandatory:true});add(team,'core','team-core-objective',filePath(teamCore),fileContent(teamCore),true,100,undefined,{mandatory:true});add(current,'core','agent-roster',null,roster,true,95,undefined,{mandatory:true});
	for(const entry of applicable)add(entry.source,'core','applicable-objective',filePath(entry.file),fileContent(entry.file),true,80,objectiveSummary(entry.file));
	for(const source of (Array.isArray(input.focused.sources)?input.focused.sources.map(record):[]))add(current,text(source.layer)==='activity'?'activity':'agent','context-query-result',text(source.path),text(source.content),text(source.requirement)==='required',Number(source.priority??(text(source.layer)==='agent'?70:60)),text(source.summary),{minimumBudget:source.minimumBudget,maximumBudget:source.maximumBudget});
	add(current,'live','discussion-message',text(input.message.path),text(input.message.content),true,100,undefined,{mandatory:true});
	for(const history of (Array.isArray(input.message.history)?input.message.history.map(record):[]))add(current,'live','discussion-history',text(history.path),text(history.content),false,90);
	const communication=record(metadata.communication);if(!Object.keys(communication).length)throw new Error('Communication assignment omitted current discussion and recipient state.');
	add(current,'live','discussion-state',null,JSON.stringify(communication,null,2),true,100,undefined,{mandatory:true});
	const capacity=providerContextCapacitySchema.parse(metadata.contextCapacity??request.assignment.contextCapacity);let pack;
	try{pack=compileAssignmentContextPack({assignmentId:request.assignmentId,capacity,candidates});}
	catch(error){const wrapped=new Error(`The selected capability offer contradicted its advertised context capacity: ${error instanceof Error?error.message:String(error)}`) as Error&{code:string};wrapped.code='provider_context_capacity_overflow';throw wrapped;}
	const sources=pack.sources.flatMap((source)=>{const material=materials.get(source.id);if(!material||source.disposition==='omitted'||source.disposition==='failed')return[];return [{...source,content:source.disposition==='summarized'?material.summary:material.content}];});
	return {manifest:pack,sources,roster:JSON.parse(roster),queryLayers:record(input.focused.queryLayers)};
}
