import { randomUUID } from 'node:crypto';
import type { ApiCredential, ApiPrincipal, DeviceCodeApproveRequest, DeviceCodePollRequest, DeviceCodePollResponse, DeviceCodeStartRequest, DeviceCodeStartResponse, TokenRefreshRequest, TokenRefreshResponse, TrustedUserAssertionClaims } from '../types.ts';
import { createAccessToken, nextOpaqueToken, principalFromAccessTokenPayload, verifyAccessToken } from './tokens.ts';
import {
	addSeconds,
	approvalUrl,
	equalHash,
	isoNow,
	now,
	parseJson,
	stableHash,
	type DeviceCodeRow,
	type PersonalAccessTokenResult,
	type ServiceCredentialResult,
} from './d1-store-core.ts';
import { D1AuthUserStore } from './d1-user-store.ts';

export type { PersonalAccessTokenResult, ServiceCredentialResult } from './d1-store-core.ts';

export class D1AuthStore extends D1AuthUserStore {
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
			verificationUri: approvalUrl(this.config.baseUrl),
			verificationUriComplete: approvalUrl(this.config.baseUrl, userCode),
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

