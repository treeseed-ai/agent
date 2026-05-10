export const CONTENT_RESOURCES = [
	'pages',
	'notes',
	'questions',
	'objectives',
	'proposals',
	'decisions',
	'people',
	'agents',
	'books',
	'templates',
	'knowledge_packs',
	'workdays',
] as const;

export const PLATFORM_RESOURCES = [
	'users',
	'roles',
	'api_tokens',
	'services',
	'jobs',
	'audit',
	'auth',
	'sdk',
	'agent',
	'operations',
] as const;

export const ALL_PERMISSION_RESOURCES = [...CONTENT_RESOURCES, ...PLATFORM_RESOURCES] as const;

export type PermissionResource = (typeof ALL_PERMISSION_RESOURCES)[number];
export type PermissionAction = 'read' | 'create' | 'update' | 'delete' | 'manage' | 'execute' | 'impersonate';
export type PermissionScope = 'self' | 'global';

export interface PermissionDefinition {
	key: string;
	resource: PermissionResource | '*';
	action: PermissionAction | '*';
	scope: PermissionScope | '*';
	description: string;
}

export interface RoleDefinition {
	key: string;
	description: string;
	permissions: string[];
}

export function permissionKey(resource: PermissionDefinition['resource'], action: PermissionDefinition['action'], scope: PermissionDefinition['scope']) {
	return `${resource}:${action}:${scope}`;
}

function contentPermission(resource: PermissionResource, action: PermissionAction, scope: PermissionScope, description: string): PermissionDefinition {
	return {
		key: permissionKey(resource, action, scope),
		resource,
		action,
		scope,
		description,
	};
}

const permissionDefinitions: PermissionDefinition[] = [
	{
		key: permissionKey('*', '*', '*'),
		resource: '*',
		action: '*',
		scope: '*',
		description: 'Full platform access.',
	},
	contentPermission('auth', 'read', 'self', 'Read the authenticated principal.'),
	contentPermission('api_tokens', 'read', 'self', 'List personal API tokens.'),
	contentPermission('api_tokens', 'create', 'self', 'Create personal API tokens.'),
	contentPermission('api_tokens', 'delete', 'self', 'Revoke personal API tokens.'),
	contentPermission('services', 'impersonate', 'global', 'Allow trusted web and service impersonation flows.'),
	contentPermission('services', 'manage', 'global', 'Manage service credentials and internal service auth.'),
	contentPermission('users', 'read', 'global', 'Read user records.'),
	contentPermission('users', 'manage', 'global', 'Manage user records.'),
	contentPermission('roles', 'manage', 'global', 'Manage role assignments.'),
	contentPermission('audit', 'read', 'global', 'Read audit events.'),
	contentPermission('jobs', 'manage', 'global', 'Manage internal job and worker control surfaces.'),
	contentPermission('sdk', 'execute', 'global', 'Execute SDK routes.'),
	contentPermission('agent', 'execute', 'global', 'Execute agent routes.'),
	contentPermission('operations', 'execute', 'global', 'Execute workflow operation routes.'),
];

for (const resource of CONTENT_RESOURCES) {
	permissionDefinitions.push(
		contentPermission(resource, 'read', 'global', `Read ${resource}.`),
		contentPermission(resource, 'create', 'global', `Create ${resource}.`),
		contentPermission(resource, 'update', 'global', `Update ${resource}.`),
		contentPermission(resource, 'delete', 'global', `Delete ${resource}.`),
	);
}

export const DEFAULT_PERMISSIONS = permissionDefinitions;

export const DEFAULT_ROLES: RoleDefinition[] = [
	{
		key: 'platform_admin',
		description: 'Full platform administration.',
		permissions: [permissionKey('*', '*', '*')],
	},
	{
		key: 'market_admin',
		description: 'Manage market content and core operational surfaces.',
		permissions: [
			permissionKey('auth', 'read', 'self'),
			permissionKey('api_tokens', 'read', 'self'),
			permissionKey('api_tokens', 'create', 'self'),
			permissionKey('api_tokens', 'delete', 'self'),
			permissionKey('sdk', 'execute', 'global'),
			permissionKey('agent', 'execute', 'global'),
			permissionKey('operations', 'execute', 'global'),
			permissionKey('users', 'read', 'global'),
			permissionKey('audit', 'read', 'global'),
			permissionKey('jobs', 'manage', 'global'),
		],
	},
	{
		key: 'content_admin',
		description: 'Manage all content resources.',
		permissions: [
			permissionKey('auth', 'read', 'self'),
			permissionKey('api_tokens', 'read', 'self'),
			permissionKey('api_tokens', 'create', 'self'),
			permissionKey('api_tokens', 'delete', 'self'),
		],
	},
	{
		key: 'content_editor',
		description: 'Edit marketplace content.',
		permissions: [
			permissionKey('auth', 'read', 'self'),
			permissionKey('api_tokens', 'read', 'self'),
			permissionKey('api_tokens', 'create', 'self'),
			permissionKey('api_tokens', 'delete', 'self'),
		],
	},
	{
		key: 'member',
		description: 'Authenticated member with personal API tokens.',
		permissions: [
			permissionKey('auth', 'read', 'self'),
			permissionKey('api_tokens', 'read', 'self'),
			permissionKey('api_tokens', 'create', 'self'),
			permissionKey('api_tokens', 'delete', 'self'),
		],
	},
	{
		key: 'viewer',
		description: 'Read-only marketplace viewer.',
		permissions: [permissionKey('auth', 'read', 'self')],
	},
];

for (const role of DEFAULT_ROLES) {
	if (role.key === 'content_admin') {
		for (const resource of CONTENT_RESOURCES) {
			role.permissions.push(
				permissionKey(resource, 'read', 'global'),
				permissionKey(resource, 'create', 'global'),
				permissionKey(resource, 'update', 'global'),
				permissionKey(resource, 'delete', 'global'),
			);
		}
	}
	if (role.key === 'content_editor') {
		for (const resource of CONTENT_RESOURCES) {
			role.permissions.push(
				permissionKey(resource, 'read', 'global'),
				permissionKey(resource, 'create', 'global'),
				permissionKey(resource, 'update', 'global'),
			);
		}
	}
}

export function permissionGranted(granted: string[], required: string) {
	return granted.includes(permissionKey('*', '*', '*')) || granted.includes(required);
}
