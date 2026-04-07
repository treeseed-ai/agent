#!/usr/bin/env node

import { build } from 'esbuild';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , entryArg, ...scriptArgs] = process.argv;

if (!entryArg) {
	console.error('Usage: node ./scripts/run-ts.mjs <entry.ts> [...args]');
	process.exit(1);
}

const cwd = process.cwd();
const entryPath = resolve(cwd, entryArg);
const outfile = resolve(
	dirname(entryPath),
	`.ts-run-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
);

try {
	await build({
		entryPoints: [entryPath],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		packages: 'external',
		sourcemap: 'inline',
		logLevel: 'silent',
	});

	const builtSource = readFileSync(outfile, 'utf8');
	writeFileSync(
		outfile,
		builtSource.replace(/(['"`])(\.[^'"`\n]+)\.ts\1/g, '$1$2.js$1'),
		'utf8',
	);

	process.argv = [process.argv[0] ?? 'node', entryPath, ...scriptArgs];
	await import(pathToFileURL(outfile).href);
} finally {
	rmSync(outfile, { force: true });
}
