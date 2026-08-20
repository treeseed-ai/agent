import { renderAgentContributionAttestationBlock,validateAgentContributionAttestation,verifyAgentContributionReceipt,type AgentContributionAttestationBundle,type AgentContributionPermission } from '@treeseed/sdk/work-providers';

type Client={request<T=unknown>(path:string,options?:Record<string,unknown>):Promise<T>};
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};

export async function prepareProjectContributionAttestation(input:{client:Client;permission:AgentContributionPermission;availableCapabilities:string[];projectId:string;assignmentId:string;checkpointId?:string|null;agentId:string;capacityProviderId:string;mode:'agent-assisted'|'agent-authored';repository:{provider:string;owner:string;name:string};base:{branch:string;sha:string};head:{branch:string;sha:string};}) {
	if(input.permission.mode!=='delegated-project-authorization'||input.permission.mayPopulatePrAttestation!==true||input.permission.requireExactHead!==true)return {ok:false as const,code:'contribution_attestation_agent_permission_denied'};
	if(!input.availableCapabilities.includes(input.permission.requiredCapability))return {ok:false as const,code:'contribution_attestation_capability_missing'};
	const response=record(await input.client.request(`/v1/projects/${encodeURIComponent(input.projectId)}/contribution-attestations`,{method:'POST',body:{assignmentId:input.assignmentId,checkpointId:input.checkpointId??null,agentId:input.agentId,capacityProviderId:input.capacityProviderId,mode:input.mode,repository:input.repository,base:input.base,head:input.head},requireAuth:true}));
	if(response.ok!==true)return {ok:false as const,code:String(response.code??'contribution_attestation_issuance_failed'),diagnostics:response.diagnostics??[]};
	const bundle=record(response.payload) as AgentContributionAttestationBundle;
	const validation=validateAgentContributionAttestation({authorization:bundle.authorization,attestation:bundle.attestation,expected:{projectId:input.projectId,repository:input.repository,assignmentId:input.assignmentId,baseBranch:input.base.branch,baseSha:input.base.sha,headBranch:input.head.branch,headSha:input.head.sha}});
	if(!validation.ok)return {ok:false as const,code:'contribution_attestation_validation_failed',diagnostics:validation.diagnostics};
	if(!await verifyAgentContributionReceipt(bundle.attestation,bundle.authorization))return {ok:false as const,code:'contribution_attestation_signature_invalid'};
	return {ok:true as const,bundle,managedBodyBlock:renderAgentContributionAttestationBlock(bundle)};
}
