import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { CapacityProviderProofPayload, CapacityProviderPublicJwk, CapacityProviderSignedProof } from '@treeseed/sdk/capacity-provider/contracts';
import { resolveProviderSecret, writeProviderSecret, type ProviderSecretResolver } from '../configuration/manifest.ts';

export interface CapacityProviderPrivateJwk extends CapacityProviderPublicJwk { d: string }

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => [key, canonical(entry)]));
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));

export function generateCapacityProviderIdentity(): CapacityProviderPrivateJwk {
	return generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as CapacityProviderPrivateJwk;
}

export function capacityProviderPublicIdentity(privateJwk: CapacityProviderPrivateJwk): CapacityProviderPublicJwk {
	if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.x || !privateJwk.d) throw new Error('Capacity provider identity must be an Ed25519 private JWK.');
	return { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, alg: 'EdDSA' };
}

export async function signCapacityProviderProof(input: { privateJwk: CapacityProviderPrivateJwk; publicJwk: CapacityProviderPublicJwk;
	method: string; path: string; audience: string; body: unknown; jti?: string; identityVersion?: number; now?: Date }): Promise<CapacityProviderSignedProof> {
	const now = input.now ?? new Date();
	const fingerprint = `sha256:${sha256(canonicalJson({ crv: input.publicJwk.crv, kty: input.publicJwk.kty, x: input.publicJwk.x }))}`;
	const payload: CapacityProviderProofPayload = { schemaVersion: 1, algorithm: 'Ed25519', providerFingerprint: fingerprint,
		identityVersion: input.identityVersion ?? 1, method: input.method.toUpperCase(), path: input.path,
		bodySha256: sha256(canonicalJson(input.body)), audience: input.audience.replace(/\/$/u, ''),
		issuedAt: new Date(now.getTime() - 1_000).toISOString(), expiresAt: new Date(now.getTime() + 59_000).toISOString(),
		jti: input.jti ?? randomUUID() };
	const protectedValue = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JOSE' })).toString('base64url');
	const payloadValue = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = sign(null, Buffer.from(`${protectedValue}.${payloadValue}`),
		createPrivateKey({ key: input.privateJwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' })).toString('base64url');
	return { protected: protectedValue, payload: payloadValue, signature };
}

export async function initializeCapacityProviderIdentity(input: { ref: string; baseDirectory: string; dataDirectory?: string }) {
	const privateJwk = generateCapacityProviderIdentity();
	await writeProviderSecret(input.ref, JSON.stringify(privateJwk), input.baseDirectory, input.dataDirectory);
	return privateJwk;
}

export async function ensureCapacityProviderIdentity(input: {
	ref: string;
	baseDirectory: string;
	dataDirectory?: string;
	env?: NodeJS.ProcessEnv;
	resolver?: ProviderSecretResolver;
}) {
	try {
		return await loadCapacityProviderIdentity(input);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		await initializeCapacityProviderIdentity(input);
		return loadCapacityProviderIdentity(input);
	}
}

export async function loadCapacityProviderIdentity(input: {
	ref: string;
	baseDirectory: string;
	dataDirectory?: string;
	env?: NodeJS.ProcessEnv;
	resolver?: ProviderSecretResolver;
}) {
	const raw = await resolveProviderSecret(input.ref, input);
	let privateJwk: CapacityProviderPrivateJwk;
	try {
		privateJwk = JSON.parse(raw) as CapacityProviderPrivateJwk;
	} catch {
		throw new Error('Capacity provider identity secret must contain an Ed25519 private JWK.');
	}
	if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.x || !privateJwk.d) throw new Error('Capacity provider identity must be an Ed25519 private JWK.');
	const publicJwk = capacityProviderPublicIdentity(privateJwk);
	return { privateJwk, publicJwk };
}
