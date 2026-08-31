import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	validateCapacityProviderManifestV5,
	type CapacityProviderJoinInput,
	type CapacityProviderManifestV5,
	type ProviderConnectionConfig,
} from '@treeseed/sdk/capacity-provider';
import { decryptProviderCredential, encryptProviderCredential, isProviderCredentialEnvelope } from '../security/credential-vault.ts';

export const DEFAULT_PROVIDER_MANIFEST = 'treeseed.capacity-provider.yaml';

export interface LoadedProviderManifest {
	path: string;
	directory: string;
	dataDirectory?: string;
	manifest: CapacityProviderManifestV5;
}

export interface ProviderSecretResolver {
	(ref: string): Promise<string | null>;
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

export async function loadProviderManifest(path = process.env.TREESEED_CAPACITY_PROVIDER_MANIFEST || DEFAULT_PROVIDER_MANIFEST, dataDirectory?: string): Promise<LoadedProviderManifest> {
	const absolute = resolve(path);
	const parsed = parseYaml(await readFile(absolute, 'utf8')) as CapacityProviderManifestV5;
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

function secretReferencePath(ref: string, baseDirectory: string, dataDirectory?: string) {
	const scheme = ref.startsWith('data://') ? 'data://' : ref.startsWith('file://') ? 'file://' : null;
	if (!scheme) throw new Error(`Provider file or data secret reference required, received ${ref}.`);
	const value = ref.slice(scheme.length);
	if (!value) throw new Error(`${scheme.slice(0, -3)} secret reference must include a path.`);
	if (scheme === 'data://') {
		if (!dataDirectory) throw new Error(`Provider data directory is required to resolve ${ref}.`);
		return resolve(dataDirectory, value.replace(/^\.\//u, ''));
	}
	return isAbsolute(value) ? value : resolve(baseDirectory, value.replace(/^\.\//u, ''));
}

export function providerSecretPath(ref: string, baseDirectory: string, dataDirectory?: string) {
	return secretReferencePath(ref, baseDirectory, dataDirectory);
}

export async function resolveProviderSecret(ref: string, input: {
	env?: NodeJS.ProcessEnv;
	baseDirectory: string;
	dataDirectory?: string;
	resolver?: ProviderSecretResolver;
}): Promise<string> {
	if (ref.startsWith('env://')) {
		const name = ref.slice('env://'.length);
		const value = (input.env ?? process.env)[name]?.trim();
		if (!name || !value) throw new Error(`Provider secret environment reference ${ref} is unavailable.`);
		return value;
	}
	if (ref.startsWith('file://') || ref.startsWith('data://')) {
		const path = secretReferencePath(ref, input.baseDirectory, input.dataDirectory);
		const serialized = (await readFile(path, 'utf8')).trim();
		const encrypted = ref.startsWith('data://') && isProviderCredentialEnvelope(serialized);
		const value = encrypted ? await decryptProviderCredential(ref, serialized) : serialized;
		if (!value) throw new Error(`Provider secret file ${path} is empty.`);
		if (ref.startsWith('data://') && !encrypted) {
			const temporary = `${path}.${process.pid}.${Date.now()}.migration`;
			await writeFile(temporary, await encryptProviderCredential(ref, value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await rename(temporary, path); await chmod(path, 0o600);
		}
		return value;
	}
	const resolved = await input.resolver?.(ref);
	if (resolved?.trim()) return resolved.trim();
	throw new Error(`Unsupported provider secret reference ${ref}. Configure an env://, file://, or data:// reference, or install a secret resolver.`);
}

export async function writeProviderSecret(ref: string, value: string, baseDirectory: string, dataDirectory?: string) {
	const staged = await stageProviderSecret(ref, value, baseDirectory, dataDirectory);
	await staged.commit();
	return staged.path;
}

export async function removeProviderSecret(ref: string, baseDirectory: string, dataDirectory?: string) {
	if (!ref.startsWith('file://') && !ref.startsWith('data://')) return false;
	const path = secretReferencePath(ref, baseDirectory, dataDirectory);
	return unlink(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return false;
		throw error;
	});
}

export async function stageProviderSecret(ref: string, value: string, baseDirectory: string, dataDirectory?: string) {
	const path = secretReferencePath(ref, baseDirectory, dataDirectory);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.pending`;
	const serialized = ref.startsWith('data://') ? await encryptProviderCredential(ref, value.trim()) : `${value.trim()}\n`;
	await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	await chmod(temporary, 0o600);
	return {
		path,
		temporaryPath: temporary,
		async commit() {
			await rename(temporary, path);
			await chmod(path, 0o600);
		},
		async rollback() {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') throw error;
			});
		},
	};
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
