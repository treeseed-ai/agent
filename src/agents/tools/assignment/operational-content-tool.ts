import type { ExecutionProviderToolDescriptor,TreeDxProxyExecutionToolDescriptor } from '../../runtime/runtime-types.ts';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { callContentTool } from '../content-tool-runtime.ts';
import { readAssignmentStatus } from '../status/assignment-status-tool.ts';
import type { AgentToolRuntimeOptions } from '../runtime/agent-tool-runtime-types.ts';

type Row = Record<string,unknown>;
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
export function operationalResponseContent(value: unknown, seen = new WeakSet<object>()): string {
	if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return '';
	seen.add(value);
	const source=record(value);
	for(const candidate of [source.content,source.text,source.body]) if(typeof candidate==='string') return candidate;
	for(const candidate of [source.payload,source.data,source.file]) { const nested=operationalResponseContent(candidate,seen); if(nested) return nested; }
	return '';
}
function frontmatter(value: unknown) { const source=operationalResponseContent(value); if(!source) return {}; try { return record(parseFrontmatterDocument(source).frontmatter); } catch { return {}; } }

function proxyDescriptor(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor) {
	const source = options.descriptors.find((candidate) => Boolean((candidate as TreeDxProxyExecutionToolDescriptor).routes));
	if (!source) return null;
	return { ...source, id: descriptor.id, name: descriptor.name, description: descriptor.description,
		inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, executionTarget: 'treeseed_content' as const,
		mutability: descriptor.mutability, metadata: {
			...record(source.metadata), ...record(descriptor.metadata),
			// These exact-assignment records are mandatory lifecycle evidence, not
			// profile-authored domain content. Their authority is the isolated
			// assignment path and tool contract, while TreeDX still enforces both.
			permissionSummary: {},
		} };
}

function operationalContentRoot(descriptor: ExecutionProviderToolDescriptor) {
	const metadataRoot = text(record(descriptor.metadata).contentRoot);
	if (metadataRoot) return metadataRoot.replace(/\/+$/u, '');
	const paths = (descriptor as TreeDxProxyExecutionToolDescriptor).allowedWritePaths
		?? (descriptor as TreeDxProxyExecutionToolDescriptor).allowedPaths ?? [];
	for (const path of paths) {
		const candidate = path.replace(/\\/gu, '/').replace(/\/\*\*$/u, '').replace(/\/+$/u, '');
		if (candidate === 'src/content' || candidate.endsWith('/src/content')) return candidate;
	}
	return 'src/content';
}

function operationalModel(toolId: string) {
	if (toolId === 'treeseed.assignment_plan') return { model: 'assignment_plan', collection: 'assignment-plans' } as const;
	if (toolId === 'treeseed.assignment_status_update') return { model: 'assignment_status', collection: 'assignment-statuses' } as const;
	return { model: 'assignment_summary', collection: 'assignment-summaries' } as const;
}

function contentId(toolId:string,input:Row,status:Row){ return toolId==='treeseed.assignment_status_update'?`${optionsId(status)}-status-${Number(input.sequence)}`:optionsId(status); }
export function assignmentOperationalPath(toolId:string,input:Row,status:Row,contentRoot='src/content') {
	const model=operationalModel(toolId); return `${contentRoot}/${model.collection}/${contentId(toolId,input,status)}.mdx`;
}
function contentFields(toolId: string, input: Row, status: Row, existing: Row) {
	const now = new Date().toISOString();
	const common = {
		id: contentId(toolId,input,status), title: `${toolId.split('.').at(-1)?.replace(/_/gu, ' ')} for ${optionsId(status)}`,
		teamId: text(status.teamId), projectId: text(status.projectId), ...(text(status.workdayId) ? { workdayId: text(status.workdayId) } : {}), assignmentId: optionsId(status),
		createdAt: text(input.createdAt) || now, updatedAt: now,
	};
	if (toolId === 'treeseed.assignment_plan') return { ...common, createdAt:text(existing.createdAt)||common.createdAt,status: text(input.status) || 'ready', revision:Math.max(1,Number(existing.revision)||0)+(Object.keys(existing).length?1:0), objective: text(input.objective),
		completed:Array.isArray(input.completed)?input.completed:[],remaining:Array.isArray(input.remaining)?input.remaining:[],risks:Array.isArray(input.risks)?input.risks:[],...(record(input.resumeState).checkpoint?{ resumeState:record(input.resumeState) }:{}),
		decisionId: text(record(status.governance).decisionId) || undefined, capacityPlanId: text(record(status.governance).capacityPlanId) || undefined };
	if (toolId === 'treeseed.assignment_status_update') { const sequence=Number(input.sequence); return { ...common,status:text(input.status),sequence,...(sequence>0?{ previousStatusRef:record(input.previousStatusRef) }:{}),phase:text(input.phase),reason:text(input.reason)||undefined,progress:input.progress }; }
	return { ...common, status: text(input.status), summary: text(input.summary), artifactRefs: Array.isArray(input.artifactRefs) ? input.artifactRefs : [],
		verificationRefs: Array.isArray(input.verificationRefs) ? input.verificationRefs : [],lessons:Array.isArray(input.lessons)?input.lessons:[],blockers:Array.isArray(input.blockers)?input.blockers:[],performance:record(input.performance),
		...(record(input.resumeState).checkpoint?{ resumeState:record(input.resumeState) }:{}) };
}

function optionsId(status: Row) { return text(status.assignmentId); }

async function startExecutionAfterInitialPlan(options:AgentToolRuntimeOptions,status:Row,result:Row,input:Row){
	if(text(record(status.time).phase)!=='preparation') return null;
	const ref=Array.isArray(result.refs)?record(result.refs[0]):{};
	const response=await (options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/execution-start`,{
		method:'POST',headers:{ authorization:`Bearer ${options.providerAccessToken}`,accept:'application/json','content-type':'application/json' },
		body:JSON.stringify({ leaseToken:options.leaseToken,expectedStateVersion:status.stateVersion,idempotencyKey:`${text(input.idempotencyKey)}:execution-start`,planRef:{ id:text(ref.id)||options.assignmentId,path:text(ref.path),revision:Number(frontmatter(result.postcondition).revision??1) } }),
	});
	const payload=await response.json().catch(()=>null);
	if(!response.ok) return { ok:false,code:text(record(payload).code)||'assignment_execution_start_failed',message:text(record(payload).error)||`Execution start failed with HTTP ${response.status}.`,metadata:{ payload } };
	return record(payload);
}

async function startCloseoutBeforeSummary(options:AgentToolRuntimeOptions,status:Row,input:Row){
	const phase=text(record(status.time).phase);
	if(phase==='expired') return { status,transition:{ ok:false,code:'assignment_closeout_deadline_exhausted',message:'The protected closeout deadline has expired; no further TreeDX mutation is authorized.' } };
	if(phase==='closeout') return { status,transition:null };
	const response=await (options.fetchImpl??fetch)(`${options.apiBaseUrl.replace(/\/+$/u,'')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/closeout-start`,{
		method:'POST',headers:{ authorization:`Bearer ${options.providerAccessToken}`,accept:'application/json','content-type':'application/json' },
		body:JSON.stringify({ leaseToken:options.leaseToken,expectedStateVersion:status.stateVersion,idempotencyKey:`${text(input.idempotencyKey)}:closeout-start` }),
	});
	const payload=await response.json().catch(()=>null); const assignment=record(record(payload).payload);
	if(!response.ok) return { status,transition:{ ok:false,code:text(record(payload).code)||'assignment_closeout_start_failed',message:text(record(payload).error)||`Closeout start failed with HTTP ${response.status}.`,metadata:{ payload } } };
	return { status:{ ...status,...assignment,assignmentId:text(assignment.id)||text(status.assignmentId),workdayId:text(assignment.workDayId)||text(status.workdayId) },transition:assignment };
}

async function readRecord(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor, toolId: string,input:Row={}) {
	const proxy = proxyDescriptor(options, descriptor);
	if (!proxy) return { ok: false, code: 'assignment_treedx_proxy_required', message: 'Assignment operational content requires an assignment-scoped TreeDX workspace.' };
	const model = operationalModel(toolId);
	return callContentTool({ ...options, descriptor: { ...proxy, metadata: { ...record(proxy.metadata), contentAction: 'read', contentModel: model.model } },
		input: { model: model.model, id: contentId(toolId,input,{ assignmentId:options.assignmentId }), path: assignmentOperationalPath(toolId,input,{ assignmentId:options.assignmentId },operationalContentRoot(proxy)) } });
}

export async function hasAssignmentPlan(options: AgentToolRuntimeOptions) {
	const descriptor = options.descriptors.find((candidate) => candidate.id === 'treeseed.assignment_plan');
	if (!descriptor) return false;
	const result = await readRecord(options, descriptor, descriptor.id);
	return record(result).ok === true;
}

export async function hasAssignmentSummary(options: AgentToolRuntimeOptions) {
	const descriptor = options.descriptors.find((candidate) => candidate.id === 'treeseed.assignment_summary');
	if (!descriptor) return false;
	const result = await readRecord(options, descriptor, descriptor.id);
	return record(result).ok === true;
}

export async function callAssignmentOperationalContentTool(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor, input: Row) {
	const action = descriptor.id === 'treeseed.assignment_status_update' ? 'write' : text(input.action) || 'read';
	if (action === 'read') return readRecord(options, descriptor, descriptor.id);
	let authoritative = record((await readAssignmentStatus(options)).payload);
	if (Number(input.expectedStateVersion) !== Number(authoritative.stateVersion)) return { ok: false, code: 'assignment_status_stale', message: 'Assignment state changed; read treeseed.status and retry with its exact stateVersion.', metadata: { expectedStateVersion: input.expectedStateVersion, stateVersion: authoritative.stateVersion } };
	let closeoutTransition:Row|null=null;
	if(descriptor.id==='treeseed.assignment_summary'){
		const closeout=await startCloseoutBeforeSummary(options,authoritative,input);
		if(record(closeout.transition).ok===false) return closeout.transition;
		authoritative=closeout.status; closeoutTransition=closeout.transition;
	}
	const proxy = proxyDescriptor(options, descriptor);
	if (!proxy) return { ok: false, code: 'assignment_treedx_proxy_required', message: 'Assignment operational content requires an assignment-scoped TreeDX workspace.' };
	const model = operationalModel(descriptor.id);
	const existing = descriptor.id==='treeseed.assignment_status_update'?{ ok:false }:await readRecord(options, descriptor, descriptor.id,input);
	const contentAction = descriptor.id==='treeseed.assignment_status_update'?'create':record(existing).ok === true ? 'update' : 'create';
	const existingFields=frontmatter(existing);
	const exactId = contentId(descriptor.id,input,authoritative);
	const exactPath = assignmentOperationalPath(descriptor.id,input,authoritative,operationalContentRoot(proxy));
	const result = await callContentTool({ ...options, descriptor: { ...proxy, metadata: { ...record(proxy.metadata), contentAction, contentModel: model.model } },
		input: { model: model.model, id: exactId, slug: exactId, placement: { path: exactPath }, title: `${model.model.replace(/_/gu, ' ')} ${options.assignmentId}`,
			fields: contentFields(descriptor.id, input, authoritative,existingFields), body: text(input.body) || text(input.summary) || text(input.objective) } });
	if (record(result).ok !== true) return result;
	const postcondition = await readRecord(options, descriptor, descriptor.id,input);
	if(record(postcondition).ok!==true) return { ok: false, code: 'assignment_operational_readback_failed', message: 'Operational content mutation did not pass authoritative TreeDX readback.', metadata: { result, postcondition } };
	const completed={ ...record(result),postcondition:record(postcondition).payload };
	if(descriptor.id==='treeseed.assignment_plan'){
		const transition=await startExecutionAfterInitialPlan(options,authoritative,completed,input);
		if(record(transition).ok===false) return transition;
		if(transition) {
			const executionTransition=record(record(transition).payload);
			return { ...completed,assignmentStateVersion:executionTransition.stateVersion,executionTransition };
		}
	}
	const assignmentStateVersion=closeoutTransition?.stateVersion??authoritative.stateVersion;
	return closeoutTransition?{ ...completed,assignmentStateVersion,closeoutTransition }:{ ...completed,assignmentStateVersion };
}
