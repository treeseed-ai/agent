import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { AgentHandlerKind } from '@treeseed/sdk/types/agents';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentHandler } from './runtime-types.ts';
import { resolveAgentRuntimeProviders } from '../agent-runtime.ts';
import { actHandler } from './handlers/act.ts';
import { planHandler } from './handlers/plan.ts';
import { reportHandler } from './handlers/report.ts';
import { researchHandler } from './handlers/research.ts';
import { reviewHandler } from './handlers/review.ts';

const BUILTIN_HANDLER_KINDS = [
	'plan',
	'research',
	'act',
	'review',
	'report',
] as const;

const HANDLER_EXPORT_NAMES: Record<(typeof BUILTIN_HANDLER_KINDS)[number], string> = {
	plan: 'planHandler',
	research: 'researchHandler',
	act: 'actHandler',
	review: 'reviewHandler',
	report: 'reportHandler',
};

const BUILTIN_HANDLERS: Record<(typeof BUILTIN_HANDLER_KINDS)[number], AgentHandler> = {
	plan: planHandler,
	research: researchHandler,
	act: actHandler,
	review: reviewHandler,
	report: reportHandler,
};

function normalizeHandlerKind(kind: AgentHandlerKind): AgentHandlerKind {
	return kind;
}

function handlerExportName(kind: string) {
	if ((BUILTIN_HANDLER_KINDS as readonly string[]).includes(kind)) {
		return HANDLER_EXPORT_NAMES[kind as (typeof BUILTIN_HANDLER_KINDS)[number]];
	}
	const identifier = kind
		.split(/[^a-zA-Z0-9]+/u)
		.filter(Boolean)
		.map((part, index) => {
			const lower = part.charAt(0).toLowerCase() + part.slice(1);
			return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
		})
		.join('');
	return `${identifier || 'agent'}Handler`;
}

export function getTenantAgentHandlerModulePaths(
	kind: AgentHandlerKind,
	tenantRoot = resolveTreeseedTenantRoot(),
) {
	return [
		resolve(tenantRoot, 'src/agents', `${kind}.ts`),
		resolve(tenantRoot, 'src/agents', `${kind}.js`),
	];
}

function listTenantAgentHandlerKinds(tenantRoot: string) {
	const agentsRoot = resolve(tenantRoot, 'src/agents');
	if (!existsSync(agentsRoot)) {
		return [...BUILTIN_HANDLER_KINDS];
	}
	const localKinds = readdirSync(agentsRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name.match(/^(.+)\.(?:js|ts)$/u)?.[1] ?? null)
		.filter((entry): entry is string => Boolean(entry && !entry.startsWith('_') && !entry.endsWith('.d')));
	return [...new Set([...BUILTIN_HANDLER_KINDS, ...localKinds])];
}

function findNearestTsconfig(startPath: string) {
	let current = dirname(startPath);
	while (true) {
		const candidate = resolve(current, 'tsconfig.json');
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = resolve(current, '..');
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

async function importTenantAgentHandlerModule(modulePath: string) {
	if (extname(modulePath) !== '.ts') {
		return await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<string, unknown>;
	}

	const outputParent = resolve(process.cwd(), '.treeseed');
	mkdirSync(outputParent, { recursive: true });
	const outputRoot = mkdtempSync(resolve(outputParent, 'agent-handler-'));
	const outputFile = resolve(outputRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
	const tsconfig = findNearestTsconfig(modulePath);
	try {
		await build({
			entryPoints: [modulePath],
			outfile: outputFile,
			bundle: true,
			format: 'esm',
			platform: 'node',
			packages: 'external',
			logLevel: 'silent',
			tsconfig: tsconfig ?? undefined,
			tsconfigRaw: tsconfig
				? undefined
				: {
					compilerOptions: {
						allowImportingTsExtensions: true,
						module: 'ESNext',
						target: 'ES2022',
					},
				},
		});
		return await import(/* @vite-ignore */ pathToFileURL(outputFile).href) as Record<string, unknown>;
	} finally {
		rmSync(outputRoot, { recursive: true, force: true });
	}
}

export async function loadTenantAgentHandlerRegistry(
	tenantRoot = resolveTreeseedTenantRoot(),
): Promise<Record<string, AgentHandler>> {
	const registry: Record<string, AgentHandler> = {};

	for (const kind of listTenantAgentHandlerKinds(tenantRoot)) {
		const modulePath = getTenantAgentHandlerModulePaths(kind, tenantRoot).find((candidate) => existsSync(candidate));
		if (!modulePath) {
			if ((BUILTIN_HANDLER_KINDS as readonly string[]).includes(kind)) {
				registry[kind] = BUILTIN_HANDLERS[kind as (typeof BUILTIN_HANDLER_KINDS)[number]];
			}
			continue;
		}

		let moduleExports: Record<string, unknown>;
		try {
			moduleExports = await importTenantAgentHandlerModule(modulePath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to import tenant agent handler "${kind}" from ${modulePath}: ${reason}`);
		}

		const exportName = handlerExportName(kind);
		const handler = moduleExports[exportName] ?? moduleExports.handler ?? moduleExports.default;
		if (!handler) {
			throw new Error(
				`Tenant agent handler module "${modulePath}" must export "${exportName}", "handler", or a default handler for handler kind "${kind}".`,
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

const agentHandlerRegistryPromises = new Map<string, Promise<Record<string, AgentHandler>>>();

async function getAgentHandlerRegistry(tenantRoot = resolveTreeseedTenantRoot()) {
	if (!agentHandlerRegistryPromises.has(tenantRoot)) {
		agentHandlerRegistryPromises.set(tenantRoot, loadTenantAgentHandlerRegistry(tenantRoot));
	}
	return agentHandlerRegistryPromises.get(tenantRoot)!;
}

export async function listRegisteredAgentHandlers(options: { tenantRoot?: string } = {}) {
	const tenantRoot = options.tenantRoot ?? resolveTreeseedTenantRoot();
	const registry = await getAgentHandlerRegistry(tenantRoot);
	const runtimeProviders = resolveAgentRuntimeProviders(tenantRoot, getTreeseedAgentProviderSelections());
	return [...new Set([
		...Object.keys(registry),
		...runtimeProviders.handlers.keys(),
	])];
}

export async function resolveAgentHandler(kind: AgentHandlerKind, options: { tenantRoot?: string } = {}) {
	const normalizedKind = normalizeHandlerKind(kind);
	const tenantRoot = options.tenantRoot ?? resolveTreeseedTenantRoot();
	const registry = await getAgentHandlerRegistry(tenantRoot);
	const runtimeProviders = resolveAgentRuntimeProviders(tenantRoot, getTreeseedAgentProviderSelections());
	const handler = registry[normalizedKind] ?? runtimeProviders.handlers.get(normalizedKind);
	if (!handler) {
		if ((BUILTIN_HANDLER_KINDS as readonly string[]).includes(normalizedKind)) {
			const expectedPath = getTenantAgentHandlerModulePaths(normalizedKind, tenantRoot).join('" or "');
			const expectedExport = HANDLER_EXPORT_NAMES[normalizedKind as (typeof BUILTIN_HANDLER_KINDS)[number]];
			throw new Error(
				`No runtime handler is registered for agent handler "${normalizedKind}". Expected tenant file "${expectedPath}" exporting "${expectedExport}" or a plugin contribution.`,
			);
		}
		throw new Error(`No runtime handler is registered for agent handler "${normalizedKind}".`);
	}

	return handler;
}
