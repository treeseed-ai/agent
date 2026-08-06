import type { TreeDxProxyExecutionToolDescriptor } from '../runtime/runtime-types.ts';
import {
	TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS,
	type TreeDxProxyToolName,
} from './treedx-proxy-tool.ts';

export interface TreeDxProxyToolCallOptions {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	handleId: string;
	descriptor: TreeDxProxyExecutionToolDescriptor;
	toolName: TreeDxProxyToolName;
	input?: Record<string, unknown>;
	fetchImpl?: typeof fetch;
}

const RETRYABLE_READ_TOOLS = new Set<TreeDxProxyToolName>([
	'treedx.build_context',
	'treedx.read_repository_files',
	'treedx.search_workspace',
	'treedx.read_workspace_file',
]);

function transientProxyFailure(error: unknown) {
	return /fetch failed|timed out|econnreset|econnrefused|socket|temporarily unavailable/iu.test(error instanceof Error ? error.message : String(error));
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

function assertAllowedOperation(descriptor: TreeDxProxyExecutionToolDescriptor, toolName: TreeDxProxyToolName) {
	const missing = TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS[toolName].filter((operation) => !descriptor.allowedOperations.includes(operation));
	if (missing.length) {
		throw new Error(`TreeDX proxy operation denied: ${missing.join(', ')}.`);
	}
}

function assertAllowedPath(descriptor: TreeDxProxyExecutionToolDescriptor, toolName: TreeDxProxyToolName, input: Record<string, unknown>) {
	const path = typeof input.path === 'string' ? input.path : null;
	const paths = Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === 'string') : [];
	const candidates = path ? [path] : paths;
	const operations = TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS[toolName] ?? [];
	const writeOperation = operations.some((operation) => operation === 'files:write' || operation === 'git:commit');
	const scopedPaths = writeOperation
		? (descriptor.allowedWritePaths?.length ? descriptor.allowedWritePaths : descriptor.allowedPaths)
		: (descriptor.allowedReadPaths?.length ? descriptor.allowedReadPaths : descriptor.allowedPaths);
	if (!candidates.length || !scopedPaths.length) return;
	for (const candidate of candidates) {
		if (!scopedPaths.some((pattern) => matchesPath(candidate, pattern))) {
			throw new Error(`TreeDX proxy path denied: ${candidate}.`);
		}
	}
}

function resolveRoute(descriptor: TreeDxProxyExecutionToolDescriptor, toolName: TreeDxProxyToolName, input: Record<string, unknown>) {
	const repoId = encodeURIComponent(String(input.repoId ?? descriptor.repositoryId ?? ''));
	const workspaceId = encodeURIComponent(String(input.workspaceId ?? descriptor.workspaceId ?? ''));
	const path = encodeURIComponent(String(input.path ?? ''));
	const route = (() => {
		switch (toolName) {
			case 'treedx.build_context':
				return descriptor.routes.buildContext;
			case 'treedx.read_repository_files':
				return descriptor.routes.readRepositoryFiles;
			case 'treedx.search_workspace':
				return descriptor.routes.searchWorkspace;
			case 'treedx.read_workspace_file':
				return descriptor.routes.readWorkspaceFile;
			case 'treedx.apply_workspace_changeset':
				return descriptor.routes.applyWorkspaceChangeset;
			case 'treedx.commit_workspace':
				return descriptor.routes.commitWorkspace;
			default:
				throw new Error(`Unsupported TreeDX tool: ${toolName}`);
		}
	})().replace(/:repoId/gu, repoId).replace(/:workspaceId/gu, workspaceId).replace(/:path/gu, path);
	const separator = route.indexOf(' ');
	if (separator < 0) throw new Error(`Invalid TreeDX route template for ${toolName}.`);
	return {
		method: route.slice(0, separator),
		path: route.slice(separator + 1),
	};
}

function requestBody(toolName: TreeDxProxyToolName, input: Record<string, unknown>) {
	switch (toolName) {
		case 'treedx.build_context':
			return {
				query: input.query,
				paths: input.paths,
				budget: {
					maxNodes: Math.max(1, Math.min(64, Number(input.maxNodes) || 16)),
					maxTokens: Math.max(256, Math.min(12_000, Number(input.maxTokens) || 4_000)),
				},
			};
		case 'treedx.read_repository_files':
			return {
				paths: input.paths,
				ref: input.ref,
				maxBytes: Math.max(1, Math.min(196_608, Number(input.maxBytes) || 131_072)),
				offsetBytes: Math.max(0, Number(input.offsetBytes) || 0),
			};
		case 'treedx.search_workspace':
			return { query: input.query };
		case 'treedx.apply_workspace_changeset':
			return input;
		case 'treedx.commit_workspace':
			return { message: input.message };
		case 'treedx.read_workspace_file':
			return null;
		default:
			return null;
	}
}

export async function callTreeDxProxyTool(options: TreeDxProxyToolCallOptions): Promise<Record<string, unknown>> {
	if (!options.apiBaseUrl.trim()) throw new Error('TreeSeed API base URL is required for TreeDX proxy tools.');
	if (!options.providerAccessToken.trim()) throw new Error('Capacity provider access token is required for TreeDX proxy tools.');
	if (!options.assignmentId.trim()) throw new Error('Assignment id is required for TreeDX proxy tools.');
	if (!options.handleId.trim()) throw new Error('TreeDX proxy handle id is required for TreeDX proxy tools.');
	const input = options.input ?? {};
	assertAllowedOperation(options.descriptor, options.toolName);
	assertAllowedPath(options.descriptor, options.toolName, input);
	const paths = Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === 'string') : [];
	if (options.toolName === 'treedx.read_repository_files' && paths.length > 1) {
		const responses = await Promise.all(paths.map((path) => callTreeDxProxyTool({
			...options,
			input: { ...input, paths: [path] },
		})));
		const first = responses[0] as Record<string, unknown>;
		const payload = first.payload && typeof first.payload === 'object' && !Array.isArray(first.payload)
			? first.payload as Record<string, unknown>
			: {};
		const files = responses.flatMap((response) => {
			const entry = response as Record<string, unknown>;
			const body = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
				? entry.payload as Record<string, unknown>
				: {};
			return Array.isArray(body.files) ? body.files : body.file ? [body.file] : [];
		});
		return { ...first, payload: { ...payload, files, file: files[0] ?? null } };
	}
	const route = resolveRoute(options.descriptor, options.toolName, input);
	const body = requestBody(options.toolName, input);
	const maxAttempts = RETRYABLE_READ_TOOLS.has(options.toolName) ? 3 : 1;
	let lastError: unknown = new Error('TreeDX proxy request was not attempted.');
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const response = await (options.fetchImpl ?? fetch)(`${options.apiBaseUrl.replace(/\/$/u, '')}${route.path}`, {
				method: route.method,
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					authorization: `Bearer ${options.providerAccessToken}`,
					'x-treeseed-assignment-id': options.assignmentId,
					'x-treeseed-treedx-proxy-handle-id': options.handleId,
				},
				body: body == null ? undefined : JSON.stringify(body),
			});
			const responseText = await response.text();
			if (!response.ok) {
				const error = Object.assign(new Error(responseText || `TreeDX proxy request failed with ${response.status}.`), { status: response.status, operation: options.toolName, path: route.path });
				if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) throw error;
				return Promise.reject(error);
			}
			return responseText ? JSON.parse(responseText) : {};
		} catch (error) {
			lastError = error;
			const status = Number((error as { status?: unknown })?.status);
			const transient = transientProxyFailure(error) || status === 429 || status >= 500;
			if (!transient || attempt === maxAttempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
		}
	}
	throw lastError;
}
