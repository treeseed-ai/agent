import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import ts from 'typescript';

const MAX_LINES = 500;
const TARGET_LINES = 340;

function isSuiteStatement(statement: ts.Statement) {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
	const expression = statement.expression.expression;
	return ts.isIdentifier(expression) && ['describe', 'it', 'test'].includes(expression.text);
}

function suiteName(statement: ts.Statement) {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return 'scenarios';
	const argument = statement.expression.arguments[0];
	if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) return 'scenarios';
	return argument.text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'scenarios';
}

function describeBody(statement: ts.Statement) {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
	const expression = statement.expression.expression;
	if (!ts.isIdentifier(expression) || expression.text !== 'describe') return null;
	const callback = statement.expression.arguments[1];
	if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) return null;
	return { call: statement.expression, callback, body: callback.body };
}

function renderDescribe(source: ts.SourceFile, statement: ts.Statement, bodyStatements: ts.Statement[]) {
	const details = describeBody(statement);
	if (!details) return statement.getFullText(source).trim();
	const expressionText = details.call.expression.getText(source);
	const firstArgument = details.call.arguments[0]?.getText(source) ?? "'suite'";
	const asyncPrefix = details.callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
	const body = bodyStatements.map((item) => item.getFullText(source).trim()).join('\n\n');
	return `${expressionText}(${firstArgument}, ${asyncPrefix}() => {\n${body}\n});`;
}

function chunksFor(source: ts.SourceFile, prefix: string, shared: ts.Statement[], scenarios: ts.Statement[]) {
	const sharedText = shared.map((item) => item.getFullText(source).trim()).join('\n\n');
	const fixedLines = `${prefix}\n${sharedText}`.split('\n').length + 4;
	const chunks: ts.Statement[][] = [];
	let current: ts.Statement[] = [];
	let currentLines = fixedLines;
	for (const scenario of scenarios) {
		const lines = scenario.getFullText(source).split('\n').length + 2;
		if (current.length > 0 && currentLines + lines > TARGET_LINES) {
			chunks.push(current);
			current = [];
			currentLines = fixedLines;
		}
		current.push(scenario);
		currentLines += lines;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function outputPath(path: string, label: string, index: number) {
	const extension = extname(path);
	const stem = basename(path, extension).replace(/\.test$/, '');
	return join(dirname(path), `${stem}.${label}-${index + 1}.test${extension}`);
}

function declaredNames(statement: ts.Statement) {
	const names: string[] = [];
	const addName = (name: ts.BindingName | ts.DeclarationName | undefined) => {
		if (!name) return;
		if (ts.isIdentifier(name)) names.push(name.text);
		else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
			for (const element of name.elements) if (ts.isBindingElement(element)) addName(element.name);
		}
	};
	if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) addName(declaration.name);
	else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) addName(statement.name);
	return names;
}

function exportStatement(source: ts.SourceFile, statement: ts.Statement) {
	const text = statement.getFullText(source).trim();
	if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return text;
	return declaredNames(statement).length > 0 ? `export ${text}` : text;
}

function compact(text: string) {
	return text
		.split('\n')
		.filter((line, lineIndex, lines) => line.trim() !== '' || (lineIndex > 0 && lines[lineIndex - 1]?.trim() !== ''))
		.join('\n');
}

function split(path: string) {
	const text = readFileSync(path, 'utf8');
	if (text.split('\n').length <= MAX_LINES) return;
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const suites = source.statements.filter(isSuiteStatement);
	const prefixStatements = source.statements.filter((statement) => !isSuiteStatement(statement));
	let prefix = prefixStatements.map((statement) => statement.getFullText(source).trim()).join('\n\n');
	const outputs: Array<{ label: string; suite: ts.Statement; statements: ts.Statement[] }> = [];
	for (const suite of suites) {
		const details = describeBody(suite);
		if (!details) {
			outputs.push({ label: suiteName(suite), suite, statements: [] });
			continue;
		}
		const shared = details.body.statements.filter((statement) => !isSuiteStatement(statement));
		const scenarios = details.body.statements.filter(isSuiteStatement);
		for (const statements of chunksFor(source, prefix, shared, scenarios)) {
			outputs.push({ label: suiteName(statements[0] ?? suite), suite, statements: [...shared, ...statements] });
		}
	}
	if (outputs.length < 2) throw new Error(`${path}: could not identify multiple independently runnable scenario groups`);
	const used = new Set<string>();
	let support: { path: string; text: string; names: string[] } | null = null;
	const renderOutput = (output: typeof outputs[number]) => compact(`${prefix}\n${renderDescribe(source, output.suite, output.statements)}\n`);
	if (outputs.some((output) => renderOutput(output).split('\n').length > MAX_LINES)) {
		const imports = prefixStatements.filter(ts.isImportDeclaration);
		const declarations = prefixStatements.filter((statement) => !ts.isImportDeclaration(statement) && declaredNames(statement).length > 0);
		const retained = prefixStatements.filter((statement) => ts.isImportDeclaration(statement) || declaredNames(statement).length === 0);
		const names = declarations.flatMap(declaredNames);
		const supportPath = join(dirname(path), `${basename(path).replace(/\.test\.ts$/, '')}.support.ts`);
		const supportText = compact(`${imports.map((statement) => statement.getFullText(source).trim()).join('\n')}\n${declarations.map((statement) => exportStatement(source, statement)).join('\n')}\n`);
		if (supportText.split('\n').length > MAX_LINES) throw new Error(`${supportPath}: extracted support is ${supportText.split('\n').length} lines`);
		support = { path: supportPath, text: supportText, names };
		prefix = `${retained.map((statement) => statement.getFullText(source).trim()).join('\n')}\nimport { ${names.join(', ')} } from './${basename(supportPath)}';`;
	}
	const renderedOutputs = outputs.map((output, index) => {
		let destination = outputPath(path, output.label, index);
		while (used.has(destination) || (existsSync(destination) && destination !== path)) destination = outputPath(path, output.label, index + used.size + 1);
		used.add(destination);
		const rendered = renderOutput(output);
		if (rendered.split('\n').length > MAX_LINES) throw new Error(`${destination}: generated ${rendered.split('\n').length} lines`);
		return { destination, rendered };
	});
	if (support) writeFileSync(support.path, `${support.text}\n`, 'utf8');
	for (const output of renderedOutputs) writeFileSync(output.destination, output.rendered, 'utf8');
	unlinkSync(path);
	console.log(`${path}: ${outputs.length} focused files`);
}

for (const path of process.argv.slice(2)) split(path);
