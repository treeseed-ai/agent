import type { AgentToolRuntimeOptions } from '../runtime/agent-tool-runtime-types.ts';

function headers(options: AgentToolRuntimeOptions) { return { authorization:`Bearer ${options.providerAccessToken}`,accept:'application/json','content-type':'application/json' }; }
async function responsePayload(response: Response) {
	const envelope=await response.json().catch(()=>null) as { payload?:unknown;error?:string;code?:string }|null;
	if(!response.ok) return { ok:false,code:envelope?.code??'assignment_discussion_request_failed',message:envelope?.error??`Assignment discussion request failed with HTTP ${response.status}.` };
	return { ok:true,payload:envelope?.payload };
}

export async function readAssignmentDiscussion(options:AgentToolRuntimeOptions,input:Record<string,unknown>){
	const query=new URLSearchParams();
	for(const key of ['discussionId','query','after','limit'] as const){ const value=input[key]; if(value!==undefined&&value!==null&&value!=='') query.set(key,String(value)); }
	const response=await(options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/discussions?${query}`,{ headers:headers(options) });
	return responsePayload(response);
}

export async function respondToAssignmentDiscussion(options:AgentToolRuntimeOptions,input:Record<string,unknown>,checkpoint:Record<string,unknown>|null){
	const body={ ...input,leaseToken:options.leaseToken??null,checkpoint };
	const response=await(options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/discussions/responses`,{ method:'POST',headers:headers(options),body:JSON.stringify(body) });
	const result=await responsePayload(response);
	if(result.ok&&input.requiredResponse===true) return { ...result,suspended:true };
	return result;
}

export async function requestAssignmentDiscussionHandoff(options:AgentToolRuntimeOptions,input:Record<string,unknown>){
	const response=await(options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/discussions/handoffs`,{ method:'POST',headers:headers(options),body:JSON.stringify({ ...input,leaseToken:options.leaseToken??null }) });
	return responsePayload(response);
}

export async function prepareAssignmentOperationHandoff(options:AgentToolRuntimeOptions,input:Record<string,unknown>){
	const response=await(options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/operation-handoffs`,{ method:'POST',headers:headers(options),body:JSON.stringify({ ...input,leaseToken:options.leaseToken??null }) });
	return responsePayload(response);
}

export async function requestAssignmentClientAction(options:AgentToolRuntimeOptions,input:Record<string,unknown>){
	const response=await(options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/client-actions`,{ method:'POST',headers:headers(options),body:JSON.stringify({ ...input,leaseToken:options.leaseToken??null }) });
	return responsePayload(response);
}
