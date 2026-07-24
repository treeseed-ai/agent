import type { ApiPrincipal } from '@treeseed/sdk/remote';
import { jsonError, type ApiContext } from './http.ts';

function stringArray(value: unknown) {
	return Array.isArray(value)
		? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))]
		: [];
}

export function principalTeamCapabilities(principal: ApiPrincipal | null) {
	return stringArray(principal?.metadata?.teamCapabilities);
}

export function principalTeamRoles(principal: ApiPrincipal | null) {
	return stringArray(principal?.metadata?.teamRoles);
}

export function hasTeamCapability(principal: ApiPrincipal | null, capability: string) {
	if (!principal) return false;
	if (principal.permissions.includes('*:*:*') || principal.roles.includes('project_api') || principal.roles.includes('platform_admin')) {
		return true;
	}
	const capabilities = principalTeamCapabilities(principal);
	if (capabilities.includes(capability)) {
		return true;
	}
	return principalTeamRoles(principal).includes('team_owner');
}

export function requireTeamCapability(c: ApiContext, capability: string) {
	if (!hasTeamCapability(c.get('principal'), capability)) {
		return jsonError(c, 403, 'Permission denied.', { capability });
	}
	return null;
}
