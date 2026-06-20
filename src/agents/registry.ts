import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { AgentHandlerKind } from '@treeseed/sdk/types/agents';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentHandler } from './runtime-types.ts';
import { resolveAgentRuntimeProviders } from '../agent-runtime.ts';
import { researcherHandler } from './handlers/researcher.ts';
import { knowledgeGeneratorHandler } from './handlers/knowledge-generator.ts';
import { knowledgeOptimizerHandler } from './handlers/knowledge-optimizer.ts';
import { plannerHandler } from './handlers/planner.ts';
import { engineerHandler } from './handlers/engineer.ts';
import { reviewerHandler } from './handlers/reviewer.ts';
import { reporterHandler } from './handlers/reporter.ts';
import { releaserHandler } from './handlers/releaser.ts';

const BUILTIN_HANDLER_KINDS = [
	'planner',
	'architect',
	'engineer',
	'notifier',
	'researcher',
	'knowledge_generator',
	'knowledge_optimizer',
	'reviewer',
	'reporter',
	'releaser',
] as const;

const HANDLER_EXPORT_NAMES: Record<(typeof BUILTIN_HANDLER_KINDS)[number], string> = {
	planner: 'plannerHandler',
	architect: 'architectHandler',
	engineer: 'engineerHandler',
	notifier: 'notifierHandler',
	researcher: 'researcherHandler',
	knowledge_generator: 'knowledgeGeneratorHandler',
	knowledge_optimizer: 'knowledgeOptimizerHandler',
	reviewer: 'reviewerHandler',
	reporter: 'reporterHandler',
	releaser: 'releaserHandler',
};

const PACKAGE_BUILTIN_HANDLERS = new Map<string, AgentHandler>([
	[plannerHandler.kind, plannerHandler],
	[researcherHandler.kind, researcherHandler],
	[knowledgeGeneratorHandler.kind, knowledgeGeneratorHandler],
	[knowledgeOptimizerHandler.kind, knowledgeOptimizerHandler],
	[engineerHandler.kind, engineerHandler],
	[reviewerHandler.kind, reviewerHandler],
	[reporterHandler.kind, reporterHandler],
	[releaserHandler.kind, releaserHandler],
]);

const SELF_CONTRACT_IMPORTS: Record<string, string> = {
	'@treeseed/agent/contracts/messages': 'contracts/messages',
	'@treeseed/agent/contracts/run': 'contracts/run',
};

function normalizeHandlerKind(kind: AgentHandlerKind): AgentHandlerKind {
	if (kind === 'knowledge-generator') return 'knowledge_generator';
	if (kind === 'knowledge-optimizer') return 'knowledge_optimizer';
	return kind;
}

export function getTenantAgentHandlerModulePaths(
	kind: AgentHandlerKind,
	tenantRoot = resolveTreeseedTenantRoot(),
) {
	return [
		resolve(tenantRoot, 'src/agents', `${kind}.js`),
		resolve(tenantRoot, 'src/agents', `${kind}.ts`),
	];
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

function resolveSelfContractImport(importPath: string) {
	const relativeContractPath = SELF_CONTRACT_IMPORTS[importPath];
	if (!relativeContractPath) {
		return null;
	}

	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDir, `${relativeContractPath}.ts`),
		resolve(moduleDir, `${relativeContractPath}.js`),
		resolve(moduleDir, '..', 'src', 'agents', `${relativeContractPath}.ts`),
		resolve(moduleDir, '..', 'dist', 'agents', `${relativeContractPath}.js`),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function importTenantAgentHandlerModule(modulePath: string) {
	if (extname(modulePath) !== '.ts') {
		return await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<string, unknown>;
	}

	const outputParent = resolve(process.cwd(), '.treeseed');
	mkdirSync(outputParent, { recursive: true });
	const outputRoot = mkdtempSync(resolve(outputParent, 'agent-handler-'));
	const outputFile = resolve(outputRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
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
			plugins: [{
				name: 'treeseed-agent-self-contracts',
				setup(buildContext) {
					buildContext.onResolve({ filter: /^@treeseed\/agent\/contracts\/(messages|run)$/ }, (args) => {
						const path = resolveSelfContractImport(args.path);
						if (!path) {
							return null;
						}
						return { path };
					});
				},
			}],
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

	for (const kind of BUILTIN_HANDLER_KINDS) {
		const modulePath = getTenantAgentHandlerModulePaths(kind, tenantRoot).find((candidate) => existsSync(candidate));
		if (!modulePath) {
			continue;
		}

		let moduleExports: Record<string, unknown>;
		try {
			moduleExports = await importTenantAgentHandlerModule(modulePath);
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
		...PACKAGE_BUILTIN_HANDLERS.keys(),
	])];
}

export async function resolveAgentHandler(kind: AgentHandlerKind, options: { tenantRoot?: string } = {}) {
	const normalizedKind = normalizeHandlerKind(kind);
	const tenantRoot = options.tenantRoot ?? resolveTreeseedTenantRoot();
	const registry = await getAgentHandlerRegistry(tenantRoot);
	const runtimeProviders = resolveAgentRuntimeProviders(tenantRoot, getTreeseedAgentProviderSelections());
	const handler = registry[normalizedKind] ?? runtimeProviders.handlers.get(normalizedKind) ?? PACKAGE_BUILTIN_HANDLERS.get(normalizedKind);
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
