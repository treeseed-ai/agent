export const TREE_DX_PROXY_TOOL_NAMES = [
	'treedx_build_context',
	'treedx_read_repository_files',
	'treedx_search_workspace',
	'treedx_read_workspace_file',
	'treedx_write_workspace_file',
	'treedx_commit_workspace',
] as const;

export type TreeDxProxyToolName = typeof TREE_DX_PROXY_TOOL_NAMES[number];

export const TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS: Record<TreeDxProxyToolName, string[]> = {
	treedx_build_context: ['files:read'],
	treedx_read_repository_files: ['files:read'],
	treedx_search_workspace: ['files:search'],
	treedx_read_workspace_file: ['files:read'],
	treedx_write_workspace_file: ['files:write'],
	treedx_commit_workspace: ['git:commit'],
};

export const TREE_DX_PROXY_TOOL_INPUT_SCHEMAS: Record<TreeDxProxyToolName, Record<string, unknown>> = {
	treedx_build_context: {
		type: 'object',
		properties: {
			repoId: { type: 'string' },
			query: { type: 'string' },
			paths: { type: 'array', items: { type: 'string' } },
		},
		additionalProperties: false,
	},
	treedx_read_repository_files: {
		type: 'object',
		properties: {
			repoId: { type: 'string' },
			paths: { type: 'array', items: { type: 'string' } },
			ref: { type: 'string' },
		},
		required: ['paths'],
		additionalProperties: false,
	},
	treedx_search_workspace: {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			query: { type: 'string' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	treedx_read_workspace_file: {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			path: { type: 'string' },
		},
		required: ['path'],
		additionalProperties: false,
	},
	treedx_write_workspace_file: {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			path: { type: 'string' },
			content: { type: 'string' },
		},
		required: ['path', 'content'],
		additionalProperties: false,
	},
	treedx_commit_workspace: {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			message: { type: 'string' },
		},
		required: ['message'],
		additionalProperties: false,
	},
};
