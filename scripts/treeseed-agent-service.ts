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
const forwardedArgs = process.argv.slice(3);

function argValue(name: string) {
	const index = forwardedArgs.indexOf(name);
	if (index >= 0) return forwardedArgs[index + 1] ?? null;
	const prefixed = forwardedArgs.find((arg) => arg.startsWith(`${name}=`));
	return prefixed ? prefixed.slice(name.length + 1) : null;
}

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

const childEnv = {
	...process.env,
	TREESEED_PROVIDER_ID: argValue('--provider-id') ?? process.env.TREESEED_PROVIDER_ID,
	TREESEED_PROVIDER_API_KEY: argValue('--provider-api-key') ?? process.env.TREESEED_PROVIDER_API_KEY,
	TREESEED_ENVIRONMENT: argValue('--environment') ?? process.env.TREESEED_ENVIRONMENT,
	TREESEED_MAX_LOCAL_WORKERS: argValue('--max-workers') ?? process.env.TREESEED_MAX_LOCAL_WORKERS,
};

const child = spawn(process.execPath, [fileURLToPath(new URL(servicePath, import.meta.url)), ...forwardedArgs], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: childEnv,
});

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
