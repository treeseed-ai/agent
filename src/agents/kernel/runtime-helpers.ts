import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { loadTreeseedDeployConfigFromPath } from '@treeseed/sdk/platform/deploy-config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENT_SPEC_LOAD_TIMEOUT_MS = 60_000;

export function nowIso() {
	return new Date().toISOString();
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value;
	}
	return null;
}

export function assignmentTreeDxProxyHandle(assignment: ProviderAssignment, explicit?: unknown) {
	const direct = record(explicit);
	if (Object.keys(direct).length > 0) return direct;
	const root = record(assignment.treedxProxyHandle);
	if (Object.keys(root).length > 0) return root;
	const workspace = record(assignment.workspaceContext);
	const workspaceHandle = record(workspace.treedxProxyHandle);
	return Object.keys(workspaceHandle).length > 0 ? workspaceHandle : null;
}

export async function withTimeout<T>(input: { promise: Promise<T>; timeoutMs: number; code: string; message: string }): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			input.promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					const error = new Error(input.message);
					(error as Error & { code?: string }).code = input.code;
					reject(error);
				}, input.timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function resolveExecutionRoot(tenantRoot: string) {
	const configPath = resolve(tenantRoot, 'treeseed.site.yaml');
	if (!existsSync(configPath)) return tenantRoot;
	const deployConfig = loadTreeseedDeployConfigFromPath(configPath) as { __projectRoot?: string };
	return deployConfig.__projectRoot ?? tenantRoot;
}
