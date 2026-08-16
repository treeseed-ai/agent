import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { packageRoot } from '../packages/package-tools.ts';

const srcRoot = resolve(packageRoot, 'src');
const scriptsRoot = resolve(packageRoot, 'scripts');
const templatesRoot = resolve(packageRoot, 'templates');
const distRoot = resolve(packageRoot, 'dist');
const buildLock = resolve(packageRoot, '.treeseed', 'build-dist.lock');

const JS_SOURCE_EXTENSIONS = new Set(['.ts']);
const COPY_EXTENSIONS = new Set(['.d.ts', '.json', '.jsonc', '.md', '.yaml', '.yml']);

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
		.replace(/(['"`])((?:\.\.\/)+)src\//g, '$1$2');
}

async function compileModule(filePath, sourceRoot, outputRoot) {
	const relativePath = relative(sourceRoot, filePath);
	const outputFile = resolve(outputRoot, relativePath.replace(/\.ts$/u, '.js'));
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
	const outputFile = resolve(distRoot, 'scripts', relativePath.replace(/\.ts$/u, '.js'));
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
	const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.dist.json')
		?? ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.json');
	if (!configPath) throw new Error('Unable to locate a tsconfig for declaration build.');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: {
			...parsed.options,
			declaration: true,
			emitDeclarationOnly: true,
			declarationDir: distRoot,
			noEmit: false,
			noEmitOnError: true,
			noCheck: false,
		},
	});
	const result = program.emit();
	const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
	if (result.emitSkipped || diagnostics.length > 0) {
		const rendered = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (fileName) => fileName,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => '\n',
		});
		throw new Error(`Declaration build failed.\n${rendered}`);
	}
}

async function acquireBuildLock() {
	mkdirSync(dirname(buildLock), { recursive: true });
	while (true) {
		try {
			mkdirSync(buildLock);
			writeFileSync(resolve(buildLock, 'owner'), `${process.pid}\n`, 'utf8');
			return;
		} catch (error) {
			const ownerPath = resolve(buildLock, 'owner');
			const owner = existsSync(ownerPath) ? Number(readFileSync(ownerPath, 'utf8').trim()) : Number.NaN;
			let active = false;
			if (Number.isInteger(owner) && owner > 0) {
				try { process.kill(owner, 0); active = true; } catch { active = false; }
			}
			if (!active) { rmSync(buildLock, { recursive: true, force: true }); continue; }
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
	}
}

await acquireBuildLock();
try {
	rmSync(distRoot, { recursive: true, force: true });

	for (const filePath of walkFiles(srcRoot)) {
		const extension = extname(filePath);
		if (JS_SOURCE_EXTENSIONS.has(extension)) await compileModule(filePath, srcRoot, distRoot);
		else if (COPY_EXTENSIONS.has(extension)) copyAsset(filePath, srcRoot, distRoot);
	}

	for (const filePath of walkFiles(scriptsRoot)) {
		const extension = extname(filePath);
		if (JS_SOURCE_EXTENSIONS.has(extension)) transpileScript(filePath);
	}

	emitDeclarations();

	if (existsSync(resolve(distRoot, 'src'))) {
		cpSync(resolve(distRoot, 'src'), distRoot, { recursive: true });
		rmSync(resolve(distRoot, 'src'), { recursive: true, force: true });
	}

	if (existsSync(templatesRoot)) {
		cpSync(templatesRoot, resolve(distRoot, 'templates'), { recursive: true });
	}
} finally {
	rmSync(buildLock, { recursive: true, force: true });
}
