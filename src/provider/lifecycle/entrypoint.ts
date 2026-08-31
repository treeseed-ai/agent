#!/usr/bin/env node

import { providerRuntimeVersion, resolveProviderConfig, type ProviderRole } from '../configuration/config.ts';
import { writeProviderRuntimeStatus } from '../runtime/runtime-status.ts';

const ROLES = ['manager', 'runner', 'enroll', 'doctor', 'healthcheck', 'plan', 'version'] as const satisfies ProviderRole[];

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

async function stdinJson() {
	let value = '';
	for await (const chunk of process.stdin) {
		value += String(chunk);
		if (value.length > 64 * 1024) throw new Error('Provider enrollment input is too large.');
	}
	const parsed = JSON.parse(value);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Provider enrollment input must be a JSON object.');
	return parsed as Record<string, unknown>;
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
		const health = await checkProviderHealth(config);
		emit(health);
		if (role === 'healthcheck' && health.status !== 'ok') process.exitCode = 1;
		return;
	}
	if (role === 'plan') {
		const { buildProviderPlan } = await import('./lifecycle.ts');
		emit(await buildProviderPlan(config));
		return;
	}
	if (role === 'enroll') {
		if (!config.manifestPath) throw new Error('A capacity provider manifest is required for enrollment.');
		const input = await stdinJson();
		const { createCapacityProviderCoordinator } = await import('../teams/multi-team-runtime.ts');
		const coordinator = await createCapacityProviderCoordinator(config);
		const connectionId = String(input.connectionId ?? `local-${String(input.teamId ?? '')}`);
		const loaded = await import('../configuration/manifest.ts').then(({ loadProviderManifest }) => loadProviderManifest(config.manifestPath!, config.dataDir));
		const privateIdentity = await import('../accounts/identity.ts').then(({ ensureCapacityProviderIdentity }) => ensureCapacityProviderIdentity({
			ref: loaded.manifest.identity.privateKeyRef,
			baseDirectory: loaded.directory,
			dataDirectory: config.dataDir,
		}));
		const publicJwk = privateIdentity.publicJwk;
		const signingKeyId = `provider-${await import('node:crypto').then(({ createHash }) => createHash('sha256').update(publicJwk.x).digest('hex').slice(0, 16))}`;
		if (input.action === 'identities') {
			emit({ ok: true, identities: loaded.manifest.connections.map((connection) => ({
				connectionId: connection.id,
				teamId: connection.teamId,
				providerId: connection.providerId,
				sandboxIdentity: { signingKeyId, publicJwk },
			})) });
			return;
		}
		if (input.action === 'identity') {
			const connection = loaded.manifest.connections.find((candidate) => candidate.id === connectionId);
			if (!connection) throw new Error(`Provider connection ${connectionId} is not configured.`);
			emit({ ok: true, connectionId, status: 'configured', teamId: connection.teamId, providerId: connection.providerId,
				sandboxIdentity: { signingKeyId, publicJwk } });
			return;
		}
		if (input.action === 'complete') {
			const receipt = await coordinator.exchangeRegistrationCredential(connectionId);
			emit({ ok: true, connectionId, status: receipt.status, teamId: receipt.teamId, providerId: receipt.providerId, membershipId: receipt.membershipId });
			return;
		}
		const enrollmentToken = String(input.enrollmentToken ?? '');
		const teamId = String(input.teamId ?? '');
		if (!enrollmentToken || !teamId) throw new Error('Provider enrollment requires a team and one-time token.');
		const receipt = await coordinator.beginJoin({ id: connectionId,
			...(input.serverProfile ? { serverProfile: String(input.serverProfile) } : { controlPlaneUrl: String(input.controlPlaneUrl ?? '') }),
			controlPlaneAudience: String(input.controlPlaneAudience ?? input.controlPlaneUrl ?? ''), registrationKeyRef: 'memory://one-time',
			offer: { maxConcurrentRunners: loaded.manifest.capacity.maxConcurrentWorkers,
				capabilities: [...new Set(loaded.manifest.adapters.flatMap((adapter) => adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))))],
				metadata: { manifestGeneration: loaded.manifest.configuration.generation } } }, enrollmentToken);
		emit({ ok: true, connectionId, status: receipt.status, teamId: receipt.teamId, providerId: receipt.providerId, requestId: receipt.requestId, sandboxIdentity: { signingKeyId, publicJwk } });
		return;
	}
	if (role === 'manager') {
		if (!config.manifestPath) throw new Error('A capacity provider manifest is required to run the provider manager.');
		const { recoverMultiTeamProviderRunners, runMultiTeamProviderManager } = await import('../teams/multi-team-runtime.ts');
		if (mode === 'live' && !diagnostic) {
			try {
				emit(okPayload('manager', { action: 'restart-recovery', results: await recoverMultiTeamProviderRunners(config) }));
			} catch (error) {
				emit({
					ok: false,
					role: 'manager',
					action: 'restart-recovery',
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (once || mode === 'plan' || diagnostic) emit(await runMultiTeamProviderManager(config, { mode: mode === 'plan' || diagnostic ? 'plan' : 'live' }));
		else await runLoop('manager', config.dataDir, pollSeconds('TREESEED_PROVIDER_MANAGER_POLL_SECONDS', 15), () => runMultiTeamProviderManager(config));
		return;
	}
	if (role === 'runner') {
		if (!config.manifestPath) throw new Error('A capacity provider manifest is required to run provider runners.');
		const { runMultiTeamProviderRunners } = await import('../teams/multi-team-runtime.ts');
		if (once || mode === 'plan' || diagnostic) emit(await runMultiTeamProviderRunners(config, { mode: mode === 'plan' || diagnostic ? 'plan' : 'live' }));
		else await runLoop('runner', config.dataDir, pollSeconds('TREESEED_PROVIDER_RUNNER_POLL_SECONDS', 2), () => runMultiTeamProviderRunners(config, { background: true }));
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
