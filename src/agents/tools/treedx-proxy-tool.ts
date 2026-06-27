export const TREE_DX_PROXY_TOOL_NAMES = [
	'treedx.build_context',
	'treedx.read_repository_files',
	'treedx.search_workspace',
	'treedx.read_workspace_file',
	'treedx.write_workspace_file',
	'treedx.commit_workspace',
] as const;

export type TreeDxProxyToolName = typeof TREE_DX_PROXY_TOOL_NAMES[number];

export const TREE_DX_PROXY_TOOL_REQUIRED_OPERATIONS: Record<TreeDxProxyToolName, string[]> = {
	'treedx.build_context': ['files:read'],
	'treedx.read_repository_files': ['files:read'],
	'treedx.search_workspace': ['files:search'],
	'treedx.read_workspace_file': ['files:read'],
	'treedx.write_workspace_file': ['files:write'],
	'treedx.commit_workspace': ['git:commit'],
};

export const TREE_DX_PROXY_TOOL_INPUT_SCHEMAS: Record<TreeDxProxyToolName, Record<string, unknown>> = {
	'treedx.build_context': {
		type: 'object',
		properties: {
			repoId: { type: 'string' },
			query: { type: 'string' },
			paths: { type: 'array', items: { type: 'string' } },
		},
		additionalProperties: false,
	},
	'treedx.read_repository_files': {
		type: 'object',
		properties: {
			repoId: { type: 'string' },
			paths: { type: 'array', items: { type: 'string' } },
			ref: { type: 'string' },
		},
		required: ['paths'],
		additionalProperties: false,
	},
	'treedx.search_workspace': {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			query: { type: 'string' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	'treedx.read_workspace_file': {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			path: { type: 'string' },
		},
		required: ['path'],
		additionalProperties: false,
	},
	'treedx.write_workspace_file': {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			path: { type: 'string' },
			content: { type: 'string' },
		},
		required: ['path', 'content'],
		additionalProperties: false,
	},
	'treedx.commit_workspace': {
		type: 'object',
		properties: {
			workspaceId: { type: 'string' },
			message: { type: 'string' },
		},
		required: ['message'],
		additionalProperties: false,
	},
};
