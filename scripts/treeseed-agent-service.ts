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
		'register-provider',
		'',
	].join('\n'));
	process.exit(0);
}

if (command === 'register-provider') {
	const marketUrl = String(argValue('--market-url') ?? process.env.TREESEED_MARKET_API_BASE_URL ?? '').replace(/\/+$/u, '');
	const providerApiKey = argValue('--provider-api-key') ?? argValue('--registration-token') ?? process.env.TREESEED_PROVIDER_API_KEY ?? '';
	if (!marketUrl || !providerApiKey) {
		process.stderr.write('Usage: treeseed-agent-service register-provider --market-url <url> --provider-api-key <security-code>\n');
		process.exit(1);
	}
	const response = await fetch(`${marketUrl}/v1/processing/register`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${providerApiKey}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			status: 'active',
			queueDepth: Number(argValue('--queue-depth') ?? 0),
			activeWorkers: Number(argValue('--active-workers') ?? 0),
			maxWorkers: Number(argValue('--max-workers') ?? 1),
			draining: false,
			capabilities: ['agent_execution', 'repository_work', 'reporting'],
			environments: [argValue('--environment') ?? process.env.TREESEED_ENVIRONMENT ?? 'staging'],
		}),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || payload?.ok === false) {
		process.stderr.write(`${payload?.error ?? `Provider registration failed with ${response.status}`}\n`);
		process.exit(1);
	}
	process.stdout.write(`${JSON.stringify(payload.payload, null, 2)}\n`);
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
