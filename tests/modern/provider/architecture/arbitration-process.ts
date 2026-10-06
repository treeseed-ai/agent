import { readFile } from 'node:fs/promises';
import { loadProviderManifest, writeProviderSecret } from '../../../../dist/provider/configuration/manifest.js';
import { initializeCapacityProviderIdentity, loadCapacityProviderIdentity } from '../../../../dist/provider/accounts/identity.js';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';

// Child entrypoint for the EXISTING runtime, not another arbitration runner.
// The parent supplies only a disposable directory and controlled loopback API.
const [action, directory, sessionInitialization] = process.argv.slice(2);
if (!directory || !['initialize', 'run', 'offers', 'offers-session', 'run-session'].includes(action ?? '')) throw new Error('Exact isolated arbitration action required');
if (sessionInitialization !== undefined && (!['offers-session', 'run-session', 'run'].includes(action!) || sessionInitialization !== 'initialize')) throw new Error('Exact native session initialization required');
const config: ProviderHostRuntimeConfig = JSON.parse(await readFile(`${directory}/config.json`, 'utf8'));
if (config.dataDir !== directory || config.manifestPath !== `${directory}/manifest.yaml`) throw new Error('Fixture custody mismatch');
async function load() {
	const loaded = await loadProviderManifest(config.manifestPath ?? undefined, directory);
	for (const connection of loaded.manifest.connections) {
		const url = new URL(connection.controlPlaneUrl ?? '');
		if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Only the disposable loopback endpoint is allowed');
	}
	return loaded;
}
async function offers() {
	const loaded = await load();
	const { materializeCapabilityOffers } = await import('../../../../dist/provider/capabilities/materialize-offers.js');
	const identity = await loadCapacityProviderIdentity({ ref: loaded.manifest.identity.privateKeyRef, baseDirectory: directory, dataDirectory: directory });
	return { publicJwk: identity.publicJwk,
		adapters: await materializeCapabilityOffers({ config, loaded, providerId: loaded.manifest.connections[0]!.providerId }) };
}
async function initialize() {
	const loaded = await load();
	await initializeCapacityProviderIdentity({ ref: loaded.manifest.identity.privateKeyRef, baseDirectory: directory, dataDirectory: directory });
	for (const connection of loaded.manifest.connections) await writeProviderSecret(connection.membershipCredentialRef,
		`isolated-${connection.id}`, directory, directory);
}
async function run() {
	await load();
	const { runMultiTeamProviderRunners } = await import('../../../../dist/provider/teams/multi-team-runtime.js');
	return runMultiTeamProviderRunners(config);
}
if (action === 'initialize') {
	await initialize();
	process.stdout.write(JSON.stringify({ initialized: true }));
} else if (action === 'offers') {
	process.stdout.write(JSON.stringify(await offers()));
} else if (action === 'offers-session' || action === 'run-session') {
	if (!process.send) throw new Error('Owned native offer IPC required');
	if (sessionInitialization === 'initialize') await initialize();
	// Same owning loader and publisher on EVERY call, including after denial.
	// Only process/module startup is shared; manifest and identity are reread.
	process.on('message', async message => {
		const expected = action === 'offers-session' ? 'offers' : 'run';
		if (action === 'run-session' && message && typeof message === 'object' && 'loadManifestPaths' in message) {
			const paths = message.loadManifestPaths;
			if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length ||
				paths.some(path => typeof path !== 'string' || !path.startsWith(`${directory}/quota-input-`) ||
					!/^\d+\.yaml$/u.test(path.slice(`${directory}/quota-input-`.length)))) throw new Error('Only allocated native quota inputs allowed');
			const results = await Promise.all(paths.map(async path => {
				try { await loadProviderManifest(path, directory, {}); return { path, status: 'fulfilled' }; }
				catch (error) {
					if (!(error instanceof Error)) throw error;
					return { path, status: 'rejected', error: { name: error.name, message: error.message, stack: error.stack } };
				}
			}));
			process.send!({ value: results }); return;
		}
		if (message !== expected) throw new Error('Exact native session action required');
		try { process.send!({ value: await (message === 'offers' ? offers() : run()) }); }
		catch (cause) {
			if (!(cause instanceof Error)) throw cause;
			process.send!({ error: { name: cause.name, message: cause.message, stack: cause.stack } });
		}
	});
	process.on('disconnect', () => process.exit(0));
	process.send({ ready: true });
} else {
	if (sessionInitialization === 'initialize') await initialize();
	process.stdout.write(JSON.stringify(await run()));
}
