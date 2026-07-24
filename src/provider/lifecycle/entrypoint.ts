#!/usr/bin/env node

import { providerRuntimeVersion, resolveProviderConfig, type ProviderRole } from '../configuration/config.ts';
import { writeProviderRuntimeStatus } from '../runtime/runtime-status.ts';

const ROLES = ['manager', 'runner', 'doctor', 'healthcheck', 'plan', 'version'] as const satisfies ProviderRole[];

function args() {
	return process.argv.slice(2);
}

function roleArg(): ProviderRole {
	const role = args()[0] ?? process.env.TREESEED_PROVIDER_ROLE ?? 'api';
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
		'  node ./dist/provider/lifecycle/entrypoint.js version',
		'  node ./dist/provider/lifecycle/entrypoint.js healthcheck',
		'  node ./dist/provider/lifecycle/entrypoint.js manager --plan --json',
		'  node ./dist/provider/lifecycle/entrypoint.js runner --plan --json',
		'  node ./dist/provider/lifecycle/entrypoint.js runner --once --json',
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

async function runLoop(role: 'manager' | 'runner', dataDirectory: string, intervalSeconds: number, runOnce: () => Promise<unknown>) {
	emit(okPayload(role, {
		status: 'running',
		intervalSeconds,
	}));
	for (;;) {
		try {
			const result = await runOnce();
			await writeProviderRuntimeStatus(dataDirectory, { role, ok: true, result });
			emit(result);
		} catch (error) {
			const failure = {
				ok: false,
				role,
				error: error instanceof Error ? error.message : String(error),
			};
			await writeProviderRuntimeStatus(dataDirectory, failure);
			emit(failure);
		}
		await sleep(intervalSeconds * 1000);
	}
}

function requireConnection(role: ProviderRole, mode: 'plan' | 'live') {
	return mode === 'live' && ['manager', 'runner'].includes(role);
}

async function main() {
	if (flagEnabled('--help') || flagEnabled('-h') || args()[0] === 'help') {
		printHelp();
		return;
	}
	const role = roleArg();
	const mode = flagEnabled('--plan') ? 'plan' : 'live';
	const once = flagEnabled('--once');
	const diagnostic = diagnosticMode();
	const config = resolveProviderConfig({ requireConnection: requireConnection(role, mode) && !diagnostic });
	if (['manager', 'runner'].includes(role) && mode === 'live' && !diagnostic && !config.manifestPath) {
		throw new Error('treeseed.capacity-provider.yaml (or TREESEED_CAPACITY_PROVIDER_MANIFEST) is required; legacy single-team provider credentials are no longer supported.');
	}
	if (requireConnection(role, mode) && !diagnostic) {
		const { materializeCodexAuthFromEnv } = await import('../../agents/adapters/accounts/codex-auth.ts');
		await materializeCodexAuthFromEnv(process.env);
	}
	if (role === 'version') {
		emit(okPayload('version', {
			package: '@treeseed/agent',
			version: providerRuntimeVersion(),
			entrypoint: 'packages/agent/dist/provider/lifecycle/entrypoint.js',
			roles: ROLES,
		}));
		return;
	}
	if (role === 'healthcheck' || role === 'doctor') {
		const { checkProviderHealth } = await import('./lifecycle.ts');
		emit(await checkProviderHealth(config));
		return;
	}
	if (role === 'plan') {
		const { buildProviderPlan } = await import('./lifecycle.ts');
		emit(await buildProviderPlan(config));
		return;
	}
	if (role === 'manager') {
		if (!config.manifestPath) throw new Error('A capacity provider manifest is required to run the provider manager.');
		const { recoverMultiTeamProviderRunners, runMultiTeamProviderManager } = await import('../teams/multi-team-runtime.ts');
		if (mode === 'live' && !diagnostic) emit(okPayload('manager', { action: 'restart-recovery', results: await recoverMultiTeamProviderRunners(config) }));
		if (once || mode === 'plan' || diagnostic) emit(await runMultiTeamProviderManager(config, { mode: mode === 'plan' || diagnostic ? 'plan' : 'live' }));
		else await runLoop('manager', config.dataDir, pollSeconds('TREESEED_PROVIDER_MANAGER_POLL_SECONDS', 15), () => runMultiTeamProviderManager(config));
		return;
	}
	if (role === 'runner') {
		if (!config.manifestPath) throw new Error('A capacity provider manifest is required to run provider runners.');
		const { runMultiTeamProviderRunners } = await import('../teams/multi-team-runtime.ts');
		if (once || mode === 'plan' || diagnostic) emit(await runMultiTeamProviderRunners(config, { mode: mode === 'plan' || diagnostic ? 'plan' : 'live' }));
		else await runLoop('runner', config.dataDir, pollSeconds('TREESEED_PROVIDER_RUNNER_POLL_SECONDS', 15), () => runMultiTeamProviderRunners(config, { background: true }));
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
