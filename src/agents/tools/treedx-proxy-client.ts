import type { TreeDxProxyExecutionToolDescriptor } from '../runtime-types.ts';
import {
	TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS,
	type TreeDxProxyToolName,
} from './treedx-proxy-tool.ts';

export interface TreeDxProxyToolCallOptions {
	apiBaseUrl: string;
	providerApiKey: string;
	assignmentId: string;
	handleId: string;
	descriptor: TreeDxProxyExecutionToolDescriptor;
	toolName: TreeDxProxyToolName;
	input?: Record<string, unknown>;
	fetchImpl?: typeof fetch;
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
			case 'treedx.write_workspace_file':
				return descriptor.routes.writeWorkspaceFile;
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
			return { query: input.query, paths: input.paths };
		case 'treedx.read_repository_files':
			return { paths: input.paths, ref: input.ref };
		case 'treedx.search_workspace':
			return { query: input.query };
		case 'treedx.write_workspace_file':
			return { content: input.content };
		case 'treedx.commit_workspace':
			return { message: input.message };
		case 'treedx.read_workspace_file':
			return null;
		default:
			return null;
	}
}

export async function callTreeDxProxyTool(options: TreeDxProxyToolCallOptions) {
	if (!options.apiBaseUrl.trim()) throw new Error('TreeSeed API base URL is required for TreeDX proxy tools.');
	if (!options.providerApiKey.trim()) throw new Error('Capacity provider API key is required for TreeDX proxy tools.');
	if (!options.assignmentId.trim()) throw new Error('Assignment id is required for TreeDX proxy tools.');
	if (!options.handleId.trim()) throw new Error('TreeDX proxy handle id is required for TreeDX proxy tools.');
	const input = options.input ?? {};
	assertAllowedOperation(options.descriptor, options.toolName);
	assertAllowedPath(options.descriptor, options.toolName, input);
	const route = resolveRoute(options.descriptor, options.toolName, input);
	const body = requestBody(options.toolName, input);
	const response = await (options.fetchImpl ?? fetch)(`${options.apiBaseUrl.replace(/\/$/u, '')}${route.path}`, {
		method: route.method,
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			authorization: `Bearer ${options.providerApiKey}`,
			'x-treeseed-assignment-id': options.assignmentId,
			'x-treeseed-treedx-proxy-handle-id': options.handleId,
		},
		body: body == null ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(text || `TreeDX proxy request failed with ${response.status}.`);
	}
	return text ? JSON.parse(text) : {};
}
