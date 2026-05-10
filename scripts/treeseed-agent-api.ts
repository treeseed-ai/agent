#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const apiServerPath = fileURLToPath(new URL('../api/server.js', import.meta.url));
const command = process.argv[2] ?? 'start';
const forwardedArgs = command === 'start' || command === 'dev' ? process.argv.slice(3) : process.argv.slice(2);

if (command === '--help' || command === '-h' || command === 'help') {
	process.stdout.write([
		'treeseed-agent-api <command>',
		'',
		'Commands:',
		'  start    Start the Treeseed agent API server',
		'  dev      Start the Treeseed agent API server for local development',
		'',
	].join('\n'));
	process.exit(0);
}

const child = spawn(process.execPath, [apiServerPath, ...forwardedArgs], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: process.env,
});

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
