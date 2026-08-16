import { createHash } from 'node:crypto';
import { compileDeclarativeContextQuery,contextQueryResultFacts,type ContextQuerySetDefinition,type DeclarativeContextQuery } from '@treeseed/sdk';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type { AgentContext } from '../../runtime/runtime-types.ts';
import { readRecord,type HandlerPayload } from '../shared.ts';

type QueryRef={kind:'query'|'query-set';id:string;revision:number};

function text(value:unknown) { return typeof value==='string'&&value.trim()?value.trim():null; }
function digest(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function references(payload:HandlerPayload):QueryRef[] {
	return (Array.isArray(payload.contextQueryRefs)?payload.contextQueryRefs:[]).flatMap((value)=>{
		const row=readRecord(value); const kind=row?.kind; const id=text(row?.id); const revision=Number(row?.revision);
		return (kind==='query'||kind==='query-set')&&id&&Number.isInteger(revision)&&revision>0?[{kind,id,revision}]:[];
	});
}

function responseFile(response:Record<string,unknown>) {
	const payload=readRecord(response.payload)??response;
	const values=[payload.files,readRecord(payload.data)?.files,readRecord(payload.result)?.files];
	for(const value of values) if(Array.isArray(value)&&value.length) return readRecord(value[0]);
	return null;
}

export function assignmentContextRef(context:AgentContext,payload:HandlerPayload) {
	const definitionRef=text(payload.contextDefinitionRef)??text(readRecord(payload.agentDefinition)?.immutableRef);
	if(definitionRef) return definitionRef;
	const assignment=readRecord(context.capacity?.assignment);
	const handle=readRecord(context.capacity?.treedxProxyHandle)??readRecord(assignment?.treedxProxyHandle)??readRecord(readRecord(assignment?.workspaceContext)?.treedxProxyHandle);
	return text(handle?.baseCommitSha)??text(handle?.baseRef)??text(payload.contentBaseRef);
}

export function assignmentRuntimeContextRef(context:AgentContext,payload:HandlerPayload) {
	const runtimeRef=text(payload.contextRuntimeRef)??text(payload.contentBaseRef);
	if(runtimeRef) return runtimeRef;
	const assignment=readRecord(context.capacity?.assignment);
	const handle=readRecord(context.capacity?.treedxProxyHandle)??readRecord(assignment?.treedxProxyHandle)??readRecord(readRecord(assignment?.workspaceContext)?.treedxProxyHandle);
	return text(handle?.baseCommitSha)??text(handle?.baseRef);
}

async function frontmatter(context:AgentContext,repoId:string,path:string,ref:string|null) {
	const response=await context.treeDx!.readRepositoryFiles({repoId,paths:[path],...(ref?{ref}:{}),body:{source:'assignment_context_query_definition',assignmentId:context.capacity?.assignmentId}});
	const file=responseFile(response); const source=[file?.content,file?.text,file?.body].find((value):value is string=>typeof value==='string'&&value.length>0)??null;
	if(!source) throw new Error(`Shared context definition ${path} was not readable through the assignment TreeDX proxy.`);
	return parseFrontmatterDocument(source).frontmatter;
}

function compiledRequest(query:DeclarativeContextQuery) {
	const compiled=compileDeclarativeContextQuery(query);
	if(!compiled.ok||!compiled.compiled) throw new Error(`Shared context query ${query.id} is invalid: ${compiled.errors.join('; ')}`);
	return compiled.compiled.request as unknown as Record<string,unknown>;
}

async function execute(context:AgentContext,repoId:string,query:DeclarativeContextQuery,reference:QueryRef,check:Record<string,unknown>|null,definitionRef:string|null,runtimeRef:string|null) {
	if(query.id!==reference.id||query.revision!==reference.revision) throw new Error(`Shared context query ${reference.id} revision does not match assignment revision ${reference.revision}.`);
	const request=compiledRequest(query); const paths=Array.isArray(request.scopePaths)?request.scopePaths.map(String):[];
	const pack=await context.treeDx!.buildContext({repoId,...(runtimeRef?{ref:runtimeRef}:{}),query:text(request.query),paths,body:{
		...request,source:'assignment_realtime_context_query',assignmentId:context.capacity?.assignmentId,
		agentId:context.agent.slug,queryRef:reference,
	}});
	const stats=contextQueryResultFacts(pack);
	return {id:`treedx-realtime-context-query:${reference.id}`,purpose:'Real-time shared agent context query.',source:'treedx_realtime_context_query',
		sourceRef:{queryRef:reference,definitionRef,requestedRuntimeRef:runtimeRef,resolvedRef:text(pack.resolvedRef)??text(readRecord(pack.payload)?.resolvedRef),checkId:text(check?.id),testRef:text(check?.testRef),resultDigest:digest(pack),stats},pack};
}

export async function collectRealtimeSharedContext(input:{context:AgentContext;payload:HandlerPayload;contentRoot:string;repoId:string}):Promise<unknown[]> {
	const refs=references(input.payload); if(!refs.length) return [];
	const definitionRef=assignmentContextRef(input.context,input.payload);
	const runtimeRef=assignmentRuntimeContextRef(input.context,input.payload);
	const checks=Array.isArray(input.payload.contextQueryChecks)?input.payload.contextQueryChecks.map(readRecord).filter(Boolean):[];
	const queryCache=new Map<string,DeclarativeContextQuery>();
	const loadQuery=async(reference:{id:string;revision:number})=>{
		const key=`${reference.id}@${reference.revision}`; const cached=queryCache.get(key); if(cached) return cached;
		const raw=await frontmatter(input.context,input.repoId,`${input.contentRoot}/agent-context-queries/${reference.id}.mdx`,definitionRef);
		const validation=validateContentFrontmatter('agent_context_query',raw);
		if(!validation.ok||!validation.data) throw new Error(`Shared context query ${key} failed runtime validation: ${validation.diagnostics.map((entry)=>`${entry.field}: ${entry.message}`).join('; ')}`);
		const query=validation.data as DeclarativeContextQuery;
		if(query.revision!==reference.revision) throw new Error(`Shared context query ${key} no longer resolves to its assigned revision.`);
		queryCache.set(key,query); return query;
	};
	const evidence=[];
	for(const reference of refs) {
		const check=checks.find((candidate)=>readRecord(candidate?.definition)?.kind===reference.kind
			&&text(readRecord(candidate?.definition)?.id)===reference.id&&Number(readRecord(candidate?.definition)?.revision)===reference.revision)??null;
		if(!check) throw new Error(`Shared context query ${reference.id}@${reference.revision} has no admitted passing check provenance.`);
		if(reference.kind==='query') {
			evidence.push(await execute(input.context,input.repoId,await loadQuery(reference),reference,check,definitionRef,runtimeRef));
			continue;
		}
		const raw=await frontmatter(input.context,input.repoId,`${input.contentRoot}/agent-context-query-sets/${reference.id}.mdx`,definitionRef);
		const validation=validateContentFrontmatter('agent_context_query_set',raw);
		if(!validation.ok||!validation.data) throw new Error(`Shared context query set ${reference.id}@${reference.revision} failed runtime validation.`);
		const set=validation.data as ContextQuerySetDefinition;
		if(set.revision!==reference.revision) throw new Error(`Shared context query set ${reference.id} no longer resolves to assigned revision ${reference.revision}.`);
		for(const member of set.queryRefs) evidence.push(await execute(input.context,input.repoId,await loadQuery(member),{kind:'query',...member},check,definitionRef,runtimeRef));
	}
	return evidence;
}
