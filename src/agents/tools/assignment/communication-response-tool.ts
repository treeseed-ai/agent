import type { ExecutionProviderToolDescriptor } from '../../runtime/runtime-types.ts';
import { callContentTool } from '../content-tool-runtime.ts';
import { missingCommunicationReadReceipts, missingOperationalCloseoutReceipts, readAgentToolTelemetry } from '../agent-tool-completion.ts';
import { readAssignmentStatus } from '../status/assignment-status-tool.ts';
import type { AgentToolRuntimeOptions } from '../runtime/agent-tool-runtime-types.ts';
import { respondToAssignmentDiscussion } from './discussion-tool.ts';
import { callAssignmentOperationalContentTool,hasAssignmentSummary } from './operational-content-tool.ts';

type Row=Record<string,unknown>;
function record(value:unknown):Row{return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};}
function text(value:unknown){return typeof value==='string'?value:'';}
function descriptorFor(options:AgentToolRuntimeOptions,id:string){return options.descriptors.find((entry)=>entry.id===id)??null;}
function error(code:string,message:string,metadata:Row={}){return {ok:false,code,message,metadata};}
function committedRef(value:unknown){let current=record(value);for(let depth=0;depth<4&&Object.keys(current).length;depth+=1){const commitSha=text(current.commitSha)||text(current.resultCommitSha)||text(current.sha)||text(record(current.commit).sha);if(commitSha)return {commitSha,branchRef:text(current.branchRef)||text(current.branchName)||text(current.ref)||undefined};current=record(current.payload);}return null;}

async function checkpointOperationalContent(options:AgentToolRuntimeOptions,idempotencyKey:string){
	const content=descriptorFor(options,'treeseed.content.commit');
	if(!content)return error('assignment_discussion_checkpoint_unavailable','A Discussion response requires the TreeDX operational checkpoint tool.');
	const outcome=await callContentTool({apiBaseUrl:options.apiBaseUrl,providerAccessToken:options.providerAccessToken,assignmentId:options.assignmentId,descriptor:content,input:{message:`checkpoint before final discussion response ${idempotencyKey}`},fetchImpl:options.fetchImpl});
	const ref=committedRef(outcome);
	return record(outcome).ok===true&&ref?{ok:true,checkpoint:{...ref,kind:'treedx-content'}}:error('assignment_discussion_checkpoint_failed','TreeDX operational checkpoint failed before the Discussion response.',{outcome});
}

export async function runAssignmentDiscussionResponse(options:AgentToolRuntimeOptions,descriptor:ExecutionProviderToolDescriptor,input:Row){
	let checkpoint:Row|null=null;let operationalRefs:Row[]=[];let responseInput=input;
	if(!options.telemetryPath)return error('assignment_discussion_evidence_unavailable','Discussion responses require authoritative assignment tool telemetry.');
	const communicationMissing=missingCommunicationReadReceipts(await readAgentToolTelemetry(options.telemetryPath));
	if(communicationMissing.length)return error('assignment_discussion_context_required','Read and follow the exact Discussion before publishing a response.',{missingReceipts:communicationMissing});
	if(input.requiredResponse===true){
		const summaryDescriptor=descriptorFor(options,'treeseed.assignment_summary');
		if(summaryDescriptor){
			const status=record((await readAssignmentStatus(options)).payload);
			const summary=await callAssignmentOperationalContentTool(options,summaryDescriptor,{action:'write',expectedStateVersion:status.stateVersion,status:'suspended',summary:`Suspended pending a required discussion response: ${text(input.message)}`,lessons:[],blockers:['Waiting for a required discussion response.'],performance:{outcome:'suspended',metrics:{}},artifactRefs:[],verificationRefs:[],resumeState:{checkpoint:'pending-required-response-checkpoint',nextAction:'Resume from the retained assignment plan after a governed response.',contextRefs:[]},idempotencyKey:`${text(input.idempotencyKey)}:summary`});
			if(record(summary).ok!==true)return error('assignment_suspension_summary_failed','Suspension summary failed before discussion send.',{summary});
			const refs=record(summary).refs;
			operationalRefs=(Array.isArray(refs)?refs:[]).map((ref:unknown)=>record(ref)).filter((ref:Row)=>Object.keys(ref).length>0);
		}
		const result=await checkpointOperationalContent(options,text(input.idempotencyKey));
		if(record(result).ok!==true)return result;
		checkpoint=record(result).checkpoint as Row;
		const current=record((await readAssignmentStatus(options)).payload);responseInput={...input,expectedStateVersion:current.stateVersion};
	}else{
		if(!await hasAssignmentSummary(options))return error('assignment_final_summary_required','Write the terminal assignment summary before publishing the final Discussion response.');
		const missingReceipts=missingOperationalCloseoutReceipts(await readAgentToolTelemetry(options.telemetryPath));
		if(missingReceipts.length)return error('assignment_final_closeout_required','Complete terminal operational records before publishing the final Discussion response.',{missingReceipts});
	}
	let response=await respondToAssignmentDiscussion(options,responseInput,checkpoint);
	if(input.requiredResponse!==true&&record(response).code==='assignment_discussion_checkpoint_required'){
		const result=await checkpointOperationalContent(options,text(input.idempotencyKey));
		if(record(result).ok!==true)return result;
		checkpoint=record(result).checkpoint as Row;
		const current=record((await readAssignmentStatus(options)).payload);
		response=await respondToAssignmentDiscussion(options,{...input,expectedStateVersion:current.stateVersion},checkpoint);
	}
	if(record(response).ok!==true)return response;
	return input.requiredResponse===true?{...record(response),suspensionCheckpoint:checkpoint,suspensionOperationalRefs:operationalRefs}:{...record(response),finalResponseCheckpoint:checkpoint};
}
