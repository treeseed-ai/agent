import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderControlPlaneConnection } from './contracts.ts';

// Assignment acquisition performs API-owned synthesis before a lease can be
// returned. Keep the provider transport deadline comfortably beyond the
// control plane's 30-second synthesis/TreeDX request windows so a successful
// lease response cannot be abandoned at the boundary.
export const PROVIDER_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 120_000;
export const PROVIDER_ASSIGNMENT_POLLING_TTL_MS = PROVIDER_CONTROL_PLANE_REQUEST_TIMEOUT_MS + 30_000;

export function createProviderControlPlaneClient(config: ProviderControlPlaneConnection) {
	return new ProviderProtocolClient({
		controlPlaneUrl: config.controlPlaneUrl,
		accessToken: config.accessToken,
		accessTokenProvider: config.accessTokenProvider,
		userAgent: '@treeseed/agent capacity-provider',
		requestTimeoutMs: PROVIDER_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
	});
}

export function providerOperationPath(binding: { descriptor: { operationId: string; rest?: { path: string } } }, parameters: Record<string, string> = {}) {
	const template = binding.descriptor.rest?.path;
	if (!template) throw new Error(`Provider operation ${binding.descriptor.operationId} has no REST binding.`);
	const path = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
		const value = parameters[name];
		if (value === undefined) throw new Error(`Provider operation ${binding.descriptor.operationId} requires path parameter ${name}.`);
		return encodeURIComponent(value);
	});
	if (/\{[^}]+\}/u.test(path)) throw new Error(`Provider operation ${binding.descriptor.operationId} has unresolved path parameters.`);
	return path;
}
