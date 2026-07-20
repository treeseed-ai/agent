import { appendFile } from 'node:fs/promises';
import { findAgentToolDefinition } from '@treeseed/sdk';
import type { ExecutionProviderToolDescriptor } from '../runtime-types.ts';
import {
	callAgentTool,
	type AgentToolCallTelemetry,
	type AgentToolDerivedEvent,
	type AgentToolRuntimeOptions,
} from './agent-tool-runtime.ts';

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
	let requiresCommit = false;
	if (!ref && toolId === 'treedx.write_workspace_file' && text(input.path)) {
		const path = normalizePath(text(input.path));
		const collection = path.split('/content/')[1]?.split('/')[0] ?? '';
		const inferredModel = collection === 'knowledge' ? 'knowledge' : collection.endsWith('s') ? collection.slice(0, -1) : collection;
		const filename = path.split('/').at(-1)?.replace(/\.(md|mdx)$/iu, '') ?? '';
		ref = { path, model: inferredModel || undefined, id: filename || undefined, collection: collection || undefined, slug: filename || undefined };
		requiresCommit = true;
	}
	const events: AgentToolDerivedEvent[] = [];
	if (model === 'question') {
		const questionRef = ref ?? { model: 'question' };
		events.push(/create|add|write/iu.test(action)
			? { type: 'question_created', questionRef, answerPolicy: record(input.answerPolicy ?? record(input.frontmatter).answerPolicy ?? record(input.metadata).answerPolicy) }
			: { type: 'question_updated', questionRef });
	}
	if (ref && /create|add|write/iu.test(action)) events.push({ type: 'content_created', contentRef: ref, ...(requiresCommit ? { requiresCommit: true } : {}) });
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

function deriveToolEvents(toolId: string, descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>, result: unknown) {
	const output = record(result);
	if (output.ok === false) return [];
	const operation = operationForTool(toolId, descriptor);
	const action = text(input.action) || operation.name || toolId;
	return [...contentEvents(toolId, input, output, operation.name), ...lifecycleEvents(toolId, output, action)];
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
	const result = await callAgentTool(options, toolId, input);
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
