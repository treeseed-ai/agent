import { readFile } from 'node:fs/promises';
import { loadProviderManifest, writeProviderSecret } from '../../../../dist/provider/configuration/manifest.js';
import { initializeCapacityProviderIdentity, loadCapacityProviderIdentity } from '../../../../dist/provider/accounts/identity.js';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';

// Child entrypoint for the EXISTING runtime, not another arbitration runner.
// The parent supplies only a disposable directory and controlled loopback API.
const [action, directory] = process.argv.slice(2);
if (!directory || !['initialize', 'run', 'offers'].includes(action ?? '')) throw new Error('Exact isolated arbitration action required');
const config: ProviderHostRuntimeConfig = JSON.parse(await readFile(`${directory}/config.json`, 'utf8'));
if (config.dataDir !== directory || config.manifestPath !== `${directory}/manifest.yaml`) throw new Error('Fixture custody mismatch');
const loaded = await loadProviderManifest(config.manifestPath, directory);
for (const connection of loaded.manifest.connections) {
	const url = new URL(connection.controlPlaneUrl ?? '');
	if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Only the disposable loopback endpoint is allowed');
}
if (action === 'initialize') {
	await initializeCapacityProviderIdentity({ ref: loaded.manifest.identity.privateKeyRef, baseDirectory: directory, dataDirectory: directory });
	for (const connection of loaded.manifest.connections) await writeProviderSecret(connection.membershipCredentialRef,
		`isolated-${connection.id}`, directory, directory);
	process.stdout.write(JSON.stringify({ initialized: true }));
} else if (action === 'offers') {
	const { materializeCapabilityOffers } = await import('../../../../dist/provider/capabilities/materialize-offers.js');
	const identity = await loadCapacityProviderIdentity({ ref: loaded.manifest.identity.privateKeyRef, baseDirectory: directory, dataDirectory: directory });
	process.stdout.write(JSON.stringify({ publicJwk: identity.publicJwk,
		adapters: await materializeCapabilityOffers({ config, loaded, providerId: loaded.manifest.connections[0]!.providerId }) }));
} else {
	const { runMultiTeamProviderRunners } = await import('../../../../dist/provider/teams/multi-team-runtime.js');
	process.stdout.write(JSON.stringify(await runMultiTeamProviderRunners(config)));
}
