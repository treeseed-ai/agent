import type { Context } from 'hono';
import type { ApiPrincipal, ApiScope } from '@treeseed/sdk/remote';
import type { AppVariables } from './types.ts';
import { permissionGranted } from './auth/rbac.ts';

export type ApiContext = Context<{ Variables: AppVariables }>;

export function jsonError(
	c: Context,
	status: number,
	error: string,
	details?: Record<string, unknown>,
) {
	return c.json({
		ok: false,
		error,
		...(details ?? {}),
	}, { status: status as never });
}

export function bearerTokenFromRequest(request: Request) {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

export function hasScope(principal: ApiPrincipal | null, requiredScope: ApiScope) {
	return Boolean(principal && (principal.scopes.includes(requiredScope) || principal.scopes.includes('*')));
}

export function requireScope(c: ApiContext, requiredScope: ApiScope) {
	if (!hasScope(c.get('principal'), requiredScope)) {
		return jsonError(c, 401, 'Authentication required.', { requiredScope });
	}
	return null;
}

export function requireAuthentication(c: ApiContext) {
	if (!c.get('principal')) {
		return jsonError(c, 401, 'Authentication required.');
	}
	return null;
}

export function requireActorType(c: ApiContext, actorType: 'anonymous' | 'user' | 'service' | 'project', message = 'Trusted service authentication required.') {
	if (c.get('actorType') !== actorType) {
		return jsonError(c, 401, message);
	}
	return null;
}

export function requirePermission(c: ApiContext, permission: string) {
	const principal = c.get('principal');
	if (!principal || !permissionGranted(c.get('permissionGrants'), permission)) {
		return jsonError(c, 403, 'Permission denied.', { permission });
	}
	return null;
}
