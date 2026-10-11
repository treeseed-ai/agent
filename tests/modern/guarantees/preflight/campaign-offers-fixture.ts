import { createManagedProviderManifestV5 } from '../../../../src/provider/configuration/managed-manifest.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';

export function campaignOffers() {
	const manifest = campaignInputs(['sdk']), providerId = manifest.allocationInputsByRun.sdk!.providerSupply[0]!.providerId;
	const digest = `sha256:${'a'.repeat(64)}`;
	const produced = createManagedProviderManifestV5({ release: 'native-frozen-offer', guestImage: 'isolated/guest',
		guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const offers = produced.adapters[0]!.offers.map(({ offer }, index) => ({ executionProviderId: 'renamed-execution-provider',
		offerId: offer.offerId, offerDigest: offer.offerDigest, offer, status: index ? 'context_overflow' : 'active',
		observedAt: '2026-10-11T00:00:00.000Z' })).sort((left, right) => left.offerId < right.offerId ? -1 : left.offerId > right.offerId ? 1 : 0);
	Reflect.set(manifest.allocationInputsByRun.sdk!.providerSupply[0]!, 'offers', structuredClone(offers));
	const inventory = { schemaVersion: 'treeseed.provider-offer-inventory/v1', providerId, revision: manifest.providerOfferRevision, offers };
	return { manifest, inventory, providerId };
}
