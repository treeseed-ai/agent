#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const services = new Map([
	['manager', '../services/manager.js'],
	['worker', '../services/worker.js'],
	['workday-manager', '../services/workday-manager.js'],
	['workday-start', '../services/workday-start.js'],
	['workday-report', '../services/workday-report.js'],
	['remote-runner', '../services/remote-runner.js'],
	['agents', '../services/agents.js'],
]);

const command = process.argv[2] ?? 'help';

if (command === '--help' || command === '-h' || command === 'help') {
	process.stdout.write([
		'treeseed-agent-service <service>',
		'',
		'Services:',
		...services.keys(),
		'',
	].join('\n'));
	process.exit(0);
}

const servicePath = services.get(command);
if (!servicePath) {
	process.stderr.write(`Unknown Treeseed agent service "${command}".\n`);
	process.exit(1);
}

const child = spawn(process.execPath, [fileURLToPath(new URL(servicePath, import.meta.url)), ...process.argv.slice(3)], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: process.env,
});

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
