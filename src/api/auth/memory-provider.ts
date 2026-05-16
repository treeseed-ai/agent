import { randomUUID } from 'node:crypto';
import type {
	ApiAuthProvider,
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
import {
	createAccessToken,
	nextOpaqueToken,
	principalFromAccessTokenPayload,
	verifyAccessToken,
} from './tokens.ts';

type DeviceFlowRecord = {
	deviceCode: string;
	userCode: string;
	requestedScopes: string[];
	expiresAt: number;
	intervalSeconds: number;
	status: 'pending' | 'approved' | 'used';
	principal: ApiPrincipal | null;
};

type RefreshSessionRecord = {
	principal: ApiPrincipal;
	expiresAt: number;
};

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

function formatExpiry(epochSeconds: number) {
	return new Date(epochSeconds * 1000).toISOString();
}

function nextUserCode() {
	return Math.random().toString(36).slice(2, 6).toUpperCase()
		+ '-'
		+ Math.random().toString(36).slice(2, 6).toUpperCase();
}

function approvalUrl(baseUrl: string, userCode?: string | null) {
	const url = new URL('/auth/device/approve', `${baseUrl.replace(/\/+$/u, '')}/`);
	if (userCode) {
		url.searchParams.set('user_code', userCode);
	}
	return url.toString();
}

export class MemoryDeviceCodeAuthProvider implements ApiAuthProvider {
	readonly id = 'memory';
	private readonly devices = new Map<string, DeviceFlowRecord>();
	private readonly refreshSessions = new Map<string, RefreshSessionRecord>();

	constructor(private readonly config: ApiConfig) {}

	async startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse> {
		const expiresAt = nowSeconds() + this.config.deviceCodeTtlSeconds;
		const deviceCode = nextOpaqueToken('device');
		const userCode = nextUserCode();
		this.devices.set(deviceCode, {
			deviceCode,
			userCode,
			requestedScopes: request.scopes?.length ? [...request.scopes] : ['templates:read', 'auth:me', 'sdk', 'operations'],
			expiresAt,
			intervalSeconds: this.config.deviceCodePollIntervalSeconds,
			status: 'pending',
			principal: null,
		});

		return {
			ok: true,
			deviceCode,
			userCode,
			verificationUri: approvalUrl(this.config.baseUrl),
			verificationUriComplete: approvalUrl(this.config.baseUrl, userCode),
			intervalSeconds: this.config.deviceCodePollIntervalSeconds,
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.deviceCodeTtlSeconds,
		};
	}

	async approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }> {
		const record = [...this.devices.values()].find((entry) => entry.userCode === request.userCode);
		if (!record || record.expiresAt <= nowSeconds()) {
			throw new Error('Device code approval failed because the user code is unknown or expired.');
		}

		record.status = 'approved';
		record.principal = {
			id: request.principalId,
			displayName: request.displayName,
			scopes: request.scopes?.length ? [...request.scopes] : [...record.requestedScopes],
			roles: ['member'],
			permissions: ['auth:read:self'],
			metadata: request.metadata,
		};
		return { ok: true };
	}

	async pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
		const record = this.devices.get(request.deviceCode);
		if (!record) {
			return { ok: false, status: 'invalid', error: 'Unknown device code.' };
		}
		if (record.expiresAt <= nowSeconds()) {
			this.devices.delete(request.deviceCode);
			return { ok: false, status: 'expired', error: 'Device code expired.' };
		}
		if (record.status === 'pending' || !record.principal) {
			return {
				ok: true,
				status: 'pending',
				intervalSeconds: record.intervalSeconds,
			};
		}
		if (record.status === 'used') {
			return { ok: false, status: 'already_used', error: 'Device code already used.' };
		}

		record.status = 'used';
		const refreshToken = nextOpaqueToken('refresh');
		const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
		const accessToken = createAccessToken({
			sub: record.principal.id,
			displayName: record.principal.displayName,
			scopes: record.principal.scopes,
			roles: record.principal.roles,
			permissions: record.principal.permissions,
			metadata: record.principal.metadata,
			iat: nowSeconds(),
			exp: expiresAt,
			iss: this.config.issuer,
			jti: randomUUID(),
			tokenType: 'access',
		}, this.config.authSecret);

		this.refreshSessions.set(refreshToken, {
			principal: record.principal,
			expiresAt: nowSeconds() + this.config.refreshTokenTtlSeconds,
		});

		return {
			ok: true,
			status: 'approved',
			accessToken,
			refreshToken,
			tokenType: 'Bearer',
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: record.principal,
		};
	}

	async refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse> {
		const session = this.refreshSessions.get(request.refreshToken);
		if (!session || session.expiresAt <= nowSeconds()) {
			throw new Error('Refresh token is invalid or expired.');
		}

		const nextRefreshToken = nextOpaqueToken('refresh');
		this.refreshSessions.delete(request.refreshToken);
		this.refreshSessions.set(nextRefreshToken, {
			principal: session.principal,
			expiresAt: nowSeconds() + this.config.refreshTokenTtlSeconds,
		});

		const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
		const accessToken = createAccessToken({
			sub: session.principal.id,
			displayName: session.principal.displayName,
			scopes: session.principal.scopes,
			roles: session.principal.roles,
			permissions: session.principal.permissions,
			metadata: session.principal.metadata,
			iat: nowSeconds(),
			exp: expiresAt,
			iss: this.config.issuer,
			jti: randomUUID(),
			tokenType: 'access',
		}, this.config.authSecret);

		return {
			ok: true,
			accessToken,
			refreshToken: nextRefreshToken,
			tokenType: 'Bearer',
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: session.principal,
		};
	}

	async authenticateBearerToken(token: string) {
		const payload = verifyAccessToken(token, this.config.authSecret);
		return payload
			? {
				principal: principalFromAccessTokenPayload(payload),
				credential: {
					type: 'access_token',
					id: payload.jti,
					label: payload.tokenType,
				} satisfies ApiCredential,
			}
			: null;
	}

	async authenticateServiceCredential(_serviceId: string, _secret: string) {
		return null;
	}

	async createPersonalAccessToken(
		_userId: string,
		_input: { name: string; scopes?: string[]; expiresAt?: string | null },
	): Promise<{ id: string; token: string; prefix: string; name: string; expiresAt: string | null }> {
		throw new Error('Personal access tokens are unavailable in the memory auth provider.');
	}

	async listPersonalAccessTokens() {
		return [];
	}

	async revokePersonalAccessToken() {}

	async syncUserIdentity(identity: UserIdentityProfileInput) {
		return {
			userId: identity.providerSubject,
			identityId: identity.providerSubject,
			principal: {
				id: identity.providerSubject,
				displayName: identity.displayName ?? undefined,
				scopes: ['auth:me'],
				roles: ['member'],
				permissions: ['auth:read:self'],
				metadata: {
					...(identity.profile ?? {}),
					username: identity.username ?? undefined,
					firstName: typeof identity.profile?.firstName === 'string' ? identity.profile.firstName : undefined,
					lastName: typeof identity.profile?.lastName === 'string' ? identity.profile.lastName : undefined,
				},
			},
		};
	}

	async createServiceToken(
		_input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] },
	): Promise<{ id: string; serviceId: string; secret: string }> {
		throw new Error('Service credentials are unavailable in the memory auth provider.');
	}

	async rotateServiceToken(_serviceId: string): Promise<{ id: string; serviceId: string; secret: string }> {
		throw new Error('Service credentials are unavailable in the memory auth provider.');
	}

	createTrustedUserAssertion(claims: TrustedUserAssertionClaims) {
		return Buffer.from(JSON.stringify(claims)).toString('base64url');
	}

	verifyTrustedUserAssertion(assertion: string) {
		try {
			return JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8')) as TrustedUserAssertionClaims;
		} catch {
			return null;
		}
	}

	async exchangeTrustedUserAssertion(claims: TrustedUserAssertionClaims) {
		const principal: ApiPrincipal = {
			id: claims.userId,
			displayName: claims.userId,
			scopes: ['auth:me'],
			roles: ['member'],
			permissions: ['auth:read:self'],
			metadata: {
				sessionId: claims.sessionId,
				identityId: claims.identityId,
				teamId: claims.teamId ?? null,
				projectId: claims.projectId ?? null,
				membershipId: claims.membershipId ?? null,
				teamRoles: claims.teamRoles ?? [],
				teamCapabilities: claims.teamCapabilities ?? [],
			},
		};
		const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
		return {
			ok: true as const,
			accessToken: createAccessToken({
				sub: principal.id,
				displayName: principal.displayName,
				scopes: principal.scopes,
				roles: principal.roles,
				permissions: principal.permissions,
				metadata: principal.metadata,
				iat: nowSeconds(),
				exp: expiresAt,
				iss: this.config.issuer,
				jti: randomUUID(),
				tokenType: 'access',
			}, this.config.authSecret),
			tokenType: 'Bearer' as const,
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal,
		};
	}
}
