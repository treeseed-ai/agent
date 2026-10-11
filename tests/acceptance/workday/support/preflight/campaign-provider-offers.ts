import assert from 'node:assert/strict';
import { capabilityOfferDigest, capabilityOfferSchema } from '@treeseed/sdk/capacity-provider';
import { read, row, type Row } from '../../../acceptance-cli.ts';

function frozenSupply(manifest: Row): Row[] {
	assert.ok(Number.isSafeInteger(manifest.providerOfferRevision) && Number(manifest.providerOfferRevision) > 0, 'ACCEPTANCE_CAMPAIGN_OFFERS: Exact frozen offer revision required');
	const supply = row(row(manifest.allocationInputsByRun).sdk).providerSupply;
	assert.ok(Array.isArray(supply) && supply.length > 0, 'ACCEPTANCE_CAMPAIGN_OFFERS: Complete frozen provider supply required');
	const values = supply.map(row), ids = values.map(value => value.providerId);
	assert.ok(ids.every(id => typeof id === 'string' && id && id.trim() === id) && new Set(ids).size === ids.length,
		'ACCEPTANCE_CAMPAIGN_OFFERS: Exact unique frozen providers required');
	return values;
}

function authority(offers: unknown): Row[] {
	const code = 'ACCEPTANCE_CAMPAIGN_OFFERS';
	assert.ok(Array.isArray(offers) && offers.length > 0, `${code}: Original complete offer inventory required`);
	const ids = new Set<string>();
	return offers.map(value => {
		const original = row(value);
		assert.deepEqual(Object.keys(original).sort(), ['executionProviderId', 'offerId', 'offerDigest', 'offer', 'status', 'observedAt'].sort(),
			`${code}: Original native offer fields required`);
		assert.ok(typeof original.executionProviderId === 'string' && original.executionProviderId && original.executionProviderId.trim() === original.executionProviderId
			&& typeof original.status === 'string' && original.status && original.status.trim() === original.status, `${code}: Exact native owner and status required`);
		assert.ok(typeof original.observedAt === 'string' && Number.isFinite(Date.parse(original.observedAt)), `${code}: Original observation clock required`);
		const offer = capabilityOfferSchema.parse(original.offer);
		assert.deepEqual(offer, original.offer, `${code}: Native offer must already be canonical`);
		const { offerDigest, ...material } = offer;
		assert.equal(offerDigest, capabilityOfferDigest(material), `${code}: Original offer digest differs from its configuration`);
		assert.equal(original.offerId, offer.offerId); assert.equal(original.offerDigest, offerDigest);
		assert.ok(!ids.has(offer.offerId), `${code}: Duplicate native offer identity`); ids.add(offer.offerId);
		// Heartbeat time is observation metadata. All original offer authority,
		// including inactive unrelated offers, remains visible and compared.
		const { observedAt: _clock, ...configuration } = original;
		return configuration;
	});
}

/** The existing public inventory and frozen original offer rows are authority;
 * the inventory's revision alone cannot establish unchanged configuration. */
export function verifyCampaignProviderOffer(manifest: Row, providerId: string, observed: unknown): Row {
	const code = 'ACCEPTANCE_CAMPAIGN_OFFERS', supplied = frozenSupply(manifest).filter(value => value.providerId === providerId);
	assert.equal(supplied.length, 1, `${code}: Exact frozen provider required`);
	const inventory = row(observed);
	assert.deepEqual(Object.keys(inventory).sort(), ['schemaVersion', 'providerId', 'revision', 'offers'].sort(), `${code}: Original public inventory required`);
	assert.equal(inventory.schemaVersion, 'treeseed.provider-offer-inventory/v1', code);
	assert.equal(inventory.providerId, providerId, `${code}: Foreign provider inventory`);
	assert.equal(inventory.revision, manifest.providerOfferRevision, `${code}: Public offer revision differs from frozen authority`);
	assert.deepEqual(authority(inventory.offers), authority(supplied[0]!.offers), `${code}: Public offer configuration differs from frozen authority`);
	return inventory;
}

export function readCampaignProviderOffers(manifest: Row, team: string, reader: typeof read = read): Map<string, Row> {
	assert.ok(typeof team === 'string' && team && team.trim() === team, 'ACCEPTANCE_CAMPAIGN_OFFERS: Explicit owning team required');
	const supply = frozenSupply(manifest);
	// Validate every frozen row before the first public read; never substitute
	// a registry version, another provider, or a partially checked inventory.
	for (const value of supply) authority(value.offers);
	return new Map(supply.map(value => {
		const providerId = String(value.providerId);
		return [providerId, verifyCampaignProviderOffer(manifest, providerId, reader(['providers', 'offers', 'show', providerId], team))];
	}));
}
