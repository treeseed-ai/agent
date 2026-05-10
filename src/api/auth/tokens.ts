import { createHmac, randomBytes } from 'node:crypto';
import type { ApiPrincipal } from '../types.ts';

export interface AccessTokenPayload {
	sub: string;
	displayName?: string;
	scopes: string[];
	roles: string[];
	permissions: string[];
	iat: number;
	exp: number;
	iss: string;
	jti: string;
	tokenType: 'access' | 'service';
	metadata?: Record<string, unknown>;
}

function encodeBase64Url(value: string | Buffer) {
	return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string) {
	return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(input: string, secret: string) {
	return createHmac('sha256', secret).update(input).digest('base64url');
}

export function nextOpaqueToken(prefix: string) {
	return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function createAccessToken(payload: AccessTokenPayload, secret: string) {
	const encodedPayload = encodeBase64Url(JSON.stringify(payload));
	const encodedSignature = sign(encodedPayload, secret);
	return `${encodedPayload}.${encodedSignature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
	const [encodedPayload, encodedSignature] = token.split('.');
	if (!encodedPayload || !encodedSignature) {
		return null;
	}

	const expected = sign(encodedPayload, secret);
	if (expected !== encodedSignature) {
		return null;
	}

	try {
		const payload = JSON.parse(decodeBase64Url(encodedPayload)) as AccessTokenPayload;
		if (!payload.sub || !Array.isArray(payload.scopes) || !payload.exp) {
			return null;
		}
		if (payload.exp <= Math.floor(Date.now() / 1000)) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

export function principalFromAccessTokenPayload(payload: AccessTokenPayload): ApiPrincipal {
	return {
		id: payload.sub,
		displayName: payload.displayName,
		scopes: [...payload.scopes],
		roles: [...payload.roles],
		permissions: [...payload.permissions],
		metadata: payload.metadata,
	};
}
