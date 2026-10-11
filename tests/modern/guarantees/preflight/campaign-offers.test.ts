import { expect, it, vi } from 'vitest';
import { capabilityOfferDigest } from '@treeseed/sdk/capacity-provider';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { readCampaignProviderOffers, verifyCampaignProviderOffer } from '../../../acceptance/workday/support/preflight/campaign-provider-offers.ts';
import { campaignOffers } from './campaign-offers-fixture.ts';

it('reads every exact frozen provider offer revision and original configuration through the public boundary without changing supplied observations', () => {
	const f = campaignOffers(), held = structuredClone(f), reader = vi.fn(() => f.inventory);
	expect(verifyCampaignProviderOffer(f.manifest, f.providerId, f.inventory)).toBe(f.inventory);
	expect(readCampaignProviderOffers(f.manifest, 'renamed-team', reader)).toEqual(new Map([[f.providerId, f.inventory]]));
	expect(reader.mock.calls).toEqual([[['providers', 'offers', 'show', f.providerId], 'renamed-team']]);
	const refreshed = structuredClone(f.inventory); for (const offer of refreshed.offers) offer.observedAt = '2026-10-11T00:01:00.000Z';
	expect(verifyCampaignProviderOffer(f.manifest, f.providerId, refreshed)).toBe(refreshed);
	expect(f).toEqual(held);
});

it('denies missing malformed foreign moved duplicated and incomplete provider offer authority while retaining every original failed input before exact retry', () => {
	for (const mode of ['revision', 'revision-string', 'provider', 'schema', 'unknown', 'missing', 'empty', 'duplicate', 'owner',
		'clock', 'digest', 'offer-id', 'configuration', 'status', 'omitted', 'reordered', 'uncanonical']) {
		const f = campaignOffers(), observed: Record<string, unknown> = structuredClone(f.inventory), offers = observed.offers as typeof f.inventory.offers;
		if (mode === 'revision') observed.revision = f.inventory.revision + 1;
		if (mode === 'revision-string') observed.revision = String(f.inventory.revision);
		if (mode === 'provider') observed.providerId = 'foreign'; if (mode === 'schema') observed.schemaVersion = 'unknown';
		if (mode === 'unknown') observed.compatibilityOffers = []; if (mode === 'missing') delete observed.offers;
		if (mode === 'empty') observed.offers = []; if (mode === 'duplicate') offers.push(structuredClone(offers[0]!));
		if (mode === 'owner') offers[0]!.executionProviderId = 'foreign'; if (mode === 'clock') offers[0]!.observedAt = 'invalid';
		if (mode === 'digest') offers[0]!.offerDigest = `sha256:${'f'.repeat(64)}`;
		if (mode === 'offer-id') offers[0]!.offerId = 'foreign'; if (mode === 'status') offers[0]!.status = 'disabled';
		if (mode === 'omitted') offers.pop(); if (mode === 'reordered') offers.reverse();
		if (mode === 'uncanonical') Reflect.set(offers[0]!.offer, 'retiredOffer', true);
		if (mode === 'configuration') {
			offers[0]!.offer.features.push('changed-native-configuration');
			const { offerDigest: _old, ...material } = offers[0]!.offer;
			offers[0]!.offer.offerDigest = capabilityOfferDigest(material); offers[0]!.offerDigest = offers[0]!.offer.offerDigest;
		}
		const held = structuredClone({ f, observed });
		expect(() => verifyCampaignProviderOffer(f.manifest, f.providerId, observed), mode).toThrow();
		expect({ f, observed }).toEqual(held); expect(verifyCampaignProviderOffer(f.manifest, f.providerId, f.inventory)).toBe(f.inventory);
	}
	for (const mode of ['missing-supply', 'empty-supply', 'foreign-supply', 'duplicate-supply', 'missing-offers', 'empty-offers']) {
		const f = campaignOffers(), supply = f.manifest.allocationInputsByRun.sdk!.providerSupply;
		if (mode === 'missing-supply') Reflect.deleteProperty(f.manifest.allocationInputsByRun.sdk!, 'providerSupply');
		if (mode === 'empty-supply') supply.length = 0; if (mode === 'foreign-supply') supply[0]!.providerId = ' ';
		if (mode === 'duplicate-supply') supply.push(structuredClone(supply[0]!));
		if (mode === 'missing-offers') Reflect.deleteProperty(supply[0]!, 'offers'); if (mode === 'empty-offers') Reflect.set(supply[0]!, 'offers', []);
		const reader = vi.fn(() => f.inventory), held = structuredClone(f);
		expect(() => readCampaignProviderOffers(f.manifest, 'team', reader), mode).toThrow(); expect(reader).not.toHaveBeenCalled(); expect(f).toEqual(held);
	}
});

it('selects original provider offer readback in the normal SDK freeze and retains preparation evidence before proposal creation', () => {
	const guarantee = parse(readFileSync('guarantees/agent/golden/sdk-complete.guarantee.yaml', 'utf8')) as { acceptanceCriteria: Array<{ criterion: string; verifierRefs: string[] }> };
	expect(guarantee.acceptanceCriteria.filter(value => value.criterion === '2feaea9a8a706e1279affead3af5bacc467f12b285ba2570f183361c5d8203c7'))
		.toEqual([{ criterion: '2feaea9a8a706e1279affead3af5bacc467f12b285ba2570f183361c5d8203c7', verifierRefs: ['agent.golden.live.campaign-freeze', 'agent.golden.live.campaign'] }]);
	for (const asset of ['tests/acceptance/freeze-integrity.test.ts', 'tests/acceptance/prepare-campaign.ts'])
		expect(readFileSync(asset, 'utf8')).toContain('readCampaignProviderOffers(');
});
