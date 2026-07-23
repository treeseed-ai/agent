import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';

const TARGET_LINES = 280;
const MAX_LINES = 500;

function bindingNames(name: ts.BindingName | ts.DeclarationName | undefined): string[] {
	if (!name) return [];
	if (ts.isIdentifier(name)) return [name.text];
	if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
		return name.elements.flatMap((element) => ts.isBindingElement(element) ? bindingNames(element.name) : []);
	}
	return [];
}

function statementNames(statement: ts.Statement) {
	if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
	if (
		ts.isFunctionDeclaration(statement)
		|| ts.isClassDeclaration(statement)
		|| ts.isInterfaceDeclaration(statement)
		|| ts.isTypeAliasDeclaration(statement)
		|| ts.isEnumDeclaration(statement)
		|| ts.isModuleDeclaration(statement)
	) return bindingNames(statement.name);
	return [];
}

function kebab(value: string) {
	return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function identifiersIn(statements: ts.Statement[]) {
	const identifiers = new Set<string>();
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) identifiers.add(node.text);
		ts.forEachChild(node, visit);
	};
	for (const statement of statements) visit(statement);
	return identifiers;
}

function adjustedImport(source: ts.SourceFile, statement: ts.ImportDeclaration, used: Set<string>) {
	const clause = statement.importClause;
	if (!clause) return statement.getFullText(source).trim();
	const defaultName = clause.name && used.has(clause.name.text) ? clause.name : undefined;
	let bindings: ts.NamedImportBindings | undefined;
	if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
		if (used.has(clause.namedBindings.name.text)) bindings = clause.namedBindings;
	} else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
		const elements = clause.namedBindings.elements.filter((element) => used.has(element.name.text));
		if (elements.length > 0) bindings = ts.factory.updateNamedImports(clause.namedBindings, elements);
	}
	if (!defaultName && !bindings) return '';
	const specifier = ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')
		? ts.factory.createStringLiteral(`../${statement.moduleSpecifier.text}`)
		: statement.moduleSpecifier;
	const updated = ts.factory.updateImportDeclaration(
		statement,
		statement.modifiers,
		ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName, bindings),
		specifier,
		statement.attributes,
	);
	return ts.createPrinter().printNode(ts.EmitHint.Unspecified, updated, source).replace(/\s+/gu, ' ');
}

function exportedStatement(source: ts.SourceFile, statement: ts.Statement) {
	const text = statement.getFullText(source).trim();
	if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) return text;
	return statementNames(statement).length > 0 ? `export ${text}` : text;
}

function referencedNames(statement: ts.Statement, localNames: Set<string>, ownNames: Set<string>) {
	const references = new Set<string>();
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && localNames.has(node.text) && !ownNames.has(node.text)) references.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(statement);
	return references;
}

function split(path: string) {
	const text = readFileSync(path, 'utf8');
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const imports = source.statements.filter(ts.isImportDeclaration);
	const declarations = source.statements.filter((statement) => !ts.isImportDeclaration(statement));
	const chunks: ts.Statement[][] = [];
	let current: ts.Statement[] = [];
	let lines = 0;
	for (const statement of declarations) {
		const statementLines = statement.getFullText(source).split('\n').length;
		if (statementLines > MAX_LINES) throw new Error(`${path}: declaration ${statementNames(statement)[0] ?? statement.kind} is ${statementLines} lines`);
		if (current.length > 0 && lines + statementLines > TARGET_LINES) {
			chunks.push(current);
			current = [];
			lines = 0;
		}
		current.push(statement);
		lines += statementLines;
	}
	if (current.length > 0) chunks.push(current);
	if (chunks.length < 2) return;

	const extension = path.endsWith('.tsx') ? '.tsx' : '.ts';
	const stem = basename(path, extension);
	const outputDir = join(dirname(path), stem);
	mkdirSync(outputDir, { recursive: true });
	const used = new Set<string>();
	const parts = chunks.map((statements, index) => {
		const names = statements.flatMap(statementNames);
		let fileStem = kebab(names[0] ?? `module-${index + 1}`);
		if (used.has(fileStem)) fileStem = `${fileStem}-${index + 1}`;
		used.add(fileStem);
		return { statements, names, fileStem };
	});
	const owner = new Map(parts.flatMap((part) => part.names.map((name) => [name, part] as const)));
	const allNames = new Set(owner.keys());
	for (const part of parts) {
		const usedIdentifiers = identifiersIn(part.statements);
		const ownNames = new Set(part.names);
		const dependencies = new Map<typeof part, Set<string>>();
		for (const statement of part.statements) {
			for (const name of referencedNames(statement, allNames, ownNames)) {
				const dependency = owner.get(name);
				if (!dependency || dependency === part) continue;
				const names = dependencies.get(dependency) ?? new Set<string>();
				names.add(name);
				dependencies.set(dependency, names);
			}
		}
		const dependencyImports = [...dependencies.entries()]
			.map(([dependency, names]) => `import { ${[...names].sort().join(', ')} } from './${dependency.fileStem}${extension}';`);
		const body = part.statements.map((statement) => exportedStatement(source, statement)).join('\n\n');
		const output = `${imports.map((statement) => adjustedImport(source, statement, usedIdentifiers)).filter(Boolean).join('\n')}\n${dependencyImports.join('\n')}\n\n${body}\n`;
		if (output.split('\n').length > MAX_LINES) throw new Error(`${part.fileStem}.ts: generated ${output.split('\n').length} lines`);
		writeFileSync(join(outputDir, `${part.fileStem}${extension}`), output, 'utf8');
	}
	const exports = parts.flatMap((part) => {
		const path = `./${stem}/${part.fileStem}${extension}`;
		const hasDefault = part.statements.some((statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
		return [`export * from '${path}';`, ...(hasDefault ? [`export { default } from '${path}';`] : [])];
	});
	writeFileSync(path, `${exports.join('\n')}\n`, 'utf8');
	console.log(`${path}: ${parts.length} cohesive declaration modules`);
}

for (const path of process.argv.slice(2)) split(path);
