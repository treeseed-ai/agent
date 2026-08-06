import { createHash } from 'node:crypto';
import {
	findContentToolPreset,
	renderContentRecord,
	validateContentRecord,
	validateProposalContentForSubmission,
	type ContentAction,
	type ContentModel,
} from '@treeseed/sdk/content-operations';
import { createUnifiedChangeset } from '@treeseed/sdk/treedx';
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

async function applyWorkspaceFileChange(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, path: string, before: string | null, content: string) {
	const baseCommitSha = text(descriptor.metadata?.baseCommitSha);
	const baseRef = text(descriptor.metadata?.baseRef);
	if (!baseCommitSha || !baseRef) throw new Error('TreeDX changeset requires the assignment workspace base commit and ref.');
	const patch = createUnifiedChangeset([{ path, before, after: content }]);
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	return await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerAccessToken: options.providerAccessToken,
		assignmentId: options.assignmentId,
		handleId: descriptor.handleId,
		descriptor,
		toolName: 'treedx.apply_workspace_changeset',
		input: {
			contract: 'treedx.changeset/v1', baseCommitSha, baseRef, patch, patchSha256,
			idempotencyKey: createHash('sha256').update(`${options.assignmentId}:${patchSha256}`).digest('hex'),
			expectedDestinationRefHead: baseCommitSha,
		},
		fetchImpl: options.fetchImpl,
	});
}

function responseContent(value: unknown): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
	const source = record(value);
	if (typeof source.content === 'string') return source.content;
	if (typeof source.text === 'string') return source.text;
	if (typeof source.body === 'string') return source.body;
	for (const nested of [source.payload, source.data, source.file]) {
		const content = responseContent(nested);
		if (content) return content;
	}
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
	const candidate = text(input.slug) || text(input.id) || text(record(input.placement).path) || text(input.path);
	if (!candidate.includes('/')) return candidate;
	return candidate.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1)?.replace(/\.mdx?$/iu, '') ?? candidate;
}

function modelRelativePlacement(input: Record<string, unknown>, model: ContentModel, contentRoot: string) {
	const placement = record(input.placement);
	const configuredPath = text(placement.path).replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\.mdx?$/iu, '');
	if (!configuredPath) return placement;
	const probe = renderContentRecord({
		model,
		slug: contentSlug(input) || 'content-record',
		title: text(input.title) || 'Content record',
		contentRoot,
	});
	const canonicalPrefix = `${contentRoot}/${probe.collection}/`;
	return configuredPath.startsWith(canonicalPrefix)
		? { ...placement, path: configuredPath.slice(canonicalPrefix.length) }
		: placement;
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
				placement: modelRelativePlacement(input, contentModel, contentRoot),
				contentRoot,
			});
			const descriptorMetadata = record(descriptor.metadata);
			const assignedAgentPath = contentModel === 'agent'
				&& contentSlug(input) === text(descriptorMetadata.agentSlug)
				? text(descriptorMetadata.agentContentPath)
				: '';
			const explicitPath = text(input.path) || assignedAgentPath;
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
			placement: modelRelativePlacement(input, contentModel, contentRoot),
			contentRoot,
		});
		let rendered = initial;
		let originalContent: string | null = null;
		if (action === 'update' || action === 'link') {
			const existing = await readModelContentFile(options, descriptor, initial.path);
			originalContent = responseContent(existing.result);
			rendered = renderContentRecord({
				model: contentModel,
				slug: contentSlug(input) || undefined,
				title: text(input.title) || undefined,
				fields: record(input.fields),
				body: typeof input.body === 'string' ? input.body : undefined,
				relations: relations as never,
				placement: modelRelativePlacement(input, contentModel, contentRoot),
				contentRoot,
				existingContent: originalContent,
			});
		}
		if (action === 'validate') {
			const placement = record(input.placement);
			const proposedRecord = typeof input.body === 'string'
				|| Boolean(text(input.title))
				|| Object.keys(record(input.fields)).length > 0;
			const existing = text(placement.path) && !proposedRecord
				? await readModelContentFile(options, descriptor, rendered.path)
				: null;
			const validation = validateContentRecord(contentModel, existing ? responseContent(existing.result) : rendered.content);
			if (!validation.ok) {
				return structuredError('content_validation_failed', 'Content validation failed.', { diagnostics: validation.diagnostics });
			}
			if (contentModel === 'proposal') {
				const proposal = validateProposalContentForSubmission(existing ? responseContent(existing.result) : rendered.content);
				if (!proposal.ok) return structuredError('proposal_plan_incomplete', 'Agent proposal is missing required planning evidence.', { diagnostics: proposal.diagnostics });
			}
			return { ok: true, action, refs: [{ ...rendered.ref, ...(existing ? { path: existing.path } : {}) }], diagnostics: validation.diagnostics };
		}
		if (action === 'create' || action === 'update' || action === 'link') {
			const changeset = await applyWorkspaceFileChange(options, descriptor, rendered.path, originalContent, rendered.content);
			const readback = await readWorkspaceFile(options, descriptor, rendered.path).catch(() => null);
			if (readback) {
				const content = responseContent(readback) || rendered.content;
				const validation = validateContentRecord(contentModel, content);
				if (!validation.ok) {
					return structuredError('content_readback_failed', 'Content readback validation failed.', { diagnostics: validation.diagnostics });
				}
				if (contentModel === 'proposal') {
					const proposal = validateProposalContentForSubmission(content);
					if (!proposal.ok) return structuredError('proposal_plan_incomplete', 'Agent proposal is missing required planning evidence.', { diagnostics: proposal.diagnostics });
				}
			}
			return {
				ok: true,
				action,
				refs: [rendered.ref],
				changedPaths: [rendered.path],
				changeset,
				diagnostics: rendered.diagnostics,
			};
		}
		return structuredError('tool_not_implemented', `${options.descriptor.id} content action is not implemented.`, { action });
	} catch (error) {
		const code = action === 'query' || action === 'read' ? 'content_readback_failed' : 'content_write_failed';
		return structuredError(code, error instanceof Error ? error.message : String(error), { action, model: contentModel });
	}
}
