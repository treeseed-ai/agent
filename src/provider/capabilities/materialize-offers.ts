import { createHash, createPrivateKey, sign } from 'node:crypto';
import {
	capabilityOfferDigest,
	capabilityOfferSchema,
	type CapacityProviderManifestV5,
} from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { LoadedProviderManifest } from '../configuration/manifest.ts';
import { loadCapacityProviderIdentity } from '../accounts/identity.ts';

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/**
 * Provider manifests describe private adapter/offer bindings, but a portable
 * manifest cannot know the provider identity assigned by every control plane.
 * Bind and sign conformance at advertisement time from encrypted host custody.
 */
export async function materializeCapabilityOffers(input: {
	config: ProviderHostRuntimeConfig;
	loaded: LoadedProviderManifest & { manifest: CapacityProviderManifestV5 };
	providerId: string;
}) {
	const identity = await loadCapacityProviderIdentity({
		ref: input.loaded.manifest.identity.privateKeyRef,
		baseDirectory: input.loaded.directory,
		dataDirectory: input.config.dataDir,
		env: input.config.env,
	});
	const signingKey = createPrivateKey({ key: identity.privateJwk as never, format: 'jwk' });
	const keyId = `provider-${createHash('sha256').update(identity.publicJwk.x).digest('hex').slice(0, 16)}`;
	return input.loaded.manifest.adapters.map((adapter) => ({
		...adapter,
		offers: adapter.offers.map((binding) => {
			const conformance = binding.offer.conformance.map((template) => {
				const unsigned = { ...template, providerId: input.providerId,
					signature: { keyId, algorithm: 'Ed25519' as const, value: '' } };
				return { ...unsigned, signature: { ...unsigned.signature,
					value: sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url') } };
			});
			const { offerDigest: _templateDigest, ...template } = binding.offer;
			const material = { ...template, conformance };
			return { ...binding, offer: capabilityOfferSchema.parse({ ...material, offerDigest: capabilityOfferDigest(material) }) };
		}),
	}));
}
