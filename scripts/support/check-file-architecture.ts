import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

function repositoryFiles() {
	const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(result.stderr || 'Unable to enumerate repository files.');
	return result.stdout.split('\0').filter(Boolean).filter(existsSync);
}

const violations: string[] = [];
const executableExtensions = /\.(?:astro|c|cjs|cts|ex|exs|h|js|jsx|mjs|mts|py|rs|sh|ts|tsx)$/u;
const excludedSegments = new Set([
	'.astro', '.git', '.treeseed', '_build', 'build', 'coverage', 'deps', 'dist', 'generated',
	'migrations', 'node_modules', 'snapshots', 'target', 'vendor',
]);
const isExcluded = (path: string) => path.split('/').some((segment) =>
	excludedSegments.has(segment) || segment.startsWith('.treeseed-'));
const isExecutable = (path: string) => executableExtensions.test(path) && !isExcluded(path);
const directFileCounts = new Map<string, number>();

function brandedIdentifier(name: string) {
	if (/^TREESEED_[A-Z0-9_]+$/u.test(name)) return false;
	if (/^__TREESEED_[A-Z0-9_]+__$/u.test(name)) return false;
	return /(?:KnowledgeCoop|TreeSeed|Treeseed|TREESEED_)/u.test(name);
}

function identifierText(name: ts.DeclarationName | ts.BindingName | undefined): string[] {
	if (!name) return [];
	if (ts.isIdentifier(name)) return [name.text];
	if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
		return name.elements.flatMap((element) =>
			ts.isBindingElement(element) ? identifierText(element.name) : []);
	}
	return [];
}

function checkTypeScriptDeclarations(path: string, source: string) {
	const executableSource = path.endsWith('.astro')
		? source.match(/^---\s*([\s\S]*?)\s*---/u)?.[1] ?? ''
		: source;
	const sourceFile = ts.createSourceFile(
		path,
		executableSource,
		ts.ScriptTarget.Latest,
		true,
		path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node)
			|| ts.isParameter(node)
			|| ts.isFunctionDeclaration(node)
			|| ts.isClassDeclaration(node)
			|| ts.isInterfaceDeclaration(node)
			|| ts.isTypeAliasDeclaration(node)
			|| ts.isEnumDeclaration(node)
			|| ts.isMethodDeclaration(node)
			|| ts.isMethodSignature(node)
			|| ts.isPropertyDeclaration(node)
			|| ts.isPropertySignature(node)
			|| ts.isEnumMember(node)
			|| ts.isModuleDeclaration(node)
		) {
			for (const name of identifierText(node.name)) {
				if (brandedIdentifier(name)) violations.push(`${path}: redundant product name in symbol ${name}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

for (const path of repositoryFiles()) {
	const basename = path.split('/').at(-1) ?? path;
	if (isExecutable(path)) {
		directFileCounts.set(dirname(path), (directFileCounts.get(dirname(path)) ?? 0) + 1);
		if (/(?:knowledge[-_]?coop|tree[-_]?seed|treeseed)/iu.test(basename)) {
			violations.push(`${path}: redundant product name in executable filename`);
		}
	}
	for (const segment of path.split('/').slice(0, -1)) {
		if (/^(?:chunk|module|part|section|segment)-\d+$/u.test(segment)) {
			violations.push(`${path}: generic numbered directory partition ${segment}`);
		}
	}
	if (/^(?:chunk|module|part|section|segment)-\d+\./u.test(basename)) {
		violations.push(`${path}: generic numbered partition`);
	}
	if (/-\d{1,2}\.(?:scenarios|spec|test)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: ordinal test or scenario suffix`);
	}
	if (path.startsWith('src/api/routes/') && basename.includes('-through-')) {
		violations.push(`${path}: route-order range name`);
	}
	if (/split-(?:class-methods|large-tests|module-declarations)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: mechanical split script`);
	}
	if (path.startsWith('scripts/') && /\.(?:spec|test)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: test belongs under tests/`);
	}
	if (/\.(?:astro|js|jsx|ts|tsx)$/u.test(path)) {
		const source = readFileSync(path, 'utf8');
		if (/\b(?:CLI_COMMAND_OVERLAYS|CLI_ONLY_OPERATION_SPECS|MODULE|PART)_\d+\b/u.test(source)) {
			violations.push(`${path}: ordinal partition symbol`);
		}
		checkTypeScriptDeclarations(path, source);
	}
}

for (const [directory, count] of directFileCounts) {
	if (count > 10) violations.push(`${directory}: ${count} direct executable files exceeds the limit of 10`);
}

if (existsSync('test') && existsSync('tests')) {
	violations.push('test and tests: duplicate TypeScript test roots');
}

if (violations.length > 0) {
	console.error('File architecture policy failed:');
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}

console.log('File architecture policy passed: filenames and test roots express functional ownership.');
