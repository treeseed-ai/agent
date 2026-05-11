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

type DeviceCodeRow = {
	id: string;
	device_code: string;
	user_code: string;
	requested_scopes_json: string;
	expires_at: string;
	interval_seconds: number;
	status: string;
	user_id: string | null;
};

type UserRow = {
	id: string;
	email: string | null;
	username: string | null;
	display_name: string | null;
	status: string;
	metadata_json: string | null;
	created_at: string;
	updated_at: string;
};

type PrincipalRecord = {
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

function now() {
	return new Date();
}

function isoNow() {
	return now().toISOString();
}

function addSeconds(date: Date, seconds: number) {
	return new Date(date.getTime() + seconds * 1000);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function stableHash(value: string, secret: string) {
	return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}

function equalHash(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class D1AuthStore {
	private initializationPromise: Promise<void> | null = null;

	constructor(
		private readonly config: ApiConfig,
		private readonly db: D1DatabaseLike,
	) {}

	private async run(query: string, params: unknown[] = []) {
		await this.db.prepare(query).bind(...params).run();
	}

	private async first<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
		return this.db.prepare(query).bind(...params).first<T>();
	}

	private async all<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
		const result = await this.db.prepare(query).bind(...params).all<T>();
		return result.results ?? [];
	}

	private ensureInitialized() {
		if (!this.initializationPromise) {
			this.initializationPromise = this.ensureAuthSchema()
				.then(() => this.seedCatalog())
				.then(() => this.seedConfiguredServices());
		}
		return this.initializationPromise;
	}

	private async ensureAuthSchema() {
		for (const statement of AUTH_SCHEMA_SQL) await this.run(statement);
		const result = await this.db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
		const columns = new Set((result.results ?? []).map((row) => row.name));
		if (!columns.has('username')) {
			await this.run('ALTER TABLE users ADD COLUMN username TEXT');
		}
		await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
	}

	private async seedCatalog() {
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

	private async seedConfiguredServices() {
		if (!this.config.webServiceSecret) return;
		await this.upsertServiceCredential({
			serviceId: this.config.webServiceId,
			name: 'Trusted web tier',
			secret: this.config.webServiceSecret,
			roles: ['market_admin'],
			permissions: ['services:impersonate:global'],
		});
	}

	private async loadUser(userId: string) {
		return this.first<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
	}

	private async loadIdentityByProvider(provider: string, providerSubject: string) {
		return this.first<{ id: string; user_id: string; email: string | null; profile_json: string | null }>(
			`SELECT * FROM user_identities WHERE provider = ? AND provider_subject = ?`,
			[provider, providerSubject],
		);
	}

	private async loadUserByVerifiedEmail(email: string) {
		return this.first<UserRow>(
			`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1`,
			[email],
		);
	}

	private async rolesForUser(userId: string) {
		const rows = await this.all<{ key: string }>(
			`SELECT roles.key AS key
			 FROM user_role_bindings
			 INNER JOIN roles ON roles.id = user_role_bindings.role_id
			 WHERE user_role_bindings.user_id = ?`,
			[userId],
		);
		return rows.map((row) => row.key);
	}

	private async permissionsForUser(userId: string) {
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

	private async permissionsForRoles(roleKeys: string[]) {
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

	private scopesForPrincipal(permissions: string[]) {
		const scopes = new Set<string>(['auth:me']);
		if (permissions.includes('*:*:*') || permissions.includes('sdk:execute:global')) scopes.add('sdk');
		if (permissions.includes('*:*:*') || permissions.includes('agent:execute:global')) scopes.add('agent');
		if (permissions.includes('*:*:*') || permissions.includes('operations:execute:global')) scopes.add('operations');
		return [...scopes];
	}

	private async principalForUser(userId: string): Promise<PrincipalRecord> {
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

	private async assignRole(userId: string, roleKey: string) {
		const role = await this.first<{ id: string }>(`SELECT id FROM roles WHERE key = ?`, [roleKey]);
		if (!role) return;
		await this.run(
			`INSERT OR IGNORE INTO user_role_bindings (id, user_id, role_id, created_at)
			 VALUES (?, ?, ?, ?)`,
			[randomUUID(), userId, role.id, isoNow()],
		);
	}

	private async replaceRoles(userId: string, roleKeys: string[]) {
		await this.run(`DELETE FROM user_role_bindings WHERE user_id = ?`, [userId]);
		for (const roleKey of roleKeys) {
			await this.assignRole(userId, roleKey);
		}
	}

	private async bootstrapRolesForUser(userId: string, identity: UserIdentityProfileInput) {
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

	private async writeAuditEvent(input: {
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

	private userMetadata(identity: UserIdentityProfileInput, existingUsername: string | null = null) {
		const profile = identity.profile ?? {};
		return {
			emailVerified: identity.emailVerified ?? false,
			authProvider: identity.provider,
			username: identity.username ?? existingUsername,
			firstName: typeof profile.firstName === 'string' ? profile.firstName : null,
			lastName: typeof profile.lastName === 'string' ? profile.lastName : null,
		};
	}

	async syncUser(identity: UserIdentityProfileInput) {
		await this.ensureInitialized();
		const nowIso = isoNow();
		const existingIdentity = await this.loadIdentityByProvider(identity.provider, identity.providerSubject);
		let userId = existingIdentity?.user_id;
		if (!userId) {
			const linkedUser = identity.email && identity.emailVerified ? await this.loadUserByVerifiedEmail(identity.email) : null;
			userId = linkedUser?.id ?? randomUUID();
			if (linkedUser) {
				await this.run(
					`UPDATE users
					 SET email = COALESCE(?, email),
					     username = COALESCE(username, ?),
					     display_name = COALESCE(?, display_name),
					     metadata_json = ?,
					     updated_at = ?
					 WHERE id = ?`,
					[
						identity.email ?? null,
						identity.username ?? null,
						identity.displayName ?? null,
						JSON.stringify(this.userMetadata(identity, linkedUser.username ?? null)),
						nowIso,
						userId,
					],
				);
			} else {
				await this.run(
					`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
					[
						userId,
						identity.email ?? null,
						identity.username ?? null,
						identity.displayName ?? null,
						JSON.stringify(this.userMetadata(identity)),
						nowIso,
						nowIso,
					],
				);
			}
			await this.run(
				`INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					userId,
					identity.provider,
					identity.providerSubject,
					identity.email ?? null,
					identity.emailVerified ? 1 : 0,
					JSON.stringify(identity.profile ?? {}),
					nowIso,
					nowIso,
				],
			);
		} else {
			await this.run(
				`UPDATE users
				 SET email = COALESCE(?, email),
				     username = COALESCE(username, ?),
				     display_name = COALESCE(?, display_name),
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`,
				[
					identity.email ?? null,
					identity.username ?? null,
					identity.displayName ?? null,
					JSON.stringify(this.userMetadata(identity)),
					nowIso,
					userId,
				],
			);
			await this.run(
				`UPDATE user_identities
				 SET email = ?, email_verified = ?, profile_json = ?, updated_at = ?
				 WHERE provider = ? AND provider_subject = ?`,
				[
					identity.email ?? null,
					identity.emailVerified ? 1 : 0,
					JSON.stringify(identity.profile ?? {}),
					nowIso,
					identity.provider,
					identity.providerSubject,
				],
			);
		}
		await this.bootstrapRolesForUser(userId, identity);
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_synced',
			targetType: 'user',
			targetId: userId,
			data: { provider: identity.provider },
		});
		const principal = await this.principalForUser(userId);
		const syncedIdentity = await this.loadIdentityByProvider(identity.provider, identity.providerSubject);
		return {
			...principal,
			identityId: syncedIdentity?.id ?? null,
		};
	}

	async createUser(input: { email?: string | null; username?: string | null; displayName?: string | null; metadata?: Record<string, unknown> }) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const userId = randomUUID();
		await this.run(
			`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
			[
				userId,
				input.email?.trim() || null,
				input.username?.trim().toLowerCase() || null,
				input.displayName?.trim() || null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.assignRole(userId, 'member');
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_created',
			targetType: 'user',
			targetId: userId,
			data: { source: 'admin' },
		});
		return this.principalForUser(userId);
	}

	async setUserRoles(userId: string, roles: string[]) {
		await this.ensureInitialized();
		const requestedRoles = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
		await this.replaceRoles(userId, requestedRoles.length > 0 ? requestedRoles : ['member']);
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.user_roles_set',
			targetType: 'user',
			targetId: userId,
			data: { roles: requestedRoles },
		});
		return this.principalForUser(userId);
	}

	async startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse> {
		await this.ensureInitialized();
		const current = now();
		const expiresAt = addSeconds(current, this.config.deviceCodeTtlSeconds);
		const deviceCode = nextOpaqueToken('device');
		const userCode = `${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
		await this.run(
			`INSERT INTO device_codes (id, device_code, user_code, requested_scopes_json, expires_at, interval_seconds, status, user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
			[
				randomUUID(),
				deviceCode,
				userCode,
				JSON.stringify(request.scopes?.length ? request.scopes : ['auth:me']),
				expiresAt.toISOString(),
				this.config.deviceCodePollIntervalSeconds,
				current.toISOString(),
				current.toISOString(),
			],
		);
		return {
			ok: true,
			deviceCode,
			userCode,
			verificationUri: `${this.config.baseUrl}/auth/device/approve`,
			verificationUriComplete: `${this.config.baseUrl}/auth/device/approve?user_code=${encodeURIComponent(userCode)}`,
			intervalSeconds: this.config.deviceCodePollIntervalSeconds,
			expiresAt: expiresAt.toISOString(),
			expiresInSeconds: this.config.deviceCodeTtlSeconds,
		};
	}

	async approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }> {
		await this.ensureInitialized();
		const row = await this.first<DeviceCodeRow>(`SELECT * FROM device_codes WHERE user_code = ?`, [request.userCode]);
		if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
			throw new Error('Device code approval failed because the user code is unknown or expired.');
		}
		let userId = request.principalId;
		if (!(await this.loadUser(userId))) {
			const createdAt = isoNow();
			await this.run(
				`INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at)
				 VALUES (?, NULL, ?, 'active', ?, ?, ?)`,
				[userId, request.displayName ?? null, JSON.stringify(request.metadata ?? {}), createdAt, createdAt],
			);
			await this.assignRole(userId, 'member');
		}
		await this.run(`UPDATE device_codes SET status = 'approved', user_id = ?, updated_at = ? WHERE id = ?`, [userId, isoNow(), row.id]);
		await this.writeAuditEvent({
			actorType: 'user',
			actorId: userId,
			eventType: 'auth.device_approved',
			targetType: 'device_code',
			targetId: row.id,
		});
		return { ok: true };
	}

	async pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
		await this.ensureInitialized();
		const row = await this.first<DeviceCodeRow>(`SELECT * FROM device_codes WHERE device_code = ?`, [request.deviceCode]);
		if (!row) {
			return { ok: false, status: 'invalid', error: 'Unknown device code.' };
		}
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			return { ok: false, status: 'expired', error: 'Device code expired.' };
		}
		if (row.status === 'pending' || !row.user_id) {
			return { ok: true, status: 'pending', intervalSeconds: row.interval_seconds };
		}
		if (row.status === 'used') {
			return { ok: false, status: 'already_used', error: 'Device code already used.' };
		}

		await this.run(`UPDATE device_codes SET status = 'used', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
		const principalRecord = await this.principalForUser(row.user_id);
		const refreshToken = nextOpaqueToken('refresh');
		const sessionId = randomUUID();
		const refreshTokenHash = stableHash(refreshToken, this.config.authSecret);
		const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
		const refreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
		await this.run(
			`INSERT INTO auth_sessions (id, user_id, session_type, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, 'device', ?, ?, ?, NULL, ?, ?, ?)`,
			[
				sessionId,
				row.user_id,
				refreshTokenHash,
				row.requested_scopes_json,
				refreshExpiresAt.toISOString(),
				JSON.stringify({ deviceCodeId: row.id }),
				isoNow(),
				isoNow(),
			],
		);
		const requestedScopes = parseJson<string[]>(row.requested_scopes_json, principalRecord.principal.scopes);
		const accessToken = createAccessToken({
			sub: principalRecord.principal.id,
			displayName: principalRecord.principal.displayName,
			scopes: requestedScopes,
			roles: principalRecord.principal.roles,
			permissions: principalRecord.principal.permissions,
			metadata: principalRecord.principal.metadata,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(expiresAt.getTime() / 1000),
			iss: this.config.issuer,
			jti: randomUUID(),
			tokenType: 'access',
		}, this.config.authSecret);
		return {
			ok: true,
			status: 'approved',
			accessToken,
			refreshToken,
			tokenType: 'Bearer',
			expiresAt: expiresAt.toISOString(),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: {
				...principalRecord.principal,
				scopes: requestedScopes,
			},
		};
	}

	async refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse> {
		await this.ensureInitialized();
		const refreshHash = stableHash(request.refreshToken, this.config.authSecret);
		const row = await this.first<{ id: string; user_id: string; scopes_json: string; expires_at: string }>(
			`SELECT * FROM auth_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
			[refreshHash],
		);
		if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
			throw new Error('Refresh token is invalid or expired.');
		}
		const principalRecord = await this.principalForUser(row.user_id);
		const nextRefreshToken = nextOpaqueToken('refresh');
		const nextRefreshHash = stableHash(nextRefreshToken, this.config.authSecret);
		const nextRefreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
		await this.run(
			`UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
			[nextRefreshHash, nextRefreshExpiresAt.toISOString(), isoNow(), row.id],
		);
		const requestedScopes = parseJson<string[]>(row.scopes_json, principalRecord.principal.scopes);
		const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
		const accessToken = createAccessToken({
			sub: principalRecord.principal.id,
			displayName: principalRecord.principal.displayName,
			scopes: requestedScopes,
			roles: principalRecord.principal.roles,
			permissions: principalRecord.principal.permissions,
			metadata: principalRecord.principal.metadata,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(expiresAt.getTime() / 1000),
			iss: this.config.issuer,
			jti: randomUUID(),
			tokenType: 'access',
		}, this.config.authSecret);
		return {
			ok: true,
			accessToken,
			refreshToken: nextRefreshToken,
			tokenType: 'Bearer',
			expiresAt: expiresAt.toISOString(),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: {
				...principalRecord.principal,
				scopes: requestedScopes,
			},
		};
	}

	async createPersonalAccessToken(userId: string, input: { name: string; scopes?: string[]; expiresAt?: string | null }) {
		await this.ensureInitialized();
		const nowIso = isoNow();
		const token = nextOpaqueToken('pat');
		const id = randomUUID();
		const tokenHash = stableHash(token, this.config.authSecret);
		const prefix = token.slice(0, 12);
		await this.run(
			`INSERT INTO api_tokens (id, user_id, kind, name, token_prefix, token_hash, scopes_json, expires_at, last_used_at, revoked_at, metadata_json, created_at, updated_at)
			 VALUES (?, ?, 'personal_access_token', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
			[
				id,
				userId,
				input.name,
				prefix,
				tokenHash,
				JSON.stringify(input.scopes?.length ? input.scopes : ['auth:me']),
				input.expiresAt ?? null,
				JSON.stringify({}),
				nowIso,
				nowIso,
			],
		);
		await this.writeAuditEvent({
			actorType: 'user',
			actorId: userId,
			eventType: 'auth.pat_created',
			targetType: 'api_token',
			targetId: id,
			data: { name: input.name },
		});
		return { id, token, prefix, name: input.name, expiresAt: input.expiresAt ?? null } satisfies PersonalAccessTokenResult;
	}

	async listPersonalAccessTokens(userId: string) {
		await this.ensureInitialized();
		return this.all<{
			id: string;
			name: string;
			token_prefix: string;
			expires_at: string | null;
			last_used_at: string | null;
			revoked_at: string | null;
			created_at: string;
		}>(
			`SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
			 FROM api_tokens
			 WHERE user_id = ?
			 ORDER BY created_at DESC`,
			[userId],
		);
	}

	async revokePersonalAccessToken(userId: string, tokenId: string) {
		await this.ensureInitialized();
		await this.run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`, [isoNow(), tokenId, userId]);
		await this.writeAuditEvent({
			actorType: 'user',
			actorId: userId,
			eventType: 'auth.pat_revoked',
			targetType: 'api_token',
			targetId: tokenId,
		});
	}

	async upsertServiceCredential(input: { serviceId: string; name: string; secret: string; roles?: string[]; permissions?: string[] }) {
		const nowIso = isoNow();
		const existing = await this.first<{ id: string }>(`SELECT id FROM service_credentials WHERE service_id = ?`, [input.serviceId]);
		const secretHash = stableHash(input.secret, this.config.authSecret);
		if (existing) {
			await this.run(
				`UPDATE service_credentials
				 SET name = ?, secret_hash = ?, roles_json = ?, permissions_json = ?, revoked_at = NULL, updated_at = ?
				 WHERE id = ?`,
				[input.name, secretHash, JSON.stringify(input.roles ?? []), JSON.stringify(input.permissions ?? []), nowIso, existing.id],
			);
			return existing.id;
		}
		const id = randomUUID();
		await this.run(
			`INSERT INTO service_credentials (id, service_id, name, secret_hash, roles_json, permissions_json, revoked_at, last_used_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
			[id, input.serviceId, input.name, secretHash, JSON.stringify(input.roles ?? []), JSON.stringify(input.permissions ?? []), nowIso, nowIso],
		);
		return id;
	}

	async createServiceCredential(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }): Promise<ServiceCredentialResult> {
		await this.ensureInitialized();
		const secret = nextOpaqueToken('svc');
		const id = await this.upsertServiceCredential({ ...input, secret });
		return { id, serviceId: input.serviceId, secret };
	}

	async rotateServiceCredential(serviceId: string) {
		await this.ensureInitialized();
		const row = await this.first<{ name: string; roles_json: string; permissions_json: string }>(
			`SELECT name, roles_json, permissions_json FROM service_credentials WHERE service_id = ? AND revoked_at IS NULL`,
			[serviceId],
		);
		if (!row) {
			throw new Error(`Unknown active service credential "${serviceId}".`);
		}
		return this.createServiceCredential({
			serviceId,
			name: row.name,
			roles: parseJson<string[]>(row.roles_json, []),
			permissions: parseJson<string[]>(row.permissions_json, []),
		});
	}

	async authenticateBearerToken(token: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null> {
		await this.ensureInitialized();
		const patHash = stableHash(token, this.config.authSecret);
		const pat = await this.first<{
			id: string;
			user_id: string;
			name: string;
			scopes_json: string;
			expires_at: string | null;
			revoked_at: string | null;
		}>(
			`SELECT id, user_id, name, scopes_json, expires_at, revoked_at
			 FROM api_tokens
			 WHERE token_hash = ?`,
			[patHash],
		);
		if (pat && !pat.revoked_at && (!pat.expires_at || new Date(pat.expires_at).getTime() > Date.now())) {
			await this.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [isoNow(), pat.id]);
			const principal = (await this.principalForUser(pat.user_id)).principal;
			return {
				principal: { ...principal, scopes: parseJson<string[]>(pat.scopes_json, principal.scopes) },
				credential: { type: 'personal_access_token', id: pat.id, label: pat.name },
			};
		}
		const payload = verifyAccessToken(token, this.config.authSecret);
		if (!payload) return null;
		return {
			principal: principalFromAccessTokenPayload(payload),
			credential: {
				type: payload.tokenType === 'service' ? 'service_token' : 'access_token',
				id: payload.jti,
				label: payload.tokenType,
			},
		};
	}

	async authenticateService(serviceId: string, secret: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null> {
		await this.ensureInitialized();
		const row = await this.first<{
			id: string;
			name: string;
			secret_hash: string;
			roles_json: string;
			permissions_json: string;
			revoked_at: string | null;
		}>(
			`SELECT id, name, secret_hash, roles_json, permissions_json, revoked_at
			 FROM service_credentials
			 WHERE service_id = ?`,
			[serviceId],
		);
		if (!row || row.revoked_at) return null;
		const incomingHash = stableHash(secret, this.config.authSecret);
		if (!equalHash(row.secret_hash, incomingHash)) return null;
		await this.run(`UPDATE service_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?`, [isoNow(), isoNow(), row.id]);
		const roles = parseJson<string[]>(row.roles_json, []);
		const permissions = [
			...new Set([
				...await this.permissionsForRoles(roles),
				...parseJson<string[]>(row.permissions_json, []),
			]),
		];
		return {
			principal: {
				id: serviceId,
				displayName: row.name,
				roles,
				permissions,
				scopes: this.scopesForPrincipal(permissions),
				metadata: { serviceId },
			},
			credential: { type: 'service_secret', id: row.id, label: row.name },
		};
	}

	async exchangeTrustedUserAssertion(claims: TrustedUserAssertionClaims) {
		await this.ensureInitialized();
		const principalRecord = await this.principalForUser(claims.userId);
		const expiresAt = addSeconds(now(), this.config.webExchangeTtlSeconds);
		const accessToken = createAccessToken({
			sub: principalRecord.principal.id,
			displayName: principalRecord.principal.displayName,
			scopes: principalRecord.principal.scopes,
			roles: principalRecord.principal.roles,
			permissions: principalRecord.principal.permissions,
			metadata: {
				...principalRecord.principal.metadata,
				actingSessionId: claims.sessionId,
				identityId: claims.identityId,
				teamId: claims.teamId ?? null,
				projectId: claims.projectId ?? null,
				membershipId: claims.membershipId ?? null,
				teamRoles: [...new Set((claims.teamRoles ?? []).filter((entry) => typeof entry === 'string' && entry.trim()))],
				teamCapabilities: [...new Set((claims.teamCapabilities ?? []).filter((entry) => typeof entry === 'string' && entry.trim()))],
				authTime: claims.authTime,
			},
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(expiresAt.getTime() / 1000),
			iss: this.config.issuer,
			jti: randomUUID(),
			tokenType: 'access',
		}, this.config.authSecret);
		await this.writeAuditEvent({
			actorType: 'service',
			actorId: this.config.webServiceId,
			eventType: 'auth.web_exchange',
			targetType: 'user',
			targetId: claims.userId,
			data: { sessionId: claims.sessionId },
		});
		return {
			ok: true as const,
			accessToken,
			tokenType: 'Bearer' as const,
			expiresAt: expiresAt.toISOString(),
			expiresInSeconds: this.config.webExchangeTtlSeconds,
			principal: principalRecord.principal,
		};
	}
}
