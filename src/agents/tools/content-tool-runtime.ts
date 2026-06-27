import {
	findTreeseedContentToolPreset,
	renderTreeseedContentRecord,
	validateTreeseedContentRecord,
	type TreeseedContentAction,
	type TreeseedContentModel,
} from '@treeseed/sdk/content-operations';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../runtime-types.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';

export interface ContentToolCallOptions {
	apiBaseUrl: string;
	providerApiKey: string;
	assignmentId: string;
	descriptor: ExecutionProviderToolDescriptor;
	input?: Record<string, unknown>;
	fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function structuredError(code: string, message: string, metadata: Record<string, unknown> = {}) {
	return { ok: false, code, message, metadata };
}

function proxyDescriptor(descriptor: ExecutionProviderToolDescriptor): TreeDxProxyExecutionToolDescriptor | null {
	const candidate = descriptor as TreeDxProxyExecutionToolDescriptor;
	if (!candidate.handleId || !candidate.routes) return null;
	return {
		...candidate,
		executionTarget: 'treedx_proxy',
	};
}

function resolveContentCall(descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const metadata = record(descriptor.metadata);
	const preset = typeof metadata.contentPreset === 'string' ? findTreeseedContentToolPreset(metadata.contentPreset) : null;
	const idParts = descriptor.id.split('.');
	const action = text(metadata.contentAction)
		|| preset?.action
		|| (idParts[1] === 'content' ? idParts[2] : idParts[idParts.length - 1]);
	const model = text(metadata.contentModel) || preset?.model || text(input.model);
	return {
		action: action as TreeseedContentAction,
		model: model as TreeseedContentModel | undefined,
	};
}

async function readWorkspaceFile(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, path: string) {
	return await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerApiKey: options.providerApiKey,
		assignmentId: options.assignmentId,
		handleId: descriptor.handleId,
		descriptor,
		toolName: 'treedx.read_workspace_file',
		input: { path },
		fetchImpl: options.fetchImpl,
	});
}

async function writeWorkspaceFile(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, path: string, content: string) {
	return await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerApiKey: options.providerApiKey,
		assignmentId: options.assignmentId,
		handleId: descriptor.handleId,
		descriptor,
		toolName: 'treedx.write_workspace_file',
		input: { path, content },
		fetchImpl: options.fetchImpl,
	});
}

function responseContent(value: unknown) {
	const source = record(value);
	if (typeof source.content === 'string') return source.content;
	if (typeof source.text === 'string') return source.text;
	if (typeof source.body === 'string') return source.body;
	return '';
}

export async function callTreeseedContentTool(options: ContentToolCallOptions) {
	const descriptor = proxyDescriptor(options.descriptor);
	if (!descriptor) {
		return structuredError('invalid_tool_descriptor', `${options.descriptor.id} is missing TreeDX proxy descriptor metadata.`);
	}
	const input = options.input ?? {};
	const { action, model } = resolveContentCall(options.descriptor, input);
	const contentModel = model ?? text(input.model) as TreeseedContentModel;
	try {
		if (action === 'describe') {
			return {
				ok: true,
				action,
				refs: [],
				diagnostics: [],
				payload: {
					model: contentModel || null,
					message: 'Use TreeSeed content tools to query, read, create, update, link, validate, or commit model-aware content.',
				},
			};
		}
		if (action === 'query') {
			const result = await callTreeDxProxyTool({
				apiBaseUrl: options.apiBaseUrl,
				providerApiKey: options.providerApiKey,
				assignmentId: options.assignmentId,
				handleId: descriptor.handleId,
				descriptor,
				toolName: 'treedx.search_workspace',
				input: { query: text(input.query) || contentModel || '*' },
				fetchImpl: options.fetchImpl,
			});
			return { ok: true, action, refs: [], diagnostics: [], payload: record(result) };
		}
		if (action === 'commit') {
			const message = text(input.message) || text(record(input.commit).message);
			if (!message) return structuredError('content_validation_failed', 'A commit message is required.', { field: 'message' });
			const result = await callTreeDxProxyTool({
				apiBaseUrl: options.apiBaseUrl,
				providerApiKey: options.providerApiKey,
				assignmentId: options.assignmentId,
				handleId: descriptor.handleId,
				descriptor,
				toolName: 'treedx.commit_workspace',
				input: { message },
				fetchImpl: options.fetchImpl,
			});
			return { ok: true, action, refs: [], diagnostics: [], payload: record(result) };
		}
		if (!contentModel) return structuredError('content_model_unknown', 'A content model is required.', { toolId: options.descriptor.id });
		if (action === 'read') {
			const rendered = renderTreeseedContentRecord({
				model: contentModel,
				slug: text(input.slug) || text(input.id),
				title: text(input.title) || text(input.slug) || text(input.id),
				placement: record(input.placement),
			});
			const result = await readWorkspaceFile(options, descriptor, text(input.path) || rendered.path);
			return { ok: true, action, refs: [rendered.ref], diagnostics: [], payload: record(result) };
		}
		const rendered = renderTreeseedContentRecord({
			model: contentModel,
			id: text(input.id) || undefined,
			slug: text(input.slug) || undefined,
			title: text(input.title) || undefined,
			fields: record(input.fields),
			body: typeof input.body === 'string' ? input.body : undefined,
			relations: Array.isArray(input.relations) ? input.relations as never : undefined,
			placement: record(input.placement),
		});
		if (action === 'validate') {
			const validation = validateTreeseedContentRecord(contentModel, rendered.content);
			if (!validation.ok) {
				return structuredError('content_validation_failed', 'Content validation failed.', { diagnostics: validation.diagnostics });
			}
			return { ok: true, action, refs: [rendered.ref], diagnostics: validation.diagnostics };
		}
		if (action === 'create' || action === 'update' || action === 'link') {
			await writeWorkspaceFile(options, descriptor, rendered.path, rendered.content);
			const readback = await readWorkspaceFile(options, descriptor, rendered.path).catch(() => null);
			if (readback) {
				const validation = validateTreeseedContentRecord(contentModel, responseContent(readback) || rendered.content);
				if (!validation.ok) {
					return structuredError('content_readback_failed', 'Content readback validation failed.', { diagnostics: validation.diagnostics });
				}
			}
			return {
				ok: true,
				action,
				refs: [rendered.ref],
				changedPaths: [rendered.path],
				diagnostics: rendered.diagnostics,
			};
		}
		return structuredError('tool_not_implemented', `${options.descriptor.id} content action is not implemented.`, { action });
	} catch (error) {
		const code = action === 'query' || action === 'read' ? 'content_readback_failed' : 'content_write_failed';
		return structuredError(code, error instanceof Error ? error.message : String(error), { action, model: contentModel });
	}
}
