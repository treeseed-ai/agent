import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const CODEBASE_DOCUMENTATION_SCAN_TASK_KIND = 'scan_codebase_documentation_surface' as const;

export const CODEBASE_DOCUMENTATION_SCAN_TARGETS = [
	'packages/agent/src/index.ts',
	'packages/agent/src/agents/**',
	'packages/agent/src/services/**',
	'packages/agent/src/api/**',
	'packages/sdk/src/**',
	'packages/cli/src/cli/**',
	'packages/core/src/**',
	'src/components/app/operations/**',
	'src/pages/app/**',
	'src/pages/v1/**',
	'src/content/**',
	'docs/**',
	'packages/sdk/drizzle/**',
] as const;

const DEFAULT_IGNORED_SEGMENTS = new Set([
	'.git',
	'.treeseed',
	'.agent-worktrees',
	'node_modules',
	'dist',
	'build',
	'coverage',
	'.turbo',
	'.cache',
]);

const DEFAULT_IGNORED_PREFIXES = [
	'.treeseed/exports/',
	'.treeseed/worktrees/',
	'.treeseed/generated/',
	'.agent-worktrees/',
] as const;

const DOCUMENTATION_TARGETS = ['docs/**', 'src/content/knowledge/**'] as const;

export interface DocsCoverageLink {
	path: string;
	kind: 'direct_source_path' | 'keyword_match';
	evidence: 'direct' | 'supporting';
	matched: string[];
}

export interface KnowledgeGap {
	id: string;
	surfacePath: string;
	surfaceKind: 'package' | 'module';
	severity: 'high' | 'medium' | 'low';
	summary: string;
	recommendedTaskKind: 'research_code_surface';
	sourcePaths: string[];
}

export interface ModuleSurfaceInventory {
	path: string;
	packageName: 'agent' | 'sdk' | 'cli' | 'core' | 'market';
	responsibility: string;
	fileCount: number;
	importantFiles: string[];
	exportedSymbols: string[];
	imports: string[];
	tests: string[];
	relatedDocs: DocsCoverageLink[];
	warnings: string[];
}

export interface PackageSurfaceInventory {
	name: 'agent' | 'sdk' | 'cli' | 'core' | 'market';
	purpose: string;
	root: string;
	entrypoints: string[];
	publicExports: string[];
	commands: string[];
	runtimeServices: string[];
	moduleCount: number;
	fileCount: number;
	tests: string[];
	relatedDocs: DocsCoverageLink[];
	knownGaps: string[];
	modules: ModuleSurfaceInventory[];
	warnings: string[];
}

export interface CodebaseInventoryArtifact {
	id: string;
	kind: 'codebase_inventory';
	title: string;
	generatedAt: string;
	graphVersion: string | null;
	repoRef: string;
	scanTargets: string[];
	ignoredPatterns: string[];
	packages: PackageSurfaceInventory[];
	modules: ModuleSurfaceInventory[];
	knowledgeGaps: KnowledgeGap[];
	warnings: string[];
}

export interface ScanCodebaseDocumentationSurfaceInput {
	repoRoot: string;
	graphVersion?: string | null;
	now?: Date;
	repoRef?: string | null;
}

interface TargetSpec {
	pattern: string;
	basePath: string;
	exactFile: boolean;
}

interface DocumentationSurface {
	path: string;
	title: string;
	text: string;
	tokens: string[];
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/^\/+/u, '');
}

function uniqueSorted(values: string[]) {
	return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function targetSpec(pattern: string): TargetSpec {
	const normalized = normalizePath(pattern);
	return normalized.endsWith('/**')
		? { pattern: normalized, basePath: normalized.slice(0, -3), exactFile: false }
		: { pattern: normalized, basePath: normalized, exactFile: true };
}

function isIgnored(relativePath: string) {
	const normalized = normalizePath(relativePath);
	const basename = path.basename(normalized);
	if (basename.startsWith('.ts-run-')) {
		return true;
	}
	if (DEFAULT_IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
		return true;
	}
	return normalized.split('/').some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}

function fileMatchesTarget(relativePath: string, target: TargetSpec) {
	const normalized = normalizePath(relativePath);
	return target.exactFile
		? normalized === target.basePath
		: normalized === target.basePath || normalized.startsWith(`${target.basePath}/`);
}

function listFiles(repoRoot: string, relativeRoot = ''): string[] {
	const absoluteRoot = path.join(repoRoot, relativeRoot);
	if (!existsSync(absoluteRoot)) return [];
	const stat = statSync(absoluteRoot);
	if (stat.isFile()) {
		return [normalizePath(relativeRoot)];
	}
	if (!stat.isDirectory() || isIgnored(relativeRoot)) {
		return [];
	}
	const files: string[] = [];
	for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
		const nextRelative = normalizePath(path.join(relativeRoot, entry.name));
		if (isIgnored(nextRelative)) continue;
		if (entry.isDirectory()) {
			files.push(...listFiles(repoRoot, nextRelative));
		} else if (entry.isFile()) {
			files.push(nextRelative);
		}
	}
	return files;
}

function readText(repoRoot: string, relativePath: string) {
	try {
		return readFileSync(path.join(repoRoot, relativePath), 'utf8');
	} catch {
		return '';
	}
}

function scanFilesForTargets(repoRoot: string) {
	const targets = CODEBASE_DOCUMENTATION_SCAN_TARGETS.map(targetSpec);
	const roots = uniqueSorted(targets.map((target) => target.exactFile ? path.dirname(target.basePath) : target.basePath));
	const candidates = uniqueSorted(roots.flatMap((root) => listFiles(repoRoot, root)));
	return candidates.filter((candidate) => targets.some((target) => fileMatchesTarget(candidate, target)));
}

function packageForPath(relativePath: string): ModuleSurfaceInventory['packageName'] {
	if (relativePath.startsWith('packages/agent/')) return 'agent';
	if (relativePath.startsWith('packages/sdk/')) return 'sdk';
	if (relativePath.startsWith('packages/cli/')) return 'cli';
	if (relativePath.startsWith('packages/core/')) return 'core';
	return 'market';
}

function packageRoot(name: ModuleSurfaceInventory['packageName']) {
	return name === 'market' ? '.' : `packages/${name}`;
}

function packagePurpose(name: ModuleSurfaceInventory['packageName']) {
	switch (name) {
		case 'agent':
			return 'Agent runtime, handlers, workday services, worker execution, and documentation automation orchestration.';
		case 'sdk':
			return 'Shared platform SDK, content graph, stores, workflow operations, and runtime substrate.';
		case 'cli':
			return 'Operator and developer CLI workflows for TreeSeed projects and workspaces.';
		case 'core':
			return 'Core site runtime, content model, integrated dev runtime, forms, and platform surfaces.';
		case 'market':
		default:
			return 'Top-level Market application content, governance UI surfaces, pages, migrations, and documentation.';
	}
}

function responsibilityForModule(modulePath: string) {
	if (modulePath.includes('/agents')) return 'Agent definitions, handlers, contracts, context, and runtime behavior.';
	if (modulePath.includes('/services')) return 'Service orchestration, manager, worker, workday, promotion, and operational flows.';
	if (modulePath.includes('/api')) return 'HTTP API routes and state collectors for operational governance.';
	if (modulePath.includes('/cli')) return 'CLI command parsing, registry, and command handlers.';
	if (modulePath.includes('/components/app/operations')) return 'Operational app UI components for workdays, governance, knowledge, and infrastructure.';
	if (modulePath.includes('/pages/app')) return 'Application routes for Mission Control, Workdays, Governance, Knowledge, and Infrastructure.';
	if (modulePath.includes('/pages/v1')) return 'Versioned API route entrypoints.';
	if (modulePath.includes('/content')) return 'Content-backed TreeSeed project records and public knowledge surfaces.';
	if (modulePath === 'docs' || modulePath.startsWith('docs/')) return 'Developer and agent-facing documentation plans and references.';
	if (modulePath === 'packages/sdk/drizzle' || modulePath.startsWith('packages/sdk/drizzle/')) return 'Drizzle-generated database migration artifacts for Market PostgreSQL and SDK D1 runtime state.';
	if (modulePath === 'packages/sdk/src') return 'SDK source surfaces, graph, stores, workflow, platform, and operations contracts.';
	if (modulePath === 'packages/core/src') return 'Core source surfaces for content, platform, Astro runtime, components, and utilities.';
	return `TreeSeed implementation surface at ${modulePath}.`;
}

function parseFrontmatterTitle(text: string) {
	const match = /^---\s*([\s\S]*?)\s*---/u.exec(text);
	if (!match) return '';
	const title = /^title:\s*(.+)$/mu.exec(match[1] ?? '');
	return title?.[1]?.replace(/^["']|["']$/gu, '').trim() ?? '';
}

function tokenize(value: string) {
	const stop = new Set(['src', 'index', 'test', 'tests', 'packages', 'content', 'components', 'pages', 'docs', 'migrations', 'the', 'and', 'for', 'with']);
	return uniqueSorted(
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, ' ')
			.split(/\s+/u)
			.filter((token) => token.length >= 4 && !stop.has(token)),
	);
}

function documentationSurfaces(repoRoot: string): DocumentationSurface[] {
	const docsTargets = DOCUMENTATION_TARGETS.map(targetSpec);
	return uniqueSorted(docsTargets.flatMap((target) => listFiles(repoRoot, target.basePath)))
		.filter((file) => /\.(md|mdx)$/iu.test(file))
		.map((file) => {
			const text = readText(repoRoot, file);
			const title = parseFrontmatterTitle(text) || path.basename(file).replace(/\.(md|mdx)$/iu, '');
			return {
				path: file,
				title,
				text,
				tokens: tokenize(`${file} ${title}`),
			};
		});
}

function extractSymbolsAndImports(repoRoot: string, files: string[]) {
	const exported: string[] = [];
	const imports: string[] = [];
	for (const file of files.filter((entry) => /\.(ts|tsx|js|jsx|mjs|mts|cts)$/iu.test(entry)).sort()) {
		const sourceText = readText(repoRoot, file);
		const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, false);
		for (const statement of source.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
				imports.push(statement.moduleSpecifier.text);
			}
			const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
			const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
			if (!isExported) continue;
			if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
				exported.push(statement.name.text);
			}
			if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name)) exported.push(declaration.name.text);
				}
			}
			if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					exported.push(element.name.text);
				}
			}
		}
	}
	return {
		exportedSymbols: uniqueSorted(exported),
		imports: uniqueSorted(imports),
	};
}

function relatedDocsForSurface(surfacePath: string, files: string[], docs: DocumentationSurface[]): DocsCoverageLink[] {
	const directCandidates = uniqueSorted([surfacePath, ...files]);
	const surfaceTokens = tokenize(surfacePath);
	const links: DocsCoverageLink[] = [];
	for (const doc of docs) {
		const directMatches = directCandidates.filter((candidate) => doc.text.includes(candidate));
		if (directMatches.length > 0) {
			links.push({
				path: doc.path,
				kind: 'direct_source_path',
				evidence: 'direct',
				matched: directMatches.slice(0, 8),
			});
			continue;
		}
		const matchedTokens = surfaceTokens.filter((token) => doc.tokens.includes(token));
		if (matchedTokens.length >= 2) {
			links.push({
				path: doc.path,
				kind: 'keyword_match',
				evidence: 'supporting',
				matched: matchedTokens.slice(0, 8),
			});
		}
	}
	return links.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

function importantFiles(files: string[]) {
	const preferred = files.filter((file) =>
		/(^|\/)(index|main|registry|manager|worker|content|content-config|sdk|cli|api|app|schema|types)\.(ts|tsx|js|mjs|md|mdx|yaml|json)$/iu.test(file),
	);
	return uniqueSorted([...preferred, ...files]).slice(0, 12);
}

function testsForModule(repoRoot: string, packageName: ModuleSurfaceInventory['packageName'], modulePath: string) {
	const roots = packageName === 'market'
		? ['test']
		: [`packages/${packageName}/test`];
	const moduleName = modulePath.split('/').filter(Boolean).at(-1) ?? packageName;
	return uniqueSorted(roots.flatMap((root) => listFiles(repoRoot, root)))
		.filter((file) => /\.(test|spec)\.(ts|tsx|js|mjs)$/iu.test(file))
		.filter((file) => file.includes(moduleName) || file.includes(packageName))
		.slice(0, 12);
}

function buildModuleInventories(repoRoot: string, scanFiles: string[], docs: DocumentationSurface[]): ModuleSurfaceInventory[] {
	return CODEBASE_DOCUMENTATION_SCAN_TARGETS.map(targetSpec).flatMap((target) => {
		const moduleFiles = scanFiles.filter((file) => fileMatchesTarget(file, target));
		if (!moduleFiles.length) {
			return [];
		}
		const packageName = packageForPath(target.basePath);
		const parsed = extractSymbolsAndImports(repoRoot, moduleFiles);
		const relatedDocs = relatedDocsForSurface(target.basePath, moduleFiles, docs);
		const warnings = target.exactFile && moduleFiles.length !== 1
			? [`Expected exact file target ${target.basePath} to resolve to one file.`]
			: [];
		return [{
			path: target.basePath,
			packageName,
			responsibility: responsibilityForModule(target.basePath),
			fileCount: moduleFiles.length,
			importantFiles: importantFiles(moduleFiles),
			exportedSymbols: parsed.exportedSymbols,
			imports: parsed.imports,
			tests: testsForModule(repoRoot, packageName, target.basePath),
			relatedDocs,
			warnings,
		}];
	}).sort((left, right) => left.path.localeCompare(right.path));
}

function buildPackageInventories(modules: ModuleSurfaceInventory[], docs: DocumentationSurface[]): PackageSurfaceInventory[] {
	const names: ModuleSurfaceInventory['packageName'][] = ['agent', 'sdk', 'cli', 'core', 'market'];
	return names.map((name) => {
		const packageModules = modules.filter((module) => module.packageName === name);
		const root = packageRoot(name);
		const entrypoints = packageModules.flatMap((module) =>
			module.importantFiles.filter((file) => /(^|\/)(index|main|cli)\.(ts|tsx|js|mjs)$/iu.test(file)),
		);
		const files = uniqueSorted(packageModules.flatMap((module) => module.importantFiles));
		const commands = name === 'cli'
			? uniqueSorted(packageModules.flatMap((module) => module.importantFiles.filter((file) => file.includes('/cli/')))).slice(0, 12)
			: [];
		return {
			name,
			purpose: packagePurpose(name),
			root,
			entrypoints: uniqueSorted(entrypoints).slice(0, 10),
			publicExports: uniqueSorted(packageModules.flatMap((module) => module.exportedSymbols)).slice(0, 32),
			commands,
			runtimeServices: uniqueSorted(packageModules.filter((module) => module.path.includes('/services')).map((module) => module.path)),
			moduleCount: packageModules.length,
			fileCount: packageModules.reduce((total, module) => total + module.fileCount, 0),
			tests: uniqueSorted(packageModules.flatMap((module) => module.tests)).slice(0, 16),
			relatedDocs: relatedDocsForSurface(root === '.' ? 'src' : root, files, docs),
			knownGaps: [],
			modules: packageModules,
			warnings: packageModules.length ? [] : [`No approved scan target resolved for ${name}.`],
		};
	});
}

function gapId(surfacePath: string) {
	return `knowledge-gap:${surfacePath.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase()}`;
}

function buildKnowledgeGaps(modules: ModuleSurfaceInventory[], packages: PackageSurfaceInventory[]): KnowledgeGap[] {
	const moduleGaps = modules
		.filter((module) => !module.relatedDocs.some((doc) => doc.kind === 'direct_source_path'))
		.map((module): KnowledgeGap => ({
			id: gapId(module.path),
			surfacePath: module.path,
			surfaceKind: 'module',
			severity: module.fileCount >= 8 ? 'high' : 'medium',
			summary: `No direct documentation source-map coverage was found for ${module.path}.`,
			recommendedTaskKind: 'research_code_surface',
			sourcePaths: module.importantFiles.slice(0, 5),
		}));
	const packageGaps = packages
		.filter((entry) => entry.moduleCount > 0 && !entry.relatedDocs.some((doc) => doc.kind === 'direct_source_path'))
		.map((entry): KnowledgeGap => ({
			id: gapId(entry.root === '.' ? 'market' : entry.root),
			surfacePath: entry.root,
			surfaceKind: 'package',
			severity: 'medium',
			summary: `No direct package-level documentation coverage was found for ${entry.name}.`,
			recommendedTaskKind: 'research_code_surface',
			sourcePaths: entry.entrypoints.length ? entry.entrypoints.slice(0, 5) : entry.modules.flatMap((module) => module.importantFiles).slice(0, 5),
		}));
	const severityRank: Record<KnowledgeGap['severity'], number> = { high: 0, medium: 1, low: 2 };
	return [...moduleGaps, ...packageGaps].sort((left, right) =>
		severityRank[left.severity] - severityRank[right.severity] || left.surfacePath.localeCompare(right.surfacePath),
	);
}

export function scanCodebaseDocumentationSurface(input: ScanCodebaseDocumentationSurfaceInput): CodebaseInventoryArtifact {
	const repoRoot = path.resolve(input.repoRoot);
	const generatedAt = (input.now ?? new Date()).toISOString();
	const scanFiles = scanFilesForTargets(repoRoot);
	const docs = documentationSurfaces(repoRoot);
	const modules = buildModuleInventories(repoRoot, scanFiles, docs);
	const packageInventories = buildPackageInventories(modules, docs);
	const knowledgeGaps = buildKnowledgeGaps(modules, packageInventories);
	const packages = packageInventories.map((entry) => ({
		...entry,
		knownGaps: knowledgeGaps
			.filter((gap) => gap.surfacePath === entry.root || entry.modules.some((module) => module.path === gap.surfacePath))
			.map((gap) => gap.id),
	}));
	const warnings = CODEBASE_DOCUMENTATION_SCAN_TARGETS
		.map(targetSpec)
		.filter((target) => !scanFiles.some((file) => fileMatchesTarget(file, target)))
		.map((target) => `Scan target ${target.pattern} did not resolve to any files.`);

	return {
		id: `codebase_inventory:${generatedAt.slice(0, 10)}`,
		kind: 'codebase_inventory',
		title: 'TreeSeed Codebase Documentation Surface Inventory',
		generatedAt,
		graphVersion: input.graphVersion ?? null,
		repoRef: input.repoRef ?? 'local',
		scanTargets: [...CODEBASE_DOCUMENTATION_SCAN_TARGETS],
		ignoredPatterns: [
			'.git/**',
			'node_modules/**',
			'.treeseed/**',
			'.agent-worktrees/**',
			'dist/**',
			'build/**',
			'coverage/**',
		],
		packages,
		modules,
		knowledgeGaps,
		warnings,
	};
}

export function summarizeCodebaseInventoryArtifact(inventory: CodebaseInventoryArtifact, taskId?: string) {
	return {
		artifactKind: 'codebase_inventory' as const,
		id: inventory.id,
		title: inventory.title,
		taskId,
		sourceRefs: uniqueSorted(inventory.modules.flatMap((module) => module.importantFiles)).slice(0, 20),
		totalScore: inventory.knowledgeGaps.length,
	};
}
