import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AgentToolExecutionTarget, AgentToolMutability, SdkDispatchConfig, SdkDispatchResult } from '@treeseed/sdk';
import { findAgentToolDefinition } from '@treeseed/sdk';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../runtime-types.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';
import type { TreeDxProxyToolName } from './treedx-proxy-tool.ts';
import { validateAgentToolInput } from './agent-tool-schema.ts';
import { callTreeseedContentTool } from './content-tool-runtime.ts';

const execFileAsync = promisify(execFile);

export interface AgentToolRuntimeOptions {
	apiBaseUrl: string;
	providerApiKey: string;
	assignmentId: string;
	leaseToken?: string | null;
	descriptors: ExecutionProviderToolDescriptor[];
	sdk?: Pick<AgentSdk, 'dispatch'>;
	fetchImpl?: typeof fetch;
	repoRoot?: string;
	telemetryPath?: string | null;
	onTelemetry?: (entry: AgentToolCallTelemetry) => void | Promise<void>;
}

export interface AgentToolCallTelemetry {
	assignmentId: string;
	projectId: string;
	toolId: string;
	executionTarget: AgentToolExecutionTarget;
	mutability: AgentToolMutability;
	status: 'started' | 'completed' | 'failed';
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	inputSummary: Record<string, unknown>;
	outputSummary?: Record<string, unknown>;
	operation?: {
		namespace?: string;
		name?: string;
	};
	capturedInputRef?: string;
	capturedOutputRef?: string;
	derivedEvents?: AgentToolDerivedEvent[];
	error?: {
		code: string;
		message: string;
	};
}

export type AgentToolDerivedEvent =
	| {
		type: 'question_created';
		questionRef: Record<string, unknown>;
		answerPolicy?: Record<string, unknown>;
	}
	| {
		type: 'question_updated';
		questionRef: Record<string, unknown>;
	}
	| {
		type: 'content_created';
		contentRef: Record<string, unknown>;
	}
	| {
		type: 'branch_staged';
		branchRef: string;
		stagedRef?: string;
	};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value : '';
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function matchesPath(path: string, pattern: string) {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function descriptorFor(options: AgentToolRuntimeOptions, toolId: string) {
	return options.descriptors.find((descriptor) => descriptor.id === toolId) ?? null;
}

function structuredError(code: string, message: string, metadata: Record<string, unknown> = {}) {
	return { ok: false, code, message, metadata };
}

function defaultSdk(options: AgentToolRuntimeOptions) {
	if (options.sdk) return options.sdk;
	const projectId = text(record(options.descriptors[0]?.metadata).projectId);
	const dispatch = options.apiBaseUrl && options.providerApiKey && projectId
		? {
			projectId,
			marketBaseUrl: options.apiBaseUrl,
			policy: 'prefer_local',
			credentialSource: { type: 'bearer', token: options.providerApiKey },
			fetchImpl: options.fetchImpl,
		} satisfies SdkDispatchConfig
		: undefined;
	return AgentSdk.createLocal({
		repoRoot: options.repoRoot ?? process.cwd(),
		dispatch,
	});
}

function dispatchInputFor(toolId: string, input: Record<string, unknown>, descriptor: ExecutionProviderToolDescriptor) {
	if (toolId === 'treeseed.dev_plan') {
		return { ...input, plan: true, json: true };
	}
	if (toolId === 'treeseed.status') {
		return { ...input, json: true };
	}
	if (toolId === 'treeseed.verify') {
		const metadata = record(descriptor.metadata);
		const worktreeRoot = text(metadata.worktreeRoot);
		if (!worktreeRoot) {
			return structuredError('worktree_required', 'treeseed.verify requires an assigned worktree for this assignment.');
		}
		const commands = Array.isArray(input.commands) ? input.commands.map(String).filter(Boolean) : [];
		return { ...input, commands, cwd: worktreeRoot, json: true };
	}
	return input;
}

async function callSdkDispatchTool(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const definition = findAgentToolDefinition(descriptor.id);
	if (!definition?.dispatch) {
		return structuredError('dispatch_mapping_missing', `${descriptor.id} does not declare an SDK dispatch mapping.`);
	}
	const dispatchInput = dispatchInputFor(descriptor.id, input, descriptor);
	if (record(dispatchInput).ok === false) return dispatchInput;
	const result = await defaultSdk(options).dispatch({
		namespace: definition.dispatch.namespace,
		operation: definition.dispatch.operation,
		input: dispatchInput,
		preferredMode: typeof descriptor.metadata?.dispatchPreferredMode === 'string'
			? descriptor.metadata.dispatchPreferredMode
			: definition.dispatch.assignmentPreferredMode ?? definition.dispatch.preferredMode ?? 'auto',
	}) as SdkDispatchResult;
	return { ok: true, payload: result };
}

function assertPathScope(descriptor: ExecutionProviderToolDescriptor, path: string) {
	const metadata = record(descriptor.metadata);
	const allowedPaths = Array.isArray(metadata.allowedPaths) ? metadata.allowedPaths.map(String) : [];
	const forbiddenPaths = Array.isArray(metadata.forbiddenPaths) ? metadata.forbiddenPaths.map(String) : [];
	if (forbiddenPaths.some((pattern) => matchesPath(path, pattern))) {
		return structuredError('path_forbidden', `${path} is forbidden for this assignment.`, { path, forbiddenPaths });
	}
	if (allowedPaths.length && !allowedPaths.some((pattern) => matchesPath(path, pattern))) {
		return structuredError('path_not_allowed', `${path} is outside the assignment path scope.`, { path, allowedPaths });
	}
	return null;
}

async function callChangedPathsTool(descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const metadata = record(descriptor.metadata);
	const worktreeRoot = text(metadata.worktreeRoot);
	if (!worktreeRoot) {
		return structuredError('worktree_required', 'treeseed.changed_paths requires an assigned worktree for this assignment.');
	}
	const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreeRoot });
	const changedPaths = stdout.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
	for (const path of changedPaths) {
		const scoped = assertPathScope(descriptor, path);
		if (scoped) return scoped;
	}
	const payload: Record<string, unknown> = { changedPaths };
	if (input.includeDiffSummary === true) {
		const diff = await execFileAsync('git', ['diff', '--stat'], { cwd: worktreeRoot }).catch((error) => ({ stdout: error instanceof Error ? error.message : String(error) }));
		payload.diffSummary = diff.stdout;
	}
	return { ok: true, payload };
}

export async function callAgentTool(
	options: AgentToolRuntimeOptions,
	toolId: string,
	input: Record<string, unknown> = {},
) {
	const descriptor = descriptorFor(options, toolId);
	if (!descriptor) {
		return structuredError('tool_not_allowed', `${toolId} is not available for this assignment.`, { toolId });
	}
	if (descriptor.kind !== 'agent_tool') {
		return structuredError('invalid_tool_descriptor', `${toolId} is not an agent tool descriptor.`);
	}
	if (!descriptor.executionTarget || !descriptor.mutability || !descriptor.inputSchema) {
		return structuredError('invalid_tool_descriptor', `${toolId} has an incomplete tool descriptor.`, { toolId });
	}
	const inputValidation = validateAgentToolInput(descriptor.inputSchema, input);
	if (!inputValidation.ok) {
		return structuredError(
			inputValidation.code ?? 'invalid_tool_input',
			inputValidation.message ?? `Invalid input for ${toolId}.`,
			inputValidation.metadata ?? {},
		);
	}
	if (descriptor.executionTarget === 'treedx_proxy') {
		const treeDxDescriptor = descriptor as TreeDxProxyExecutionToolDescriptor;
		try {
			return await callTreeDxProxyTool({
				apiBaseUrl: options.apiBaseUrl,
				providerApiKey: options.providerApiKey,
				assignmentId: options.assignmentId,
				handleId: treeDxDescriptor.handleId,
				descriptor: treeDxDescriptor,
				toolName: toolId as TreeDxProxyToolName,
				input,
				fetchImpl: options.fetchImpl,
			});
		} catch (error) {
			return structuredError('treedx_proxy_request_failed', error instanceof Error ? error.message : String(error), { toolId });
		}
	}
	if (descriptor.executionTarget === 'sdk_dispatch') {
		return await callSdkDispatchTool(options, descriptor, input);
	}
	if (descriptor.executionTarget === 'treeseed_content') {
		return await callTreeseedContentTool({
			apiBaseUrl: options.apiBaseUrl,
			providerApiKey: options.providerApiKey,
			assignmentId: options.assignmentId,
			descriptor,
			input,
			fetchImpl: options.fetchImpl,
		});
	}
	if (descriptor.id === 'treeseed.changed_paths') {
		return await callChangedPathsTool(descriptor, input);
	}
	return structuredError('tool_not_implemented', `${toolId} is not implemented by the provider runner tool runtime.`);
}

function summarize(value: Record<string, unknown>) {
	const summary: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (/token|secret|password|api[_-]?key|authorization/iu.test(key)) {
			summary[key] = '<redacted>';
		} else if (typeof raw === 'string') {
			summary[key] = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
		} else if (Array.isArray(raw)) {
			summary[key] = raw.length > 20 ? [...raw.slice(0, 20), `... ${raw.length - 20} more`] : raw;
		} else if (raw && typeof raw === 'object') {
			summary[key] = '<object>';
		} else {
			summary[key] = raw;
		}
	}
	return summary;
}

function operationForTool(toolId: string, descriptor: ExecutionProviderToolDescriptor | null | undefined) {
	const definition = findAgentToolDefinition(toolId);
	if (definition?.dispatch) {
		return {
			namespace: definition.dispatch.namespace,
			name: definition.dispatch.operation,
		};
	}
	const metadata = record(descriptor?.metadata);
	return {
		namespace: text(metadata.operationNamespace) || descriptor?.executionTarget,
		name: text(metadata.operationName) || toolId,
	};
}

function contentRefFrom(value: Record<string, unknown>) {
	const payload = record(value.payload);
	const content = record(payload.content);
	const data = record(payload.data);
	const ref = record(payload.ref);
	const id = text(value.id) || text(payload.id) || text(content.id) || text(data.id) || text(ref.id);
	const model = text(value.model) || text(payload.model) || text(content.model) || text(data.model) || text(ref.model);
	const path = text(value.path) || text(payload.path) || text(content.path) || text(data.path) || text(ref.path);
	return id || model || path
		? { id: id || undefined, model: model || undefined, path: path || undefined }
		: null;
}

function deriveToolEvents(
	toolId: string,
	descriptor: ExecutionProviderToolDescriptor | null | undefined,
	input: Record<string, unknown>,
	result: unknown,
): AgentToolDerivedEvent[] {
	const output = record(result);
	if (output.ok === false) return [];
	const operation = operationForTool(toolId, descriptor);
	const inputModel = text(input.model) || text(input.contentType) || text(record(input.content).model);
	const outputModel = text(output.model) || text(record(output.payload).model) || text(record(record(output.payload).content).model);
	const model = inputModel || outputModel;
	const action = text(input.action) || operation.name || toolId;
	const ref = contentRefFrom({ ...output, model: model || undefined });
	const events: AgentToolDerivedEvent[] = [];
	if (model === 'question') {
		const questionRef = ref ?? { model: 'question' };
		if (/create|add|write/iu.test(action)) {
			events.push({
				type: 'question_created',
				questionRef,
				answerPolicy: record(input.answerPolicy ?? record(input.frontmatter).answerPolicy ?? record(input.metadata).answerPolicy),
			});
		} else {
			events.push({ type: 'question_updated', questionRef });
		}
	}
	if (ref && /create|add|write/iu.test(action)) {
		events.push({ type: 'content_created', contentRef: ref });
	}
	const payload = record(output.payload);
	const branchRef = text(payload.branchRef) || text(payload.branchName) || text(output.branchRef);
	if ((toolId === 'treeseed.stage' || /stage/iu.test(action)) && branchRef) {
		events.push({ type: 'branch_staged', branchRef, stagedRef: text(payload.stagedRef) || undefined });
	}
	return events;
}

async function emitTelemetry(options: AgentToolRuntimeOptions, entry: AgentToolCallTelemetry) {
	await options.onTelemetry?.(entry);
	if (options.telemetryPath) {
		await appendFile(options.telemetryPath, `${JSON.stringify(entry)}\n`, 'utf8');
	}
}

export async function callAgentToolWithTelemetry(
	options: AgentToolRuntimeOptions,
	toolId: string,
	input: Record<string, unknown> = {},
) {
	const descriptor = descriptorFor(options, toolId);
	const metadata = record(descriptor?.metadata);
	const assignmentId = text(metadata.assignmentId) || options.assignmentId;
	const projectId = text(metadata.projectId);
	const startedAt = new Date();
	if (descriptor?.kind === 'agent_tool') {
		const operation = operationForTool(toolId, descriptor);
		await emitTelemetry(options, {
			assignmentId,
			projectId,
			toolId,
			executionTarget: descriptor.executionTarget,
			mutability: descriptor.mutability,
			status: 'started',
			startedAt: startedAt.toISOString(),
			inputSummary: summarize(input),
			operation,
		});
	}
	const result = await callAgentTool(options, toolId, input);
	if (descriptor?.kind === 'agent_tool') {
		const completedAt = new Date();
		const resultRecord = record(result);
		const failed = resultRecord.ok === false;
		const operation = operationForTool(toolId, descriptor);
		await emitTelemetry(options, {
			assignmentId,
			projectId,
			toolId,
			executionTarget: descriptor.executionTarget,
			mutability: descriptor.mutability,
			status: failed ? 'failed' : 'completed',
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			durationMs: completedAt.getTime() - startedAt.getTime(),
			inputSummary: summarize(input),
			outputSummary: failed ? undefined : summarize(resultRecord),
			operation,
			derivedEvents: failed ? [] : deriveToolEvents(toolId, descriptor, input, resultRecord),
			error: failed
				? {
					code: text(resultRecord.code) || 'tool_failed',
					message: text(resultRecord.message) || 'Tool call failed.',
				}
				: undefined,
		});
	}
	return result;
}
