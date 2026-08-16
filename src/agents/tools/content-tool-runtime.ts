import { createHash } from 'node:crypto';
import {
	findContentToolPreset,
	renderContentRecord,
	validateContentRecord,
	validateProposalContentForSubmission,
	type ContentAction,
	type ContentModel,
} from '@treeseed/sdk/content-operations';
import { describeContentFrontmatterContract, isPortableContentModel } from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { createUnifiedChangeset } from '@treeseed/sdk/treedx';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../runtime/runtime-types.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';
import { validateContentRelationTargets } from './content/relation-validation.ts';

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

function contentPermissionDenial(
	descriptor: TreeDxProxyExecutionToolDescriptor,
	action: ContentAction,
	model: ContentModel | undefined,
) {
	const summary = record(descriptor.metadata?.permissionSummary);
	if (!Object.keys(summary).length) return null;
	if (action === 'commit') {
		return summary.commitAllowed === true ? null : structuredError(
			'content_model_operation_denied',
			'Content commit is outside the immutable assignment permission snapshot.',
			{ action, model: null },
		);
	}
	const readAction = ['describe', 'query', 'read'].includes(action);
	const allowedActions = Array.isArray(summary[readAction ? 'readActions' : 'writeActions'])
		? (summary[readAction ? 'readActions' : 'writeActions'] as unknown[]).map(String)
		: [];
	const allowedModels = Array.isArray(summary[readAction ? 'readModels' : 'writeModels'])
		? (summary[readAction ? 'readModels' : 'writeModels'] as unknown[]).map(String)
		: [];
	if (allowedActions.includes(action) && model && (allowedModels.includes('*') || allowedModels.includes(model))) return null;
	return structuredError(
		'content_model_operation_denied',
		`Content ${action} for ${model || '(missing model)'} is outside the immutable assignment permission snapshot.`,
		{ action, model: model ?? null, allowedActions, allowedModels },
	);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([key]) => key !== 'updated_at' && key !== 'updatedAt')
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => [key, stableValue(entry)]));
}

function sameLogicalContent(existing: string, requested: string) {
	const current = parseFrontmatterDocument(existing);
	const desired = parseFrontmatterDocument(requested);
	return JSON.stringify(stableValue(current.frontmatter)) === JSON.stringify(stableValue(desired.frontmatter))
		&& current.body.trim() === desired.body.trim();
}

function proposalTypePreflight(
	descriptor: TreeDxProxyExecutionToolDescriptor,
	frontmatter: Record<string, unknown>,
) {
	const allowed = Array.isArray(descriptor.metadata?.allowedProposalTypes)
		? [...new Set(descriptor.metadata.allowedProposalTypes.map(String).filter(Boolean))]
		: [];
	if (!allowed.length) return null;
	const declared = [
		...(Array.isArray(frontmatter.proposalTypes) ? frontmatter.proposalTypes : []),
		...(Array.isArray(frontmatter.proposal_types) ? frontmatter.proposal_types : []),
		frontmatter.proposalType,
		frontmatter.proposal_type,
	].filter((value) => value !== undefined && value !== null && value !== '').map(String);
	const unsupported = [...new Set(declared)].filter((value) => !allowed.includes(value));
	return unsupported.length ? structuredError(
		'proposal_type_not_allowed',
		'Proposal types are outside the immutable assignment contract.',
		{ field: 'proposalTypes', unsupported, allowedProposalTypes: allowed },
	) : null;
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

function collectContentPaths(value: unknown, paths = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const entry of value) collectContentPaths(entry, paths);
		return paths;
	}
	if (!value || typeof value !== 'object') return paths;
	for (const [key, entry] of Object.entries(value as Record<string,unknown>)) {
		if (typeof entry === 'string' && ['path','contentPath','filePath'].includes(key)) {
			const normalized = entry.replace(/\\/gu, '/').replace(/^\.\//u, '');
			if (/\.mdx?$/iu.test(normalized)) paths.add(normalized);
		} else collectContentPaths(entry, paths);
	}
	return paths;
}

async function resolveModelContentPath(
	options: ContentToolCallOptions,
	descriptor: TreeDxProxyExecutionToolDescriptor,
	canonicalPath: string,
	slug: string,
) {
	const result = await callTreeDxProxyTool({
		apiBaseUrl: options.apiBaseUrl,
		providerAccessToken: options.providerAccessToken,
		assignmentId: options.assignmentId,
		handleId: descriptor.handleId,
		descriptor,
		toolName: 'treedx.search_workspace',
		input: { query: slug },
		fetchImpl: options.fetchImpl,
	});
	const collectionRoot = canonicalPath.slice(0, canonicalPath.lastIndexOf('/'));
	const matches = [...collectContentPaths(result)].filter((path) => path.startsWith(`${collectionRoot}/`)
		&& path.replace(/\.mdx?$/iu, '').split('/').at(-1) === slug);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw Object.assign(new Error(`Content identity ${slug} resolves to multiple current repository paths.`), {
		code: 'content_identity_ambiguous', paths: matches,
	});
	return null;
}

async function relationDiagnostics(options: ContentToolCallOptions, descriptor: TreeDxProxyExecutionToolDescriptor, frontmatter: Record<string, unknown>, contentRoot: string) {
	return validateContentRelationTargets(frontmatter, async ({ targetModel, targetId }) => {
		if (!descriptor.routes.searchWorkspace) throw Object.assign(new Error('Content relation validation requires TreeDX workspace search.'), { code: 'content_relation_verification_unavailable' });
		const slug = targetId.includes(':') ? targetId.split(':').at(-1)! : targetId;
		if (!targetModel || !isPortableContentModel(targetModel)) throw Object.assign(new Error(`Content relation target model ${targetModel || '(missing)'} is not portable.`), { code: 'content_relation_model_invalid' });
		const query = targetId.includes(':') ? targetId : `${targetModel}:${slug}`;
		const result = await callTreeDxProxyTool({
			apiBaseUrl: options.apiBaseUrl, providerAccessToken: options.providerAccessToken, assignmentId: options.assignmentId,
			handleId: descriptor.handleId, descriptor, toolName: 'treedx.search_workspace', input: { query }, fetchImpl: options.fetchImpl,
		});
		const targetPath = renderContentRecord({ model: targetModel, slug, title: slug, contentRoot }).path;
		const targetCollectionRoot = targetPath.slice(0, targetPath.lastIndexOf('/'));
		const paths = [...collectContentPaths(result)].filter((path) => path.startsWith(`${targetCollectionRoot}/`));
		const records = await Promise.all(paths.map(async (path) => parseFrontmatterDocument(responseContent(await readWorkspaceFile(options, descriptor, path))).frontmatter));
		return {
			ids: records.flatMap((entry) => typeof entry.id === 'string' && entry.id.trim() ? [entry.id.trim()] : []),
			slugs: records.flatMap((entry, index) => typeof entry.slug === 'string' && entry.slug.trim() ? [entry.slug.trim()] : [paths[index]!.replace(/\.mdx?$/iu, '').split('/').at(-1)!]),
		};
	});
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

export function modelRelativePlacement(input: Record<string, unknown>, model: ContentModel, contentRoot: string) {
	const placement = record(input.placement);
	const configuredPath = text(placement.path).replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\.mdx?$/iu, '');
	if (!configuredPath) return placement;
	return { ...placement, path: configuredPath };
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
		const permissionDenial = contentPermissionDenial(descriptor, action, contentModel);
		if (permissionDenial) return permissionDenial;
		if (action === 'describe') {
			if (!contentModel || !isPortableContentModel(contentModel)) {
				return structuredError('content_model_unknown', 'Describe requires a supported content model.', { model: contentModel || null });
			}
			return {
				ok: true,
				action,
				refs: [],
				diagnostics: [],
				payload: {
					...describeContentFrontmatterContract(contentModel),
					message: 'This contract is derived from the canonical SDK validation schema. Use its exact fields and enum values for create and update operations.',
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
			let resolved: { path: string; result: unknown };
			if (explicitPath) resolved = { path: explicitPath, result: await readWorkspaceFile(options, descriptor, explicitPath) };
			else {
				try {
					resolved = await readModelContentFile(options, descriptor, rendered.path);
				} catch (canonicalError) {
					const resolvedPath = await resolveModelContentPath(options, descriptor, rendered.path, contentSlug(input)).catch((error) => {
						if (record(error).code === 'content_identity_ambiguous') throw error;
						return null;
					});
					if (!resolvedPath) throw canonicalError;
					resolved = { path: resolvedPath, result: await readWorkspaceFile(options, descriptor, resolvedPath) };
				}
			}
			const { path, result } = resolved;
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
		if (contentModel === 'proposal') {
			const semantic = proposalTypePreflight(descriptor, record(input.fields));
			if (semantic) return semantic;
		}
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
			const relationValidation = await relationDiagnostics(options, descriptor, parseFrontmatterDocument(existing ? responseContent(existing.result) : rendered.content).frontmatter, contentRoot);
			if (relationValidation.length) return structuredError('content_relation_invalid', 'Content relationship validation failed against the current assignment workspace.', { diagnostics: relationValidation });
			if (contentModel === 'proposal') {
				const semantic = proposalTypePreflight(descriptor, rendered.frontmatter);
				if (semantic) return semantic;
				const proposal = validateProposalContentForSubmission(existing ? responseContent(existing.result) : rendered.content);
				if (!proposal.ok) return structuredError('proposal_plan_incomplete', 'Agent proposal is missing required planning evidence.', { diagnostics: proposal.diagnostics });
			}
			return { ok: true, action, refs: [{ ...rendered.ref, ...(existing ? { path: existing.path } : {}) }], diagnostics: validation.diagnostics };
		}
		if (action === 'create' || action === 'update' || action === 'link') {
			const preflight = validateContentRecord(contentModel, rendered.content);
			if (!preflight.ok) {
				return structuredError('content_validation_failed', 'Content validation failed before any workspace mutation.', { diagnostics: preflight.diagnostics });
			}
			const relationValidation = await relationDiagnostics(options, descriptor, rendered.frontmatter, contentRoot);
			if (relationValidation.length) return structuredError('content_relation_invalid', 'Content relationship validation failed before any workspace mutation.', { diagnostics: relationValidation });
			if (contentModel === 'proposal') {
				const semantic = proposalTypePreflight(descriptor, rendered.frontmatter);
				if (semantic) return semantic;
				const proposal = validateProposalContentForSubmission(rendered.content);
				if (!proposal.ok) return structuredError('proposal_plan_incomplete', 'Agent proposal is missing required planning evidence.', { diagnostics: proposal.diagnostics });
			}
			if (action === 'create') {
				const existing = await readModelContentFile(options, descriptor, rendered.path).catch(() => null);
				const existingContent = existing ? responseContent(existing.result) : '';
				if (existingContent) {
					if (!sameLogicalContent(existingContent, rendered.content)) {
						return structuredError('content_create_conflict', 'Create target already exists with different content.', { path: rendered.path });
					}
					return {
						ok: true, action, refs: [rendered.ref], changedPaths: [rendered.path],
						idempotentReplay: true, diagnostics: rendered.diagnostics,
					};
				}
			}
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
		const reportedCode = text(record(error).code);
		const code = reportedCode || (action === 'query' || action === 'read' ? 'content_readback_failed' : 'content_write_failed');
		return structuredError(code, error instanceof Error ? error.message : String(error), {
			action, model: contentModel, ...(Array.isArray(record(error).paths) ? { paths: record(error).paths } : {}),
		});
	}
}
