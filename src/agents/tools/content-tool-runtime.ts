import {
	findContentToolPreset,
	renderContentRecord,
	validateContentRecord,
	type ContentAction,
	type ContentModel,
} from '@treeseed/sdk/content-operations';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../runtime/runtime-types.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';

export interface ContentToolCallOptions {
	apiBaseUrl: string;
	providerAccessToken: string;
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
	const preset = typeof metadata.contentPreset === 'string' ? findContentToolPreset(metadata.contentPreset) : null;
	const idParts = descriptor.id.split('.');
	const action = text(metadata.contentAction)
		|| preset?.action
		|| (idParts[1] === 'content' ? idParts[2] : idParts[idParts.length - 1]);
	const model = text(metadata.contentModel) || preset?.model || text(input.model);
	return {
		action: action as ContentAction,
		model: model as ContentModel | undefined,
	};
}

async function readWorkspaceFile(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, path: string) {
	return await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerAccessToken: options.providerAccessToken,
		assignmentId: options.assignmentId,
		handleId: descriptor.handleId,
		descriptor,
		toolName: 'treedx.read_workspace_file',
		input: { path },
		fetchImpl: options.fetchImpl,
	});
}

async function readModelContentFile(
	options: ContentToolCallOptions,
	descriptor: TreeDxProxyExecutionToolDescriptor,
	canonicalPath: string,
) {
	const paths = canonicalPath.endsWith('.mdx')
		? [canonicalPath, canonicalPath.replace(/\.mdx$/u, '.md')]
		: [canonicalPath];
	let firstError: unknown;
	for (const path of paths) {
		try {
			return { path, result: await readWorkspaceFile(options, descriptor, path) };
		} catch (error) {
			firstError ??= error;
		}
	}
	throw firstError;
}

async function writeWorkspaceFile(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, path: string, content: string) {
	return await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerAccessToken: options.providerAccessToken,
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

function descriptorContentRoot(descriptor: TreeDxProxyExecutionToolDescriptor) {
	const configured = typeof descriptor.metadata?.contentRoot === 'string' ? descriptor.metadata.contentRoot.trim() : '';
	if (configured) return configured.replace(/\\/gu, '/').replace(/\/+$/u, '');
	const scopedPaths = descriptor.allowedWritePaths?.length
		? descriptor.allowedWritePaths
		: descriptor.allowedReadPaths?.length
			? descriptor.allowedReadPaths
			: descriptor.allowedPaths;
	for (const allowed of scopedPaths) {
		const candidate = allowed.replace(/\\/gu, '/').replace(/\/\*\*$/u, '').replace(/\/+$/u, '');
		if (candidate.endsWith('/src/content') || candidate === 'src/content') return candidate;
	}
	return 'src/content';
}

function contentSlug(input: Record<string, unknown>) {
	const candidate = text(input.slug) || text(input.id);
	if (!candidate.includes('/')) return candidate;
	return candidate.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1)?.replace(/\.mdx?$/iu, '') ?? candidate;
}

export async function callContentTool(options: ContentToolCallOptions) {
	const descriptor = proxyDescriptor(options.descriptor);
	if (!descriptor) {
		return structuredError('invalid_tool_descriptor', `${options.descriptor.id} is missing TreeDX proxy descriptor metadata.`);
	}
	const input = options.input ?? {};
	const { action, model } = resolveContentCall(options.descriptor, input);
	const contentModel = model ?? text(input.model) as ContentModel;
	const contentRoot = descriptorContentRoot(descriptor);
	const relations = Array.isArray(input.relations) ? input.relations.filter((entry) => {
		const relation = record(entry);
		return Boolean(text(relation.field) && text(relation.targetSlug));
	}) : [];
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
				providerAccessToken: options.providerAccessToken,
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
				providerAccessToken: options.providerAccessToken,
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
		if (action === 'link' && !relations.length) return structuredError('content_relation_required', 'Content link requires at least one relation with field and targetSlug.', { toolId: options.descriptor.id });
		if (action === 'read') {
			const rendered = renderContentRecord({
				model: contentModel,
				slug: contentSlug(input),
				title: text(input.title) || contentSlug(input),
				placement: record(input.placement),
				contentRoot,
			});
			const explicitPath = text(input.path);
			const { path, result } = explicitPath
				? { path: explicitPath, result: await readWorkspaceFile(options, descriptor, explicitPath) }
				: await readModelContentFile(options, descriptor, rendered.path);
			return {
				ok: true,
				action,
				refs: [{ ...rendered.ref, path }],
				diagnostics: [],
				payload: record(result),
			};
		}
		const initial = renderContentRecord({
			model: contentModel,
			slug: contentSlug(input) || undefined,
			title: text(input.title) || undefined,
			fields: record(input.fields),
			body: typeof input.body === 'string' ? input.body : undefined,
			relations: relations as never,
			placement: record(input.placement),
			contentRoot,
		});
		let rendered = initial;
		if (action === 'update' || action === 'link') {
			const existing = await readModelContentFile(options, descriptor, initial.path);
			rendered = renderContentRecord({
				model: contentModel,
				slug: contentSlug(input) || undefined,
				title: text(input.title) || undefined,
				fields: record(input.fields),
				body: typeof input.body === 'string' ? input.body : undefined,
				relations: relations as never,
				placement: record(input.placement),
				contentRoot,
				existingContent: responseContent(existing.result),
			});
		}
		if (action === 'validate') {
			const validation = validateContentRecord(contentModel, rendered.content);
			if (!validation.ok) {
				return structuredError('content_validation_failed', 'Content validation failed.', { diagnostics: validation.diagnostics });
			}
			return { ok: true, action, refs: [rendered.ref], diagnostics: validation.diagnostics };
		}
		if (action === 'create' || action === 'update' || action === 'link') {
			await writeWorkspaceFile(options, descriptor, rendered.path, rendered.content);
			const readback = await readWorkspaceFile(options, descriptor, rendered.path).catch(() => null);
			if (readback) {
				const validation = validateContentRecord(contentModel, responseContent(readback) || rendered.content);
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
