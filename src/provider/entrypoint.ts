#!/usr/bin/env node

import { createCapacityProviderNodeServer } from '../api/provider-app.ts';
import { providerRuntimeVersion, resolveProviderConfig, type ProviderRole } from './config.ts';
import { buildProviderRegistrationRequest, registerProvider } from './registration.ts';
import { startProviderHeartbeatLoop } from './heartbeat.ts';

const ROLES = ['api', 'manager', 'runner', 'doctor', 'healthcheck', 'register', 'plan', 'version'] as const satisfies ProviderRole[];

function args() {
	return process.argv.slice(2);
}

function roleArg(): ProviderRole {
	const role = args()[0] ?? 'api';
	if (!ROLES.includes(role as ProviderRole)) {
		throw new Error(`Unknown capacity provider role "${role}".`);
	}
	return role as ProviderRole;
}

function flagEnabled(name: string) {
	return args().includes(name);
}

function wantsJson() {
	return flagEnabled('--json') || process.env.TREESEED_PROVIDER_JSON === '1';
}

function diagnosticMode() {
	return flagEnabled('--diagnostic') || process.env.TREESEED_PROVIDER_STARTUP_MODE === 'diagnostic';
}

function printHelp() {
	process.stdout.write([
		'capacity-provider <role>',
		'',
		'Roles:',
		...ROLES.map((role) => `  ${role}`),
		'',
		'Examples:',
		'  node ./dist/provider/entrypoint.js version',
		'  node ./dist/provider/entrypoint.js healthcheck',
		'  node ./dist/provider/entrypoint.js register --dry-run',
		'  node ./dist/provider/entrypoint.js manager --dry-run --json',
		'  node ./dist/provider/entrypoint.js runner --dry-run --json',
		'  node ./dist/provider/entrypoint.js runner --once --json',
		'',
	].join('\n'));
}

function emit(payload: unknown) {
	if (wantsJson() || typeof payload !== 'string') {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${payload}\n`);
}

function okPayload(role: string, payload: Record<string, unknown> = {}) {
	return {
		ok: true,
		role,
		...payload,
	};
}

function pollSeconds(name: string, fallback: number) {
	const raw = process.env[name]?.trim() ?? '';
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function runLoop(role: 'manager' | 'runner', intervalSeconds: number, runOnce: () => Promise<unknown>) {
	emit(okPayload(role, {
		status: 'running',
		intervalSeconds,
	}));
	for (;;) {
		try {
			emit(await runOnce());
		} catch (error) {
			emit({
				ok: false,
				role,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await sleep(intervalSeconds * 1000);
	}
}

function requireConnection(role: ProviderRole, dryRun: boolean) {
	return !dryRun && ['api', 'manager', 'runner', 'register'].includes(role);
}

async function main() {
	if (flagEnabled('--help') || flagEnabled('-h') || args()[0] === 'help') {
		printHelp();
		return;
	}
	const role = roleArg();
	const dryRun = flagEnabled('--dry-run');
	const once = flagEnabled('--once');
	const diagnostic = diagnosticMode();
	const config = resolveProviderConfig({ requireConnection: requireConnection(role, dryRun) && !diagnostic });
	if (role !== 'api' && requireConnection(role, dryRun) && !diagnostic) {
		const { materializeCodexAuthFromEnv } = await import('../agents/adapters/codex-auth.ts');
		await materializeCodexAuthFromEnv(process.env);
	}
	if (role === 'version') {
		emit(okPayload('version', {
			package: '@treeseed/agent',
			version: providerRuntimeVersion(),
			entrypoint: 'packages/agent/dist/provider/entrypoint.js',
			roles: ROLES,
		}));
		return;
	}
	if (role === 'healthcheck' || role === 'doctor') {
		const { checkProviderHealth } = await import('./lifecycle.ts');
		emit(await checkProviderHealth(config));
		return;
	}
	if (role === 'register') {
		if (dryRun) {
			emit(okPayload('register', {
				dryRun: true,
				request: buildProviderRegistrationRequest(config),
				redactedEnv: config.redactedEnv,
			}));
			return;
		}
		emit(await registerProvider(config));
		return;
	}
	if (role === 'plan') {
		const { buildProviderPlan } = await import('./lifecycle.ts');
		emit(await buildProviderPlan(config, { dryRun }));
		return;
	}
	if (role === 'manager') {
		const { runManagerSkeleton } = await import('./lifecycle.ts');
		if (dryRun || diagnostic) {
			emit(await runManagerSkeleton(config, { dryRun: true }));
			return;
		}
		if (once) {
			emit(await runManagerSkeleton(config));
			return;
		}
		await runLoop('manager', pollSeconds('TREESEED_PROVIDER_MANAGER_POLL_SECONDS', 60), () => runManagerSkeleton(config));
		return;
	}
	if (role === 'runner') {
		const { runRunnerSkeleton } = await import('./lifecycle.ts');
		if (dryRun || diagnostic) {
			emit(await runRunnerSkeleton(config, { dryRun: true }));
			return;
		}
		if (once) {
			emit(await runRunnerSkeleton(config));
			return;
		}
		await runLoop('runner', pollSeconds('TREESEED_PROVIDER_RUNNER_POLL_SECONDS', 15), () => runRunnerSkeleton(config));
		return;
	}
	if (role === 'api') {
		if (dryRun || diagnostic) {
			emit(okPayload('api', {
				dryRun: true,
				diagnostic,
				port: config.apiPort,
				endpoints: ['/healthz', '/readyz', '/provider/health', '/provider/register', '/provider/portfolio'],
				redactedEnv: config.redactedEnv,
			}));
			if (diagnostic && !dryRun) {
				const server = await createCapacityProviderNodeServer(config);
				process.stdout.write(`${JSON.stringify(okPayload('api', {
					url: server.url,
					diagnostic: true,
				}))}\n`);
			}
			return;
		}
		const server = await createCapacityProviderNodeServer(config);
		process.stdout.write(`${JSON.stringify(okPayload('api', {
			url: server.url,
			status: 'running',
		}))}\n`);
		void registerProvider(config)
			.then((registration) => {
				startProviderHeartbeatLoop(config, registration.heartbeatIntervalSeconds);
				process.stdout.write(`${JSON.stringify(okPayload('api', {
					event: 'capacity-provider.registered',
					provider: registration.provider,
					heartbeatIntervalSeconds: registration.heartbeatIntervalSeconds,
				}))}\n`);
			})
			.catch((error) => {
				process.stderr.write(`${JSON.stringify({
					ok: false,
					event: 'capacity-provider.registration_failed',
					error: error instanceof Error ? error.message : String(error),
				})}\n`);
			});
		return;
	}
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	}, null, 2)}\n`);
	process.exitCode = 1;
});
