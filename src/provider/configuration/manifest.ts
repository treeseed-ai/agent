import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	validateCapacityProviderManifestV3,
	type CapacityProviderJoinInput,
	type CapacityProviderManifestV3,
	type ProviderConnectionConfig,
} from '@treeseed/sdk/capacity-provider';

export const DEFAULT_PROVIDER_MANIFEST = 'treeseed.capacity-provider.yaml';

export interface LoadedProviderManifest {
	path: string;
	directory: string;
	manifest: CapacityProviderManifestV3;
}

export interface ProviderSecretResolver {
	(ref: string): Promise<string | null>;
}

function diagnosticMessage(diagnostics: Array<{ path: string; message: string }>) {
	return diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
}

export async function loadProviderManifest(path = process.env.TREESEED_CAPACITY_PROVIDER_MANIFEST || DEFAULT_PROVIDER_MANIFEST): Promise<LoadedProviderManifest> {
	const absolute = resolve(path);
	const parsed = parseYaml(await readFile(absolute, 'utf8')) as CapacityProviderManifestV3;
	const validation = validateCapacityProviderManifestV3(parsed);
	if (!validation.ok) throw new Error(`Invalid capacity provider manifest: ${diagnosticMessage(validation.diagnostics)}`);
	return { path: absolute, directory: dirname(absolute), manifest: parsed };
}

export async function writeProviderManifest(loaded: LoadedProviderManifest, manifest: CapacityProviderManifestV3) {
	const validation = validateCapacityProviderManifestV3(manifest);
	if (!validation.ok) throw new Error(`Invalid capacity provider manifest: ${diagnosticMessage(validation.diagnostics)}`);
	const temporary = `${loaded.path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, stringifyYaml(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	await chmod(temporary, 0o600);
	await rename(temporary, loaded.path);
	await chmod(loaded.path, 0o600);
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
		const value = (await readFile(path, 'utf8')).trim();
		if (!value) throw new Error(`Provider secret file ${path} is empty.`);
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
	await writeFile(temporary, `${value.trim()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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
