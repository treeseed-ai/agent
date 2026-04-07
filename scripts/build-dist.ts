import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { packageRoot } from './package-tools.ts';

const srcRoot = resolve(packageRoot, 'src');
const scriptsRoot = resolve(packageRoot, 'scripts');
const distRoot = resolve(packageRoot, 'dist');

const COPY_EXTENSIONS = new Set(['.d.ts', '.json', '.md']);

function walkFiles(root) {
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(fullPath));
		else files.push(fullPath);
	}
	return files;
}

function ensureDir(filePath) {
	mkdirSync(dirname(filePath), { recursive: true });
}

function rewriteRuntimeSpecifiers(contents) {
	return contents
		.replace(/(['"`])(\.[^'"`\n]+)\.(mjs|ts)\1/g, '$1$2.js$1')
		.replace(/(['"`])\.\.\/src\//g, '$1../');
}

async function compileModule(filePath, sourceRoot, outputRoot) {
	const relativePath = relative(sourceRoot, filePath);
	const outputFile = resolve(outputRoot, relativePath.replace(/\.(mjs|ts)$/u, '.js'));
	ensureDir(outputFile);
	await build({
		entryPoints: [filePath],
		outfile: outputFile,
		platform: 'node',
		format: 'esm',
		bundle: false,
		logLevel: 'silent',
	});
	const builtSource = readFileSync(outputFile, 'utf8');
	writeFileSync(outputFile, rewriteRuntimeSpecifiers(builtSource), 'utf8');
}

function copyAsset(filePath, sourceRoot, outputRoot) {
	const outputFile = resolve(outputRoot, relative(sourceRoot, filePath));
	ensureDir(outputFile);
	copyFileSync(filePath, outputFile);
	if (outputFile.endsWith('.d.ts')) {
		writeFileSync(outputFile, rewriteRuntimeSpecifiers(readFileSync(outputFile, 'utf8')), 'utf8');
	}
}

function transpileScript(filePath) {
	const source = readFileSync(filePath, 'utf8');
	const relativePath = relative(scriptsRoot, filePath);
	const outputFile = resolve(distRoot, 'scripts', relativePath.replace(/\.(mjs|ts)$/u, '.js'));
	const transformed = extname(filePath) === '.ts'
		? ts.transpileModule(source, {
				compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
			}).outputText
		: source;
	ensureDir(outputFile);
	writeFileSync(outputFile, rewriteRuntimeSpecifiers(transformed), 'utf8');
	chmodSync(outputFile, 0o755);
}

function emitDeclarations() {
	const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.json');
	if (!configPath) throw new Error('Unable to locate tsconfig.json for declaration build.');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: { ...parsed.options, declaration: true, emitDeclarationOnly: true, declarationDir: distRoot, noEmit: false },
	});
	const result = program.emit();
	if (result.emitSkipped) throw new Error('Declaration build failed.');
}

rmSync(distRoot, { recursive: true, force: true });

for (const filePath of walkFiles(srcRoot)) {
	const extension = extname(filePath);
	if (extension === '.ts') await compileModule(filePath, srcRoot, distRoot);
	else if (COPY_EXTENSIONS.has(extension)) copyAsset(filePath, srcRoot, distRoot);
}

for (const filePath of walkFiles(scriptsRoot)) {
	const extension = extname(filePath);
	if (extension === '.ts' || extension === '.ts') transpileScript(filePath);
}

emitDeclarations();

if (existsSync(resolve(packageRoot, 'README.md'))) {
	copyFileSync(resolve(packageRoot, 'README.md'), resolve(distRoot, '..', 'README.md'));
}
if (existsSync(resolve(packageRoot, 'Dockerfile'))) {
	copyFileSync(resolve(packageRoot, 'Dockerfile'), resolve(distRoot, '..', 'Dockerfile'));
}
