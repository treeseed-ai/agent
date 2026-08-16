import { appendFile } from 'node:fs/promises';
import { findAgentToolDefinition } from '@treeseed/sdk';
import type { ExecutionProviderToolDescriptor } from '../runtime/runtime-types.ts';
import {
	callAgentTool,
	type AgentToolCallTelemetry,
	type AgentToolDerivedEvent,
	type AgentToolRuntimeOptions,
} from './agent-tool-runtime.ts';
import { missingOperationalCloseoutReceipts, missingPrecommitContentReceipts, readAgentToolTelemetry } from './agent-tool-completion.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value : '';
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function summarize(value: Record<string, unknown>) {
	const summary: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (/token|secret|password|api[_-]?key|authorization/iu.test(key)) summary[key] = '<redacted>';
		else if (typeof raw === 'string') summary[key] = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
		else if (Array.isArray(raw)) summary[key] = raw.length > 20 ? [...raw.slice(0, 20), `... ${raw.length - 20} more`] : raw;
		else if (raw && typeof raw === 'object') summary[key] = '<object>';
		else summary[key] = raw;
	}
	return summary;
}

function operationForTool(toolId: string, descriptor: ExecutionProviderToolDescriptor | null | undefined) {
	const definition = findAgentToolDefinition(toolId);
	if (definition?.dispatch) return { namespace: definition.dispatch.namespace, name: definition.dispatch.operation };
	const metadata = record(descriptor?.metadata);
	return {
		namespace: text(metadata.operationNamespace) || descriptor?.executionTarget,
		name: text(metadata.operationName) || toolId,
	};
}

interface DerivedContentRef extends Record<string, unknown> {
	id?: string;
	model?: string;
	path?: string;
	collection?: string;
	slug?: string;
	subjectId?: string;
	subjectField?: string;
}

function contentRefFrom(value: Record<string, unknown>): DerivedContentRef | null {
	const payload = record(value.payload);
	const content = record(payload.content);
	const data = record(payload.data);
	const refs = Array.isArray(value.refs) ? value.refs : Array.isArray(payload.refs) ? payload.refs : [];
	const ref = { ...record(payload.ref), ...record(refs[0]) };
	const changedPaths = Array.isArray(value.changedPaths) ? value.changedPaths : [];
	const id = text(value.id) || text(payload.id) || text(content.id) || text(data.id) || text(ref.id) || text(ref.slug);
	const model = text(value.model) || text(payload.model) || text(content.model) || text(data.model) || text(ref.model);
	const path = text(value.path) || text(payload.path) || text(content.path) || text(data.path) || text(ref.path) || text(changedPaths[0]);
	return id || model || path ? {
		id: id || undefined,
		model: model || undefined,
		path: path || undefined,
		collection: text(ref.collection) || undefined,
		slug: text(ref.slug) || undefined,
		subjectId: text(ref.subjectId) || undefined,
		subjectField: text(ref.subjectField) || undefined,
	} : null;
}

function contentEvents(toolId: string, input: Record<string, unknown>, output: Record<string, unknown>, operationName: string) {
	const inputModel = text(input.model) || text(input.contentType) || text(record(input.content).model);
	const outputModel = text(output.model) || text(record(output.payload).model) || text(record(record(output.payload).content).model);
	const model = inputModel || outputModel;
	const action = text(input.action) || operationName || toolId;
	let ref = contentRefFrom({ ...output, model: model || undefined });
	const events: AgentToolDerivedEvent[] = [];
	if (model === 'question') {
		const questionRef = ref ?? { model: 'question' };
		events.push(/create|add|write/iu.test(action)
			? { type: 'question_created', questionRef, answerPolicy: record(input.answerPolicy ?? record(input.frontmatter).answerPolicy ?? record(input.metadata).answerPolicy) }
			: { type: 'question_updated', questionRef });
	}
	if (ref && /create|add|write/iu.test(action)) events.push({ type: 'content_created', contentRef: ref });
	else if (ref && /update|link/iu.test(action)) events.push({ type: 'content_updated', contentRef: ref });
	return events;
}

function lifecycleEvents(toolId: string, output: Record<string, unknown>, action: string) {
	const payload = record(output.payload);
	const proxyPayload = record(payload.payload);
	const events: AgentToolDerivedEvent[] = [];
	if (toolId === 'treedx.commit_workspace' || toolId === 'treeseed.content.commit') {
		const commitSha = text(output.commitSha) || text(payload.commitSha) || text(payload.sha) || text(record(payload.commit).sha)
			|| text(proxyPayload.commitSha) || text(proxyPayload.sha) || text(record(proxyPayload.commit).sha);
		const branchRef = text(output.branchRef) || text(payload.branchRef) || text(payload.branchName) || text(payload.ref)
			|| text(proxyPayload.branchRef) || text(proxyPayload.branchName) || text(proxyPayload.ref);
		events.push({ type: 'content_committed', ...(commitSha ? { commitSha } : {}), ...(branchRef ? { branchRef } : {}) });
	}
	const branchRef = text(payload.branchRef) || text(payload.branchName) || text(output.branchRef);
	if ((toolId === 'treeseed.stage' || /stage/iu.test(action)) && branchRef) {
		events.push({ type: 'branch_staged', branchRef, stagedRef: text(payload.stagedRef) || undefined });
	}
	if (toolId === 'treeseed.checkpoint') {
		const result = record(payload);
		const metadata = record(result.metadata);
		const commitSha = text(metadata.commitSha);
		if (commitSha) events.push({
			type: 'source_checkpoint_committed', commitSha,
			branchRef: text(metadata.branchName) || undefined,
			changedPaths: Array.isArray(result.changedPaths) ? result.changedPaths.map(String).filter(Boolean) : [],
		});
	}
	return events;
}

function verificationEvents(toolId: string, output: Record<string, unknown>) {
	if (toolId !== 'treeseed.verify') return [];
	const rawResults = record(output.payload).results;
	const results: Record<string, unknown>[] = Array.isArray(rawResults)
		? rawResults.map(record)
		: [];
	if (!results.length || results.some((result) => result.ok !== true)) return [];
	const commands = results.map((result) => {
		const command = text(result.command);
		const args = Array.isArray(result.args) ? result.args.map(String) : [];
		const cwd = text(result.cwd) || '.';
		return `${command}${args.length ? ` ${args.join(' ')}` : ''} (cwd: ${cwd})`;
	});
	return [{
		type: 'verification_completed' as const,
		status: 'passed' as const,
		summary: `${results.length} verification command${results.length === 1 ? '' : 's'} met the expected exit code.`,
		commands,
	}];
}

function reviewDecisionEvents(toolId: string, output: Record<string, unknown>) {
	if (toolId !== 'treeseed.review_decision') return [];
	const payload = record(output.payload);
	const disposition = text(payload.disposition);
	const summary = text(payload.summary);
	if (!['approved', 'rejected'].includes(disposition) || !summary) return [];
	return [{
		type: 'review_decision_recorded' as const,
		disposition: disposition as 'approved' | 'rejected',
		summary,
	}];
}

function signalEvents(toolId: string, output: Record<string, unknown>): AgentToolDerivedEvent[] {
	if (toolId !== 'treeseed.publish_signal') return [];
	const payload = record(output.payload);
	return payload.requested === true ? [{ type: 'signal_requested', signal: payload }] : [];
}

function communicationEvents(toolId:string,input:Record<string,unknown>,output:Record<string,unknown>):AgentToolDerivedEvent[]{
	if(toolId!=='treeseed.discussion.respond')return [];
	const payload=record(output.payload);const message=record(payload.message);const changeset=record(payload.changeset);
	const path=text(message.path);const commitSha=text(payload.commitSha)||text(changeset.resultCommitSha);
	const checkpoint=record(output.suspensionCheckpoint??output.finalResponseCheckpoint);const checkpointSha=text(checkpoint.commitSha);
	const operational=(Array.isArray(output.suspensionOperationalRefs)?output.suspensionOperationalRefs:[]).map(record).flatMap((ref)=>{
		const operationalPath=text(ref.path)||text(ref.contentPath);if(!operationalPath||!checkpointSha)return [];
		return [{type:'content_created' as const,contentRef:{...ref,model:text(ref.model)||'assignment_summary',path:operationalPath,
			artifactKind:'assignment_summary',commitSha:checkpointSha,ref:text(checkpoint.branchRef)||checkpointSha}}];
	});
	return [
		...operational,
		...(checkpointSha?[{type:'content_committed' as const,commitSha:checkpointSha,branchRef:text(checkpoint.branchRef)||undefined}]:[]),
		...(!path||!commitSha?[]:[{type:'content_created' as const,contentRef:{id:text(message.id)||undefined,model:'discussion_message',path,
		artifactKind:'discussion_response',subjectId:text(input.replyTo)||undefined,subjectField:'replyTo',
		commitSha,ref:commitSha,baseRef:text(changeset.baseCommitSha)||undefined,
		changedPaths:Array.isArray(changeset.changedPaths)?changeset.changedPaths.map(String).filter(Boolean):[path]}}]),
	];
}

function operationalContentEvents(toolId:string,output:Record<string,unknown>):AgentToolDerivedEvent[]{
	const models:Record<string,string>={
		'treeseed.assignment_plan':'assignment_plan','treeseed.assignment_status_update':'assignment_status','treeseed.assignment_summary':'assignment_summary',
	};
	const model=models[toolId];if(!model)return [];
	return (Array.isArray(output.refs)?output.refs:[]).map(record).flatMap((ref)=>{
		const path=text(ref.path)||text(ref.contentPath);if(!path)return [];
		return [{type:'content_created' as const,contentRef:{...ref,model:text(ref.model)||model,path,artifactKind:model}}];
	});
}

function researchEvents(toolId: string, input: Record<string, unknown>, output: Record<string, unknown>): AgentToolDerivedEvent[] {
	const payload = record(output.payload);
	if (toolId === 'research.fetch_source') {
		const sourceUrl = text(payload.url);
		const contentHash = text(payload.contentSha256);
		const retrievedAt = text(payload.retrievedAt);
		if (!sourceUrl || !contentHash || !retrievedAt) return [];
		let publisher = 'unknown';
		try { publisher = new URL(sourceUrl).hostname.toLowerCase(); } catch { /* validated fetch output should always contain an absolute URL */ }
		return [{
			type: 'research_citation_fetched',
			citation: {
				sourceUrl,
				title: text(input.title) || sourceUrl,
				publisher,
				retrievedAt,
				contentHash,
				claimIds: Array.isArray(input.claimIds) ? input.claimIds.map(String).filter(Boolean) : ['research-claim'],
				confidence: ['low', 'medium', 'high'].includes(text(input.confidence)) ? text(input.confidence) : 'medium',
			},
		}];
	}
	if (toolId === 'treeseed.research_claims') {
		const claims = Array.isArray(payload.claims) ? payload.claims.map(record).filter((claim) => Object.keys(claim).length) : [];
		return claims.length ? [{ type: 'research_claims_recorded', claims }] : [];
	}
	return [];
}

export function deriveToolEvents(toolId: string, descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>, result: unknown) {
	const output = record(result);
	if (output.ok === false) return [];
	const operation = operationForTool(toolId, descriptor);
	const action = text(input.action) || operation.name || toolId;
	return [
		...contentEvents(toolId, input, output, operation.name),
		...lifecycleEvents(toolId, output, action),
		...verificationEvents(toolId, output),
		...reviewDecisionEvents(toolId, output),
		...signalEvents(toolId, output),
		...operationalContentEvents(toolId,output),
		...communicationEvents(toolId,input,output),
		...researchEvents(toolId, input, output),
	];
}

async function emitTelemetry(options: AgentToolRuntimeOptions, entry: AgentToolCallTelemetry) {
	await options.onTelemetry?.(entry);
	if (options.telemetryPath) await appendFile(options.telemetryPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function callAgentToolWithTelemetry(options: AgentToolRuntimeOptions, toolId: string, input: Record<string, unknown> = {}) {
	const descriptor = options.descriptors.find((candidate) => candidate.id === toolId) ?? null;
	const metadata = record(descriptor?.metadata);
	const assignmentId = text(metadata.assignmentId) || options.assignmentId;
	const projectId = text(metadata.projectId);
	const startedAt = new Date();
	if (descriptor?.kind === 'agent_tool') {
		await emitTelemetry(options, {
			assignmentId, projectId, toolId, executionTarget: descriptor.executionTarget, mutability: descriptor.mutability,
			status: 'started', startedAt: startedAt.toISOString(), inputSummary: summarize(input), operation: operationForTool(toolId, descriptor),
		});
	}
	const commitTool = toolId === 'treedx.commit_workspace' || toolId === 'treeseed.content.commit';
	const requiredArtifactKind = text(metadata.requiredArtifactKind);
	const priorTelemetry = commitTool && options.telemetryPath ? await readAgentToolTelemetry(options.telemetryPath) : [];
	const missingPrecommit = !commitTool || !options.telemetryPath ? []
		: metadata.requireContentArtifact === true && requiredArtifactKind
			? missingPrecommitContentReceipts(priorTelemetry, requiredArtifactKind)
			: missingOperationalCloseoutReceipts(priorTelemetry);
	const result = missingPrecommit.length
		? {
			ok: false,
			code: 'content_completion_required_before_commit',
			message: `TreeDX commit requires completion of: ${missingPrecommit.join(', ')}. Create or repair the required linked content before retrying commit.`,
			metadata: { missingReceipts: missingPrecommit },
		}
		: await callAgentTool(options, toolId, input);
	if (descriptor?.kind === 'agent_tool') {
		const completedAt = new Date();
		const resultRecord = record(result);
		const failed = resultRecord.ok === false;
		await emitTelemetry(options, {
			assignmentId, projectId, toolId, executionTarget: descriptor.executionTarget, mutability: descriptor.mutability,
			status: failed ? 'failed' : 'completed', startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
			durationMs: completedAt.getTime() - startedAt.getTime(), inputSummary: summarize(input),
			outputSummary: failed ? undefined : summarize(resultRecord), operation: operationForTool(toolId, descriptor),
			derivedEvents: failed ? [] : deriveToolEvents(toolId, descriptor, input, resultRecord),
			error: failed ? { code: text(resultRecord.code) || 'tool_failed', message: text(resultRecord.message) || 'Tool call failed.' } : undefined,
		});
	}
	return result;
}
