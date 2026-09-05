import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	validateCapacityProviderManifestV5,
	type CapacityProviderJoinInput,
	type CapacityProviderManifestV5,
	type ProviderConnectionConfig,
} from '@treeseed/sdk/capacity-provider';
import { readProviderSecret, deleteProviderSecret, stageOsProviderSecret } from '../security/os-custody.ts';
import { migrateManagedProviderManifestV4 } from './legacy-manifest.ts';

export const DEFAULT_PROVIDER_MANIFEST = 'treeseed.capacity-provider.yaml';

export interface LoadedProviderManifest {
	path: string;
	directory: string;
	dataDirectory?: string;
	manifest: CapacityProviderManifestV5;
}

function diagnosticMessage(diagnostics: Array<{ path: string; message: string }>) {
	return diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
}

const connectionOverlayPath = (dataDirectory: string) => resolve(dataDirectory, 'connections.yaml');

async function localConnections(dataDirectory: string | undefined) {
	if (!dataDirectory) return null;
	try {
		const value = parseYaml(await readFile(connectionOverlayPath(dataDirectory), 'utf8'));
		if (!Array.isArray(value)) throw new Error('Provider connection overlay must contain an array.');
		return value as ProviderConnectionConfig[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export async function loadProviderManifest(path = process.env.TREESEED_CAPACITY_PROVIDER_MANIFEST || DEFAULT_PROVIDER_MANIFEST, dataDirectory?: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedProviderManifest> {
	const absolute = resolve(path);
	const source = parseYaml(await readFile(absolute, 'utf8')) as CapacityProviderManifestV5 | { schemaVersion?: unknown };
	const parsed = source.schemaVersion === 4 ? migrateManagedProviderManifestV4(source, env) : source as CapacityProviderManifestV5;
	const overlay = await localConnections(dataDirectory);
	const manifest = overlay ? { ...parsed, connections: overlay } : parsed;
	if (manifest.schemaVersion !== 5) throw new Error('Capacity providers require a v5 capability-offer manifest.');
	const validation = validateCapacityProviderManifestV5(manifest);
	if (!validation.ok) throw new Error(`Invalid capacity provider manifest: ${diagnosticMessage(validation.diagnostics)}`);
	return { path: absolute, directory: dirname(absolute), ...(dataDirectory ? { dataDirectory } : {}), manifest };
}

export async function writeProviderConnections(loaded: LoadedProviderManifest, connections: ProviderConnectionConfig[]) {
	if (!loaded.dataDirectory) throw new Error('Provider connection updates require a local data directory.');
	const manifest = { ...loaded.manifest, connections };
	const validation = validateCapacityProviderManifestV5(manifest);
	if (!validation.ok) throw new Error(`Invalid capacity provider manifest: ${diagnosticMessage(validation.diagnostics)}`);
	const path = connectionOverlayPath(loaded.dataDirectory);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, stringifyYaml(connections), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	await chmod(path, 0o600);
	loaded.manifest = manifest;
	return loaded;
}

export async function resolveProviderSecret(ref: string, input: {
 env?: NodeJS.ProcessEnv; baseDirectory: string; dataDirectory?: string;
}): Promise<string> {
 return readProviderSecret(ref,input.dataDirectory);
}
export async function writeProviderSecret(ref:string,value:string,baseDirectory:string,dataDirectory?:string) {
 const staged=await stageProviderSecret(ref,value,baseDirectory,dataDirectory);await staged.commit();return staged.path;
}
export async function removeProviderSecret(ref:string,_baseDirectory:string,dataDirectory?:string) {
 return deleteProviderSecret(ref,dataDirectory);
}
export async function stageProviderSecret(ref:string,value:string,_baseDirectory:string,dataDirectory?:string) {
 return stageOsProviderSecret(ref,value,dataDirectory);
}

export function providerServerProfileEnvironmentName(profile: string) {
	return `TREESEED_SERVER_PROFILE_${profile.replace(/[^a-z0-9]/giu, '_').toUpperCase()}_URL`;
}

export function providerServerProfileAudienceEnvironmentName(profile: string) {
	return `TREESEED_SERVER_PROFILE_${profile.replace(/[^a-z0-9]/giu, '_').toUpperCase()}_AUDIENCE`;
}

type ProviderControlPlaneTarget = Pick<ProviderConnectionConfig, 'id' | 'controlPlaneUrl' | 'serverProfile' | 'controlPlaneAudience'> | Pick<CapacityProviderJoinInput, 'id' | 'controlPlaneUrl' | 'serverProfile' | 'controlPlaneAudience'>;

export function providerConnectionControlPlaneUrl(connection: ProviderControlPlaneTarget, env: NodeJS.ProcessEnv = process.env) {
	if (connection.controlPlaneUrl?.trim()) return connection.controlPlaneUrl.replace(/\/$/u, '');
	const profile = connection.serverProfile?.trim();
	if (!profile) throw new Error(`Provider connection ${connection.id} does not declare controlPlaneUrl or serverProfile.`);
	const name = providerServerProfileEnvironmentName(profile);
	const url = env[name]?.trim();
	if (!url) throw new Error(`Provider server profile ${profile} requires ${name}.`);
	return url.replace(/\/$/u, '');
}

export function providerConnectionControlPlaneAudience(connection: ProviderControlPlaneTarget, env: NodeJS.ProcessEnv = process.env) {
	if (connection.controlPlaneAudience?.trim()) return connection.controlPlaneAudience.replace(/\/$/u, '');
	const profile = connection.serverProfile?.trim();
	if (profile) {
		const configured = env[providerServerProfileAudienceEnvironmentName(profile)]?.trim();
		if (configured) return configured.replace(/\/$/u, '');
	}
	return providerConnectionControlPlaneUrl(connection, env);
}
