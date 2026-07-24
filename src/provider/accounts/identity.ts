import {
	capacityProviderPublicIdentity,
	generateCapacityProviderIdentity,
	type CapacityProviderPrivateJwk,
} from '@treeseed/sdk/capacity-provider';
import { resolveProviderSecret, writeProviderSecret, type ProviderSecretResolver } from '../configuration/manifest.ts';

export async function initializeCapacityProviderIdentity(input: { ref: string; baseDirectory: string; dataDirectory?: string }) {
	const privateJwk = generateCapacityProviderIdentity();
	await writeProviderSecret(input.ref, JSON.stringify(privateJwk), input.baseDirectory, input.dataDirectory);
	return privateJwk;
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
