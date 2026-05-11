import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentHandlerKind } from '@treeseed/sdk/types/agents';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentHandler } from './runtime-types.ts';
import { resolveAgentRuntimeProviders } from '../agent-runtime.ts';

const BUILTIN_HANDLER_KINDS = [
	'planner',
	'architect',
	'engineer',
	'notifier',
	'researcher',
	'reviewer',
	'releaser',
] as const;

const HANDLER_EXPORT_NAMES: Record<(typeof BUILTIN_HANDLER_KINDS)[number], string> = {
	planner: 'plannerHandler',
	architect: 'architectHandler',
	engineer: 'engineerHandler',
	notifier: 'notifierHandler',
	researcher: 'researcherHandler',
	reviewer: 'reviewerHandler',
	releaser: 'releaserHandler',
};

export function getTenantAgentHandlerModulePaths(
	kind: AgentHandlerKind,
	tenantRoot = resolveTreeseedTenantRoot(),
) {
	return [
		resolve(tenantRoot, 'src/agents', `${kind}.js`),
		resolve(tenantRoot, 'src/agents', `${kind}.ts`),
	];
}

export async function loadTenantAgentHandlerRegistry(
	tenantRoot = resolveTreeseedTenantRoot(),
): Promise<Record<string, AgentHandler>> {
	const registry: Record<string, AgentHandler> = {};

	for (const kind of BUILTIN_HANDLER_KINDS) {
		const modulePath = getTenantAgentHandlerModulePaths(kind, tenantRoot).find((candidate) => existsSync(candidate));
		if (!modulePath) {
			continue;
		}

		let moduleExports: Record<string, unknown>;
		try {
			moduleExports = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to import tenant agent handler "${kind}" from ${modulePath}: ${reason}`);
		}

		const exportName = HANDLER_EXPORT_NAMES[kind];
		const handler = moduleExports[exportName];
		if (!handler) {
			throw new Error(
				`Tenant agent handler module "${modulePath}" must export "${exportName}" for handler kind "${kind}".`,
			);
		}

		const normalizedHandler = handler as AgentHandler;
		if (normalizedHandler.kind !== kind) {
			throw new Error(
				`Tenant agent handler "${exportName}" from "${modulePath}" declares kind "${normalizedHandler.kind}", but "${kind}" was expected.`,
			);
		}

		registry[kind] = normalizedHandler;
	}

	return registry;
}

let agentHandlerRegistryPromise: Promise<Record<string, AgentHandler>> | null = null;

async function getAgentHandlerRegistry() {
	if (!agentHandlerRegistryPromise) {
		agentHandlerRegistryPromise = loadTenantAgentHandlerRegistry();
	}
	return agentHandlerRegistryPromise;
}

export async function listRegisteredAgentHandlers() {
	const registry = await getAgentHandlerRegistry();
	const runtimeProviders = resolveAgentRuntimeProviders(resolveTreeseedTenantRoot(), getTreeseedAgentProviderSelections());
	return [...new Set([...Object.keys(registry), ...runtimeProviders.handlers.keys()])];
}

export async function resolveAgentHandler(kind: AgentHandlerKind) {
	const registry = await getAgentHandlerRegistry();
	const runtimeProviders = resolveAgentRuntimeProviders(resolveTreeseedTenantRoot(), getTreeseedAgentProviderSelections());
	const handler = registry[kind] ?? runtimeProviders.handlers.get(kind);
	if (!handler) {
		if ((BUILTIN_HANDLER_KINDS as readonly string[]).includes(kind)) {
			const expectedPath = getTenantAgentHandlerModulePaths(kind).join('" or "');
			const expectedExport = HANDLER_EXPORT_NAMES[kind as (typeof BUILTIN_HANDLER_KINDS)[number]];
			throw new Error(
				`No runtime handler is registered for agent handler "${kind}". Expected tenant file "${expectedPath}" exporting "${expectedExport}" or a plugin contribution.`,
			);
		}
		throw new Error(`No runtime handler is registered for agent handler "${kind}".`);
	}

	return handler;
}
