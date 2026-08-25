import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProviderSupplyOffer } from '@treeseed/sdk/capacity-provider/contracts';

export interface ProviderConnectionState {
	schemaVersion: 1;
	connectionId: string;
	controlPlaneUrl: string;
	serverProfile?: string | null;
	controlPlaneAudience?: string | null;
	offer: ProviderSupplyOffer;
	teamId?: string | null;
	providerId?: string | null;
	registrationRequestId?: string | null;
	registrationStatus?: string | null;
	membershipId?: string | null;
	credentialId?: string | null;
	credentialRotationIdempotencyKey?: string | null;
	credentialExchangeIdempotencyKey?: string | null;
	generatedCredentialRef?: string | null;
	updatedAt: string;
}

function statePath(dataDir: string, connectionId: string) {
	const safe = connectionId.replace(/[^a-z0-9_.-]/giu, '-');
	return resolve(dataDir, 'connections', `${safe}.json`);
}

export async function readProviderConnectionState(dataDir: string, connectionId: string): Promise<ProviderConnectionState | null> {
	try {
		return JSON.parse(await readFile(statePath(dataDir, connectionId), 'utf8')) as ProviderConnectionState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export async function writeProviderConnectionState(dataDir: string, state: ProviderConnectionState) {
	const path = statePath(dataDir, state.connectionId);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	await rename(temporary, path);
	return state;
}

export async function listProviderConnectionStates(dataDir: string) {
	const directory = resolve(dataDir, 'connections');
	let names: string[];
	try { names = await readdir(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const states = await Promise.all(names.filter((name) => /^[a-z0-9_.-]+\.json$/iu.test(name)).sort().map(async (name) => JSON.parse(await readFile(resolve(directory, name), 'utf8')) as ProviderConnectionState));
	return states.filter((state) => state.schemaVersion === 1 && typeof state.connectionId === 'string' && typeof state.registrationRequestId === 'string');
}

export async function removeProviderConnectionState(dataDir: string, connectionId: string) {
	await unlink(statePath(dataDir, connectionId)).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
	});
}

export function generatedMembershipCredentialRef(connectionId: string) {
	const safe = connectionId.replace(/[^a-z0-9_.-]/giu, '-');
	return `data://secrets/${safe}.credential`;
}
