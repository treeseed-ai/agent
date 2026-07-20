import type { DeclarativeContextQuery, HandlerContextPackSource, ResolvedHandlerContextPack } from '@treeseed/sdk/graph/context-query-contracts';
import type { SdkContextPack, SdkGraphNode } from '@treeseed/sdk';

export type CodeContextPackKind = 'package_surface' | 'module_surface' | 'flow';

export interface DocsCoverageLink {
	path: string;
	kind?: string;
	evidence?: string;
	matched?: string[];
}

export interface ModuleSurfaceInventory {
	path: string;
	packageName: string;
	responsibility: string;
	fileCount?: number;
	importantFiles: string[];
	exportedSymbols: string[];
	imports: string[];
	tests: string[];
	relatedDocs: DocsCoverageLink[];
	warnings: string[];
}

export interface PackageSurfaceInventory {
	name: string;
	purpose: string;
	root: string;
	entrypoints: string[];
	publicExports: string[];
	commands?: string[];
	runtimeServices: string[];
	moduleCount?: number;
	fileCount?: number;
	tests: string[];
	relatedDocs: DocsCoverageLink[];
	knownGaps?: string[];
	modules: ModuleSurfaceInventory[];
	warnings: string[];
}

export interface CodebaseInventoryArtifact {
	id: string;
	kind: 'codebase_inventory';
	title?: string;
	repoRef?: string;
	packages: PackageSurfaceInventory[];
	modules: ModuleSurfaceInventory[];
	warnings?: string[];
}

export interface CodeContextPackBuilderInput {
	query: DeclarativeContextQuery;
	inventory: CodebaseInventoryArtifact;
	source: HandlerContextPackSource;
	sourceRef?: string;
}

function normalize(value: string) {
	return value.trim().replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/^\/+/u, '').toLowerCase();
}

function slug(value: string) {
	return normalize(value).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'code';
}

function tokenSet(value: string) {
	return new Set(normalize(value).split(/[^a-z0-9]+/u).filter((entry) => entry.length >= 3));
}

function scoreTokens(scope: string, text: string) {
	const expected = tokenSet(scope);
	if (!expected.size) return 0;
	const actual = tokenSet(text);
	return [...expected].filter((token) => actual.has(token)).length;
}

function scopeMatchesPath(scope: string, path: string) {
	const normalizedScope = normalize(scope);
	const normalizedPath = normalize(path);
	return normalizedPath === normalizedScope
		|| normalizedPath.startsWith(`${normalizedScope}/`)
		|| normalizedScope.startsWith(`${normalizedPath}/`)
		|| normalizedPath.includes(normalizedScope);
}

function scopeMatchesPackage(scope: string, pkg: PackageSurfaceInventory) {
	const normalizedScope = normalize(scope);
	return normalizedScope === pkg.name
		|| scopeMatchesPath(normalizedScope, pkg.root === '.' ? 'market' : pkg.root)
		|| scoreTokens(scope, `${pkg.name} ${pkg.purpose} ${pkg.root}`) >= 2;
}

function scopeMatchesModule(scope: string, module: ModuleSurfaceInventory) {
	return scopeMatchesPath(scope, module.path)
		|| module.importantFiles.some((file) => scopeMatchesPath(scope, file))
		|| scoreTokens(scope, `${module.path} ${module.responsibility} ${module.exportedSymbols.join(' ')}`) >= 2;
}

function sourceFilesForPackage(pkg: PackageSurfaceInventory) {
	return [...new Set([
		...pkg.entrypoints,
		...pkg.modules.flatMap((module) => module.importantFiles.slice(0, 4)),
	])].sort().slice(0, 16);
}

function node(
	id: string,
	title: string,
	relativePath: string,
	text: string,
	data: Record<string, unknown>,
): SdkContextPack['nodes'][number] {
	const graphNode: SdkGraphNode = {
		id,
		nodeType: 'File',
		sourceModel: 'codebase_inventory',
		title,
		text,
		data: {
			relativePath,
			...data,
		},
	};
	return {
		node: graphNode,
		score: 1,
		depth: 0,
		text,
		tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
		reasons: ['codebase_inventory'],
		provenance: {
			seedIds: [id],
			viaEdgeTypes: [],
		},
	};
}

function packageText(pkg: PackageSurfaceInventory) {
	return [
		`Package: ${pkg.name}`,
		`Root: ${pkg.root}`,
		`Purpose: ${pkg.purpose}`,
		`Entrypoints: ${pkg.entrypoints.join(', ') || 'none recorded'}`,
		`Public exports: ${pkg.publicExports.join(', ') || 'none recorded'}`,
		`Runtime services: ${pkg.runtimeServices.join(', ') || 'none recorded'}`,
		`Tests: ${pkg.tests.join(', ') || 'none recorded'}`,
		`Related docs: ${pkg.relatedDocs.map((doc) => doc.path).join(', ') || 'none recorded'}`,
		`Warnings: ${pkg.warnings.join(' ') || 'none'}`,
	].join('\n');
}

function moduleText(module: ModuleSurfaceInventory) {
	return [
		`Module: ${module.path}`,
		`Package: ${module.packageName}`,
		`Responsibility: ${module.responsibility}`,
		`Important files: ${module.importantFiles.join(', ') || 'none recorded'}`,
		`Exports: ${module.exportedSymbols.join(', ') || 'none recorded'}`,
		`Imports: ${module.imports.join(', ') || 'none recorded'}`,
		`Tests: ${module.tests.join(', ') || 'none recorded'}`,
		`Related docs: ${module.relatedDocs.map((doc) => doc.path).join(', ') || 'none recorded'}`,
		`Warnings: ${module.warnings.join(' ') || 'none'}`,
	].join('\n');
}

function createPack(input: CodeContextPackBuilderInput, kind: CodeContextPackKind, idSuffix: string, nodes: SdkContextPack['nodes'], warnings: string[]): ResolvedHandlerContextPack {
	const pack: SdkContextPack = {
		seedIds: nodes.map((entry) => entry.node.id),
		totalTokenEstimate: nodes.reduce((total, entry) => total + entry.tokenEstimate, 0),
		includedNodeIds: nodes.map((entry) => entry.node.id),
		nodes,
		edges: [],
	};
	return {
		id: `${input.query.id}:code:${idSuffix}`,
		purpose: input.query.purpose,
		source: input.source,
		sourceRef: input.sourceRef,
		query: input.query,
		request: {
			query: input.query.query,
			stage: 'research',
			view: 'full',
			options: { depth: 0, limit: nodes.length, maxNodes: nodes.length },
		},
		pack,
		warnings: [
			`code_context_kind:${kind}`,
			`codebase_inventory:${input.inventory.id}`,
			`repo_ref:${input.inventory.repoRef}`,
			...warnings,
		],
	};
}

function packagePack(input: CodeContextPackBuilderInput, pkg: PackageSurfaceInventory) {
	const files = sourceFilesForPackage(pkg);
	return createPack(input, 'package_surface', `package-${pkg.name}`, [
		node(`code-package:${pkg.name}`, `${pkg.name} package surface`, pkg.root === '.' ? 'market' : pkg.root, packageText(pkg), {
			codeContextKind: 'package_surface',
			sourceFiles: files,
			sourceSymbolsOrSections: pkg.publicExports,
			repoRef: input.inventory.repoRef,
		}),
		...files.slice(0, 6).map((file) => node(`code-file:${file}`, file, file, `Important file for ${pkg.name}: ${file}`, {
			codeContextKind: 'module_surface',
			sourceFiles: [file],
			sourceSymbolsOrSections: [],
			repoRef: input.inventory.repoRef,
		})),
	], pkg.warnings);
}

function modulePack(input: CodeContextPackBuilderInput, module: ModuleSurfaceInventory) {
	return createPack(input, 'module_surface', `module-${slug(module.path)}`, [
		node(`code-module:${module.path}`, `${module.path} module surface`, module.path, moduleText(module), {
			codeContextKind: 'module_surface',
			sourceFiles: module.importantFiles,
			sourceSymbolsOrSections: module.exportedSymbols,
			repoRef: input.inventory.repoRef,
		}),
		...module.importantFiles.slice(0, 6).map((file) => node(`code-file:${file}`, file, file, `Important file for ${module.path}: ${file}`, {
			codeContextKind: 'module_surface',
			sourceFiles: [file],
			sourceSymbolsOrSections: module.exportedSymbols,
			repoRef: input.inventory.repoRef,
		})),
	], module.warnings);
}

function flowPack(input: CodeContextPackBuilderInput, scope: string) {
	const flowName = scope.replace(/^flow[:/]/iu, '').trim() || input.query.query;
	const rankedModules = input.inventory.modules
		.map((module) => ({ module, score: scoreTokens(`${flowName} ${input.query.query}`, `${module.path} ${module.responsibility} ${module.exportedSymbols.join(' ')} ${module.imports.join(' ')}`) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.module.path.localeCompare(right.module.path))
		.slice(0, 6)
		.map((entry) => entry.module);
	if (!rankedModules.length) return null;
	const files = [...new Set(rankedModules.flatMap((module) => module.importantFiles.slice(0, 4)))].sort();
	return createPack(input, 'flow', `flow-${slug(flowName)}`, [
		node(`code-flow:${slug(flowName)}`, `${flowName} flow surface`, `flow/${slug(flowName)}`, [
			`Flow: ${flowName}`,
			`Matched modules: ${rankedModules.map((module) => module.path).join(', ')}`,
			`Source files: ${files.join(', ')}`,
		].join('\n'), {
			codeContextKind: 'flow',
			sourceFiles: files,
			sourceSymbolsOrSections: rankedModules.flatMap((module) => module.exportedSymbols).slice(0, 24),
			repoRef: input.inventory.repoRef,
		}),
		...rankedModules.map((module) => node(`code-module:${module.path}`, `${module.path} module surface`, module.path, moduleText(module), {
			codeContextKind: 'module_surface',
			sourceFiles: module.importantFiles,
			sourceSymbolsOrSections: module.exportedSymbols,
			repoRef: input.inventory.repoRef,
		})),
	], []);
}

export function buildCodeContextPacksForQuery(input: CodeContextPackBuilderInput): ResolvedHandlerContextPack[] {
	const scopes = input.query.codeScopes ?? [];
	if (!scopes.length) return [];
	const packs: ResolvedHandlerContextPack[] = [];
	const seen = new Set<string>();
	for (const scope of scopes) {
		const normalizedScope = normalize(scope);
		const flow = /^flow[:/]/iu.test(scope) ? flowPack(input, scope) : null;
		if (flow && !seen.has(flow.id)) {
			packs.push(flow);
			seen.add(flow.id);
			continue;
		}
		for (const pkg of input.inventory.packages.filter((entry) => scopeMatchesPackage(normalizedScope, entry))) {
			const pack = packagePack(input, pkg);
			if (!seen.has(pack.id)) {
				packs.push(pack);
				seen.add(pack.id);
			}
		}
		for (const module of input.inventory.modules.filter((entry) => scopeMatchesModule(normalizedScope, entry))) {
			const pack = modulePack(input, module);
			if (!seen.has(pack.id)) {
				packs.push(pack);
				seen.add(pack.id);
			}
		}
	}
	return packs.sort((left, right) => left.id.localeCompare(right.id));
}
