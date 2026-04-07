#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliScriptPath = fileURLToPath(new URL('../agents/cli.js', import.meta.url));

const child = spawn(process.execPath, [cliScriptPath, ...process.argv.slice(2)], {
	cwd: packageRoot,
	stdio: 'inherit',
	env: process.env,
});

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
