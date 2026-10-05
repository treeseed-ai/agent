import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { capabilityOfferDigest, CORE_CAPABILITY_DEFINITIONS, capabilityDefinitionDigest, type CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { assignmentOfferId } from '../../src/provider/execution/assignment-selection.ts';
import * as identity from '../../src/provider/accounts/identity.ts';
import { createManagedProviderManifestV5 } from '../../src/provider/configuration/managed-manifest.ts';
import { materializeCapabilityOffers } from '../../src/provider/capabilities/materialize-offers.ts';
import type { ProviderHostRuntimeConfig } from '../../src/provider/configuration/config.ts';
import { verifyProviderConformanceSignature, verifyProviderQualification } from '../acceptance/workday/support/record-custody.ts';

afterEach(() => vi.restoreAllMocks());

function offerInput() {
	const digest = `sha256:${'d'.repeat(64)}`, manifest = createManagedProviderManifestV5({ release: 'offer-signature-input',
		guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const privateKey = generateKeyPairSync('ed25519').privateKey, privateJwk = privateKey.export({ format: 'jwk' });
	if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.x || !privateJwk.d) throw new Error('Native Ed25519 fixture required');
	const supplied = { privateJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: privateJwk.x, d: privateJwk.d },
		publicJwk: identity.capacityProviderPublicIdentity({ kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d }) };
	vi.spyOn(identity, 'loadCapacityProviderIdentity').mockResolvedValue(supplied);
	const config: ProviderHostRuntimeConfig = { dataDir: '/unexecuted-unit-input', manifestPath: '/unexecuted-unit-input/manifest.yaml',
		environment: 'local', maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null,
		dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null, env: {}, redactedEnv: {} };
	return { input: { config, loaded: { path: config.manifestPath!, directory: config.dataDir, manifest }, providerId: 'renamed-provider' }, supplied, privateKey };
}

describe('canonical assignment offer selection', () => {
	it('checks every exact qualification in one complete ontology batch without accepting empty partial duplicate or moved definitions or changing inputs', async () => {
		const f = offerInput(), published = await materializeCapabilityOffers(f.input);
		for (const adapter of published) for (const { offer } of adapter.offers) {
			const definitions = offer.capabilities.map(reference => {
				const definition = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === reference.id);
				if (!definition) throw new Error('Original exact ontology required');
				return definition;
			});
			const before = structuredClone({ offer, definitions }), now = new Date().toISOString();
			verifyProviderQualification(offer, definitions, f.supplied.publicJwk, f.input.providerId, now);
			for (const changed of [[], definitions.slice(1), [...definitions, definitions[0]],
				definitions.map((value, index) => index === 0 ? { ...value, digest: `sha256:${'0'.repeat(64)}` } : value)]) {
				const retained = structuredClone(changed);
				expect(() => verifyProviderQualification(offer, changed, f.supplied.publicJwk, f.input.providerId, now)).toThrow();
				expect(changed).toEqual(retained);
			}
			expect({ offer, definitions }).toEqual(before);
		}
	});
	it('denies validly signed insufficient missing duplicate contradictory and future qualification while retaining attestation-only and exact declared suite inputs', async () => {
		const f = offerInput(), published = await materializeCapabilityOffers(f.input), original = published[0]!.offers[0]!.offer;
		const now = '2026-10-04T12:00:00.000Z';
		const signed = (offer: CapabilityOffer) => {
			for (const receipt of offer.conformance) {
				receipt.signature.value = '';
				receipt.signature.value = sign(null, Buffer.from(canonicalStandardsJson(receipt)), f.privateKey).toString('base64url');
			}
			const { offerDigest: ignored, ...material } = offer; offer.offerDigest = capabilityOfferDigest(material); return offer;
		};
		for (const tier of ['signed-attestation', 'automated-suite', 'reviewed-certification'] as const) {
			const source = CORE_CAPABILITY_DEFINITIONS.find(value => value.qualificationTier === (tier === 'signed-attestation' ? tier : 'automated-suite'));
			if (!source) throw new Error('Original qualification definition required');
			const definition = { ...structuredClone(source), qualificationTier: tier };
			const { digest: ignored, ...material } = definition; definition.digest = capabilityDefinitionDigest(material);
			const offer = structuredClone(original), reference = { id: definition.id, version: definition.version, digest: definition.digest };
			offer.capabilities = [reference]; offer.conformance = [{ ...structuredClone(original.conformance[0]!),
				capability: reference, tier, status: 'passed', suite: tier === 'signed-attestation' ? null : { id: 'supplied-qualification', version: '1.0.0' },
				issuedAt: '2026-10-04T11:59:59.000Z', expiresAt: null }]; signed(offer);
			const before = structuredClone({ offer, definition, identity: f.supplied.publicJwk });
			verifyProviderQualification(offer, definition, f.supplied.publicJwk, f.input.providerId, now);
			for (const mode of ['failed', 'revoked', 'future', 'expired', 'reverse-clock', 'duplicate', 'failed-first', 'revoked-last',
				'foreign-provider', 'moved-definition', ...(tier === 'signed-attestation' ? [] : ['insufficient', 'missing-suite'])]) {
				const changed = structuredClone(offer), target = structuredClone(definition), receipt = changed.conformance[0]!;
				if (mode === 'failed') receipt.status = 'failed'; if (mode === 'revoked') receipt.status = 'revoked';
				if (mode === 'future') receipt.issuedAt = '2026-10-04T12:00:00.001Z';
				if (mode === 'expired') receipt.expiresAt = now;
				if (mode === 'reverse-clock') receipt.expiresAt = '2026-10-04T11:59:58.000Z';
				if (mode === 'duplicate') changed.conformance.push(structuredClone(receipt));
				if (mode === 'failed-first') changed.conformance.unshift({ ...structuredClone(receipt), status: 'failed' });
				if (mode === 'revoked-last') changed.conformance.push({ ...structuredClone(receipt), status: 'revoked' });
				if (mode === 'foreign-provider') receipt.providerId = 'foreign-provider';
				if (mode === 'moved-definition') target.digest = `sha256:${'0'.repeat(64)}`;
				if (mode === 'insufficient') { receipt.tier = 'signed-attestation'; receipt.suite = null; }
				if (mode === 'missing-suite') receipt.suite = null;
				signed(changed); const unchanged = structuredClone({ changed, target });
				expect(() => verifyProviderQualification(changed, target, f.supplied.publicJwk, f.input.providerId, now), `${tier}:${mode}`).toThrow();
				expect({ changed, target }).toEqual(unchanged);
			}
			expect({ offer, definition, identity: f.supplied.publicJwk }).toEqual(before);
		}
		// Controlled ontology/receipt inputs with real signatures. Neither
		// reviewed certification nor native conformance execution is fabricated.
	});
	it('binds every supplied conformance status and evidence byte to the original provider key without mutating templates or laundering failed qualification', async () => {
		const f = offerInput(), template = f.input.loaded.manifest.adapters[0]!.offers[0]!.offer;
		const valid = structuredClone(f.input), published = await materializeCapabilityOffers(f.input);
		template.conformance[0]!.status = 'failed'; template.conformance[1]!.status = 'revoked';
		const original = structuredClone(f.input), key = structuredClone(f.supplied);
		await expect(materializeCapabilityOffers(f.input)).rejects.toThrow('Invalid provider qualification:');
		// Retained failed and revoked receipts are signed controlled evidence,
		// never an advertisement published by the owning provider.
		for (const [adapterIndex, adapter] of published.entries()) for (const [offerIndex, binding] of adapter.offers.entries()) {
			const source = original.loaded.manifest.adapters[adapterIndex]!.offers[offerIndex]!.offer;
			for (const [index, receipt] of binding.offer.conformance.entries()) {
				receipt.status = source.conformance[index]!.status; receipt.signature.value = '';
				receipt.signature.value = sign(null, Buffer.from(canonicalStandardsJson(receipt)), f.privateKey).toString('base64url');
			}
			const { offerDigest: ignored, ...material } = binding.offer; binding.offer.offerDigest = capabilityOfferDigest(material);
		}
		expect(published).toHaveLength(original.loaded.manifest.adapters.length);
		for (const [adapterIndex, adapter] of published.entries()) for (const [offerIndex, binding] of adapter.offers.entries()) {
			const source = original.loaded.manifest.adapters[adapterIndex]!.offers[offerIndex]!.offer;
			expect(binding.offer.conformance).toHaveLength(source.conformance.length);
			for (const [index, receipt] of binding.offer.conformance.entries()) {
				expect(receipt).toEqual({ ...source.conformance[index]!, providerId: f.input.providerId, signature: receipt.signature });
				verifyProviderConformanceSignature(receipt, f.supplied.publicJwk, f.input.providerId);
			}
			const { offerDigest, ...material } = binding.offer; expect(offerDigest).toBe(capabilityOfferDigest(material));
		}
		expect(published[0]!.offers[0]!.offer.conformance.slice(0, 2).map(value => value.status)).toEqual(['failed', 'revoked']);
		expect(f.input).toEqual(original); expect(f.supplied).toEqual(key);
		f.input.loaded = valid.loaded;
		expect(await materializeCapabilityOffers(f.input)).toHaveLength(valid.loaded.manifest.adapters.length);
		expect(f.input).toEqual(valid);
	});
	it('denies changed missing malformed foreign and reused conformance signatures while retaining the exact supplied failed or revoked evidence', async () => {
		const f = offerInput(), published = await materializeCapabilityOffers(f.input), source = published[0]!.offers[0]!.offer.conformance[0]!;
		const foreign = createPublicKey(generateKeyPairSync('ed25519').privateKey).export({ format: 'jwk' });
		for (const mode of ['provider', 'capability-id', 'capability-version', 'capability-digest', 'tier', 'status', 'evidence', 'suite',
			'issued', 'expiry', 'key-id', 'signature', 'empty', 'padding', 'foreign-key']) {
			const receipt = structuredClone(source); let publicKey: unknown = f.supplied.publicJwk;
			if (mode === 'provider') receipt.providerId = 'foreign-provider';
			if (mode === 'capability-id') receipt.capability.id = 'treeseed.foreign';
			if (mode === 'capability-version') receipt.capability.version = '999.0.0';
			if (mode === 'capability-digest') receipt.capability.digest = `sha256:${'f'.repeat(64)}`;
			if (mode === 'tier') receipt.tier = receipt.tier === 'signed-attestation' ? 'automated-suite' : 'signed-attestation';
			if (mode === 'status') receipt.status = 'failed';
			if (mode === 'evidence') receipt.evidenceDigest = `sha256:${'f'.repeat(64)}`;
			if (mode === 'suite') receipt.suite = { id: 'foreign-suite', version: '999.0.0' };
			if (mode === 'issued') receipt.issuedAt = '2020-01-01T00:00:00.000Z';
			if (mode === 'expiry') receipt.expiresAt = '2020-01-01T00:00:00.000Z';
			if (mode === 'key-id') receipt.signature.keyId = 'foreign-key';
			if (mode === 'signature') receipt.signature.value = Buffer.alloc(64).toString('base64url');
			if (mode === 'empty') receipt.signature.value = '';
			if (mode === 'padding') receipt.signature.value += '=';
			if (mode === 'foreign-key') publicKey = foreign;
			const before = structuredClone({ receipt, publicKey });
			expect(() => verifyProviderConformanceSignature(receipt, publicKey, f.input.providerId)).toThrow();
			expect({ receipt, publicKey }).toEqual(before);
		}
		for (const status of ['failed', 'revoked'] as const) {
			const next = offerInput(); next.input.loaded.manifest.adapters[0]!.offers[0]!.offer.conformance[0]!.status = status;
			const before = structuredClone(next.input);
			await expect(materializeCapabilityOffers(next.input)).rejects.toThrow('Invalid provider qualification:');
			const receipt = structuredClone(source); receipt.status = status;
			receipt.signature.keyId = `provider-${createHash('sha256').update(next.supplied.publicJwk.x).digest('hex').slice(0, 16)}`;
			receipt.signature.value = ''; receipt.signature.value = sign(null, Buffer.from(canonicalStandardsJson(receipt)), next.privateKey).toString('base64url');
			verifyProviderConformanceSignature(receipt, next.supplied.publicJwk, next.input.providerId); expect(receipt.status).toBe(status);
			expect(next.input).toEqual(before);
		}
		expect(published[0]!.offers[0]!.offer.conformance[0]).toEqual(source);
	});
	it('reads the frozen provider offer from the immutable assignment attempt', () => {
		expect(assignmentOfferId({ assignmentAttempt: { provider: { offerId: 'codex-engineering' } } })).toBe('');
		const attempt = {
			schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment', idempotencyKey: 'assignment',
			teamId: 'team', projectId: 'project', workdayId: 'workday', nodeId: 'node', agentClass: 'reviewer', workItemId: 'work-item', nodeRevision: 1, graphRevision: 1,
			sourceRef: { store: 'postgresql', model: 'decision', id: 'source', revision: 1, digest: `sha256:${'a'.repeat(64)}` },
			authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'authority', revision: 1, digest: `sha256:${'b'.repeat(64)}` }],
			effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/reviewer', revision: 1, digest: `sha256:${'c'.repeat(64)}` },
				activity: 'reviewing', handler: 'writer', handlerOrigin: 'agent-package', prompt: { system: 'Review the exact authorized candidate.' },
				permissionCeiling: { content: { read: [], write: [] }, tools: [] } },
			requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
			provider: { providerId: 'provider', offerId: 'codex-engineering', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild: `sha256:${'d'.repeat(64)}` },
			contextRefs: [], predecessorResultIds: [], acceptanceCriteria: ['Review the exact result.'], workspace: { mode: 'read-only' },
			estimate: { expectedSeconds: 2, maximumSeconds: 3 },
			limits: { maximumSeconds: 3, maximumContextBytes: 1, maximumContextItems: 1 },
			deadline: '2026-09-14T03:00:00.000Z', leaseId: 'lease', reservationId: 'reservation', attempt: 1,
			status: 'created', createdAt: '2026-09-14T02:00:00.000Z',
		};
		expect(assignmentOfferId({ assignmentAttempt: attempt })).toBe('codex-engineering');
	});
});
