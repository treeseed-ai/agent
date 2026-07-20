import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { D1DatabaseLike } from '@treeseed/sdk/types/cloudflare';
import type {
	ApiConfig,
	ApiCredential,
	ApiPrincipal,
	DeviceCodeApproveRequest,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	TokenRefreshRequest,
	TokenRefreshResponse,
	TrustedUserAssertionClaims,
	UserIdentityProfileInput,
} from '../types.ts';
import { DEFAULT_PERMISSIONS, DEFAULT_ROLES } from './rbac.ts';
import { createAccessToken, nextOpaqueToken, principalFromAccessTokenPayload, verifyAccessToken } from './tokens.ts';

export function approvalUrl(baseUrl: string, userCode?: string | null) {
	const url = new URL('/auth/device/approve', `${baseUrl.replace(/\/+$/u, '')}/`);
	if (userCode) {
		url.searchParams.set('user_code', userCode);
	}
	return url.toString();
}

const AUTH_SCHEMA_SQL = [
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT,
		username TEXT UNIQUE,
		display_name TEXT,
		status TEXT NOT NULL DEFAULT 'active',
		metadata_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS user_identities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_subject TEXT NOT NULL,
		email TEXT,
		email_verified INTEGER NOT NULL DEFAULT 0,
		profile_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject
		ON user_identities(provider, provider_subject)`,
	`CREATE TABLE IF NOT EXISTS roles (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL UNIQUE,
		description TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS permissions (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL UNIQUE,
		resource TEXT NOT NULL,
		action TEXT NOT NULL,
		scope TEXT NOT NULL,
		description TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS role_permissions (
		role_id TEXT NOT NULL,
		permission_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (role_id, permission_id),
		FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
		FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS user_role_bindings (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		role_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_role_bindings_user_role
		ON user_role_bindings(user_id, role_id)`,
	`CREATE TABLE IF NOT EXISTS api_tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		name TEXT NOT NULL,
		token_prefix TEXT NOT NULL,
		token_hash TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		expires_at TEXT,
		last_used_at TEXT,
		revoked_at TEXT,
		metadata_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id
		ON api_tokens(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix
		ON api_tokens(token_prefix)`,
	`CREATE TABLE IF NOT EXISTS service_credentials (
		id TEXT PRIMARY KEY,
		service_id TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		secret_hash TEXT NOT NULL,
		roles_json TEXT NOT NULL,
		permissions_json TEXT NOT NULL,
		revoked_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		last_used_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS auth_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		session_type TEXT NOT NULL,
		refresh_token_hash TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		revoked_at TEXT,
		data_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
	`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
		ON auth_sessions(user_id)`,
	`CREATE TABLE IF NOT EXISTS audit_events (
		id TEXT PRIMARY KEY,
		actor_type TEXT NOT NULL,
		actor_id TEXT,
		event_type TEXT NOT NULL,
		target_type TEXT,
		target_id TEXT,
		data_json TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_events_target
		ON audit_events(target_type, target_id)`,
	`CREATE TABLE IF NOT EXISTS device_codes (
		id TEXT PRIMARY KEY,
		device_code TEXT NOT NULL UNIQUE,
		user_code TEXT NOT NULL UNIQUE,
		requested_scopes_json TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		interval_seconds INTEGER NOT NULL,
		status TEXT NOT NULL,
		user_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
];

export type DeviceCodeRow = {
	id: string;
	device_code: string;
	user_code: string;
	requested_scopes_json: string;
	expires_at: string;
	interval_seconds: number;
	status: string;
	user_id: string | null;
};

export type UserRow = {
	id: string;
	email: string | null;
	username: string | null;
	display_name: string | null;
	status: string;
	metadata_json: string | null;
	created_at: string;
	updated_at: string;
};

export type PrincipalRecord = {
	principal: ApiPrincipal;
	userId: string;
};

export interface PersonalAccessTokenResult {
	id: string;
	token: string;
	prefix: string;
	name: string;
	expiresAt: string | null;
}

export interface ServiceCredentialResult {
	id: string;
	serviceId: string;
	secret: string;
}

export function now() {
	return new Date();
}

export function isoNow() {
	return now().toISOString();
}

export function addSeconds(date: Date, seconds: number) {
	return new Date(date.getTime() + seconds * 1000);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function stableHash(value: string, secret: string) {
	return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}

export function equalHash(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export abstract class D1AuthStoreCore {
	protected abstract upsertServiceCredential(input: { serviceId: string; name: string; secret: string; roles?: string[]; permissions?: string[] }): Promise<unknown>;

	protected initializationPromise: Promise<void> | null = null;

	constructor(
		protected readonly config: ApiConfig,
		protected readonly db: D1DatabaseLike,
	) {}

	protected async run(query: string, params: unknown[] = []) {
		await this.db.prepare(query).bind(...params).run();
	}

	protected async first<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
		return this.db.prepare(query).bind(...params).first<T>();
	}

	protected async all<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
		const result = await this.db.prepare(query).bind(...params).all<T>();
		return result.results ?? [];
	}

	protected ensureInitialized() {
		if (!this.initializationPromise) {
			this.initializationPromise = this.ensureAuthSchema()
				.then(() => this.seedCatalog())
				.then(() => this.seedConfiguredServices());
		}
		return this.initializationPromise;
	}

	protected async ensureAuthSchema() {
		for (const statement of AUTH_SCHEMA_SQL) await this.run(statement);
		const result = await this.db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
		const columns = new Set((result.results ?? []).map((row) => row.name));
		if (!columns.has('username')) {
			await this.run('ALTER TABLE users ADD COLUMN username TEXT');
		}
		await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
	}

	protected async seedCatalog() {
		const createdAt = isoNow();
		const seeded = await this.first<{ key: string }>(
			`SELECT key FROM permissions WHERE key = '*:*:*' LIMIT 1`,
		);
		const adminRole = await this.first<{ key: string }>(
			`SELECT key FROM roles WHERE key = 'platform_admin' LIMIT 1`,
		);
		if (seeded?.key && adminRole?.key) {
			return;
		}
		for (const permission of DEFAULT_PERMISSIONS) {
			await this.run(
				`INSERT OR IGNORE INTO permissions (id, key, resource, action, scope, description, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), permission.key, permission.resource, permission.action, permission.scope, permission.description, createdAt],
			);
		}
		for (const role of DEFAULT_ROLES) {
			await this.run(
				`INSERT OR IGNORE INTO roles (id, key, description, created_at)
				 VALUES (?, ?, ?, ?)`,
				[randomUUID(), role.key, role.description, createdAt],
			);
			const roleRow = await this.first<{ id: string }>(`SELECT id FROM roles WHERE key = ?`, [role.key]);
			if (!roleRow) continue;
			for (const permissionKey of role.permissions) {
				const permissionRow = await this.first<{ id: string }>(`SELECT id FROM permissions WHERE key = ?`, [permissionKey]);
				if (permissionRow) {
					await this.run(
						`INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
						 VALUES (?, ?, ?)`,
						[roleRow.id, permissionRow.id, createdAt],
					);
				}
			}
		}
	}

	protected async seedConfiguredServices() {
		if (!this.config.webServiceSecret) return;
		await this.upsertServiceCredential({
			serviceId: this.config.webServiceId,
			name: 'Trusted web tier',
			secret: this.config.webServiceSecret,
			roles: ['market_admin'],
			permissions: ['services:impersonate:global'],
		});
	}

	protected async loadUser(userId: string) {
		return this.first<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
	}

	protected async loadIdentityByProvider(provider: string, providerSubject: string) {
		return this.first<{ id: string; user_id: string; email: string | null; profile_json: string | null }>(
			`SELECT * FROM user_identities WHERE provider = ? AND provider_subject = ?`,
			[provider, providerSubject],
		);
	}

	protected async loadUserByVerifiedEmail(email: string) {
		return this.first<UserRow>(
			`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1`,
			[email],
		);
	}

	protected async loadUserByUsername(username: string) {
		return this.first<UserRow>(
			`SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND status = 'active' LIMIT 1`,
			[username],
		);
	}

	protected canAdoptUsernameMatch(identity: UserIdentityProfileInput, user: UserRow | null) {
		if (!user?.id || !identity.username) return false;
		const profile = identity.profile && typeof identity.profile === 'object' ? identity.profile : {};
		if (identity.provider === 'acceptance' || profile.acceptance === true) return true;
		const existingEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
		const requestedEmail = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
		return Boolean(requestedEmail && existingEmail && requestedEmail === existingEmail && identity.emailVerified);
	}

	protected async rolesForUser(userId: string) {
		const rows = await this.all<{ key: string }>(
			`SELECT roles.key AS key
			 FROM user_role_bindings
			 INNER JOIN roles ON roles.id = user_role_bindings.role_id
			 WHERE user_role_bindings.user_id = ?`,
			[userId],
		);
		return rows.map((row) => row.key);
	}

	protected async permissionsForUser(userId: string) {
		const rows = await this.all<{ key: string }>(
			`SELECT DISTINCT permissions.key AS key
			 FROM user_role_bindings
			 INNER JOIN role_permissions ON role_permissions.role_id = user_role_bindings.role_id
			 INNER JOIN permissions ON permissions.id = role_permissions.permission_id
			 WHERE user_role_bindings.user_id = ?`,
			[userId],
		);
		return rows.map((row) => row.key);
	}

	protected async permissionsForRoles(roleKeys: string[]) {
		if (roleKeys.length === 0) {
			return [];
		}
		const placeholders = roleKeys.map(() => '?').join(', ');
		const rows = await this.all<{ key: string }>(
			`SELECT DISTINCT permissions.key AS key
			 FROM roles
			 INNER JOIN role_permissions ON role_permissions.role_id = roles.id
			 INNER JOIN permissions ON permissions.id = role_permissions.permission_id
			 WHERE roles.key IN (${placeholders})`,
			roleKeys,
		);
		return rows.map((row) => row.key);
	}

	protected scopesForPrincipal(permissions: string[]) {
		const scopes = new Set<string>(['auth:me']);
		if (permissions.includes('*:*:*') || permissions.includes('sdk:execute:global')) scopes.add('sdk');
		if (permissions.includes('*:*:*') || permissions.includes('agent:execute:global')) scopes.add('agent');
		if (permissions.includes('*:*:*') || permissions.includes('operations:execute:global')) scopes.add('operations');
		return [...scopes];
	}

	protected async principalForUser(userId: string): Promise<PrincipalRecord> {
		const user = await this.loadUser(userId);
		if (!user) {
			throw new Error(`Unknown user "${userId}".`);
		}
		const roles = await this.rolesForUser(userId);
		const permissions = await this.permissionsForUser(userId);
		return {
			userId,
			principal: {
				id: user.id,
				displayName: user.display_name ?? undefined,
				roles,
				permissions,
				scopes: this.scopesForPrincipal(permissions),
				metadata: {
					...parseJson(user.metadata_json, {}),
					username: user.username ?? undefined,
				},
			},
		};
	}

	protected async assignRole(userId: string, roleKey: string) {
		const role = await this.first<{ id: string }>(`SELECT id FROM roles WHERE key = ?`, [roleKey]);
		if (!role) return;
		await this.run(
			`INSERT OR IGNORE INTO user_role_bindings (id, user_id, role_id, created_at)
			 VALUES (?, ?, ?, ?)`,
			[randomUUID(), userId, role.id, isoNow()],
		);
	}

	protected async replaceRoles(userId: string, roleKeys: string[]) {
		await this.run(`DELETE FROM user_role_bindings WHERE user_id = ?`, [userId]);
		for (const roleKey of roleKeys) {
			await this.assignRole(userId, roleKey);
		}
	}

	protected async bootstrapRolesForUser(userId: string, identity: UserIdentityProfileInput) {
		await this.assignRole(userId, 'member');
		if ((await this.rolesForUser(userId)).includes('platform_admin')) return;
		const allowlist = this.config.bootstrapAdminAllowlist;
		const email = identity.email?.trim().toLowerCase() ?? '';
		const providerSubject = `${identity.provider}:${identity.providerSubject}`;
		if (allowlist.includes(email) || allowlist.includes(providerSubject)) {
			await this.assignRole(userId, 'platform_admin');
			await this.writeAuditEvent({
				actorType: 'system',
				actorId: null,
				eventType: 'auth.bootstrap_admin',
				targetType: 'user',
				targetId: userId,
				data: { matched: allowlist.includes(providerSubject) ? providerSubject : email },
			});
		}
	}

	protected async writeAuditEvent(input: {
		actorType: string;
		actorId: string | null;
		eventType: string;
		targetType: string | null;
		targetId: string | null;
		data?: Record<string, unknown>;
	}) {
		await this.run(
			`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				randomUUID(),
				input.actorType,
				input.actorId,
				input.eventType,
				input.targetType,
				input.targetId,
				JSON.stringify(input.data ?? {}),
				isoNow(),
			],
		);
	}

	protected userMetadata(identity: UserIdentityProfileInput, existingUsername: string | null = null) {
		const profile = identity.profile ?? {};
		return {
			emailVerified: identity.emailVerified ?? false,
			authProvider: identity.provider,
			username: identity.username ?? existingUsername,
			firstName: typeof profile.firstName === 'string' ? profile.firstName : null,
			lastName: typeof profile.lastName === 'string' ? profile.lastName : null,
		};
	}
}

