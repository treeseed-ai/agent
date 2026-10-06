import { describe, expect, it } from 'vitest';
import { evaluateProviderDiskCapacity } from '../../../../src/provider/runtime/disk-capacity.ts';
import { providerOperationPath } from '../../../../src/provider/coordination/client.ts';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { validateCapacityProviderManifestV5 } from '@treeseed/sdk/capacity-provider';
import { createManagedProviderManifestV5 } from '../../../../src/provider/configuration/managed-manifest.ts';
import { capabilityAccountingLimitsSchema } from '@treeseed/sdk/agent-capacity';

describe('provider arbitration hardgate boundary authority', () => {
	it('denies downgraded missing future duplicate failed and revoked qualification without changing offer authority', () => {
		const digest = `sha256:${'d'.repeat(64)}`, manifest = createManagedProviderManifestV5({ release: 'qualification-authority',
			guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
		const original = structuredClone(manifest), target = manifest.adapters.flatMap(value => value.offers)
			.find(binding => binding.offer.conformance.some(receipt => receipt.tier === 'automated-suite'))!;
		const index = target.offer.conformance.findIndex(receipt => receipt.tier === 'automated-suite');
		for (const mode of ['insufficient', 'missing-suite', 'future', 'duplicate', 'failed', 'revoked']) {
			const offer = structuredClone(target.offer), receipt = offer.conformance[index]!;
			if (mode === 'insufficient') { receipt.tier = 'signed-attestation'; receipt.suite = null; }
			if (mode === 'missing-suite') receipt.suite = null;
			if (mode === 'future') receipt.issuedAt = new Date(Date.now() + 60_000).toISOString();
			if (mode === 'duplicate') offer.conformance.push(structuredClone(receipt));
			if (mode === 'failed' || mode === 'revoked') receipt.status = mode;
			const supplied = structuredClone(manifest); supplied.adapters.flatMap(value => value.offers)
				.find(binding => binding.offer.offerId === target.offer.offerId)!.offer = offer;
			const held = structuredClone(supplied), result = validateCapacityProviderManifestV5(supplied);
			expect(result.ok, mode).toBe(false); expect(result.diagnostics.some(value => value.code.startsWith('provider_offer_conformance')), mode).toBe(true);
			expect(supplied).toEqual(held);
		}
		expect(validateCapacityProviderManifestV5(manifest)).toEqual({ ok: true, diagnostics: [] }); expect(manifest).toEqual(original);
	});
	it('manifest validation uses the original quota schema to deny malformed model daily and capability limits without coercion or changing a valid zero ceiling', () => {
		const digest = `sha256:${'d'.repeat(64)}`, manifest = createManagedProviderManifestV5({ release: 'quota-authority',
			guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
		const original = structuredClone(manifest), capability = manifest.adapters[0]!.offers[0]!.offer.capabilities[0]!.id;
		const valid = { modelConfigurationId: 'original-shared-model', dailyActiveSecondsLimit: 0,
			capabilityLimits: { [capability]: { dailyActiveSecondsLimit: 0 } } };
		manifest.adapters[0]!.nativeLimits = structuredClone(valid);
		expect(capabilityAccountingLimitsSchema.parse(valid)).toEqual(valid);
		expect(validateCapacityProviderManifestV5(manifest)).toEqual({ ok: true, diagnostics: [] });
		const malformed: Record<string, unknown>[] = [];
		for (const modelConfigurationId of [undefined, null, '', ' ', 0, false, [], {}]) malformed.push({ ...valid, modelConfigurationId });
		for (const dailyActiveSecondsLimit of [undefined, null, '0', false, -1, NaN, Infinity, -Infinity]) {
			malformed.push({ ...valid, dailyActiveSecondsLimit }, { ...valid, capabilityLimits: { [capability]: { dailyActiveSecondsLimit } } });
		}
		for (const capabilityLimits of [undefined, null, [], {}, { [capability]: null }, { [capability]: [] },
			{ [capability]: { dailyActiveSecondsLimit: 0, minimumAssignmentSeconds: 1 } }]) malformed.push({ ...valid, capabilityLimits });
		for (const maximumAssignmentSeconds of [null, '1', false, 0, -1, 1.5, NaN, Infinity, -Infinity]) {
			malformed.push({ ...valid, capabilityLimits: { [capability]: { dailyActiveSecondsLimit: 0, maximumAssignmentSeconds } } });
		}
		for (const nativeLimits of malformed) {
			const supplied = structuredClone(manifest); supplied.adapters[0]!.nativeLimits = nativeLimits;
			const before = structuredClone(supplied);
			expect(capabilityAccountingLimitsSchema.safeParse(nativeLimits).success).toBe(false);
			const result = validateCapacityProviderManifestV5(supplied);
			expect(result.ok).toBe(false);
			expect(result.diagnostics.map(item => ({ code: item.code, path: item.path })))
				.toEqual([{ code: 'provider_adapter_limits_invalid', path: 'adapters[0].nativeLimits' }]);
			expect(supplied).toEqual(before);
		}
		for (const maximumAssignmentSeconds of [undefined, 1]) {
			const positive = { ...valid, capabilityLimits: { [capability]: { dailyActiveSecondsLimit: 0, maximumAssignmentSeconds } } };
			manifest.adapters[0]!.nativeLimits = positive;
			expect(capabilityAccountingLimitsSchema.safeParse(positive).success).toBe(true);
			expect(validateCapacityProviderManifestV5(manifest)).toEqual({ ok: true, diagnostics: [] });
		}
		manifest.adapters[0]!.nativeLimits = structuredClone(original.adapters[0]!.nativeLimits);
		expect(manifest).toEqual(original);
	});
	it('admits the exact original disk boundary and denies one byte less without changing supplied capacity', () => {
		const source = { path: '/isolated', totalBytes: 100 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 };
		const before = structuredClone(source), exact = evaluateProviderDiskCapacity(source);
		expect(exact).toMatchObject({ ok: true, requiredAvailableBytes: source.availableBytes, deficitBytes: 0, reason: null });
		expect(evaluateProviderDiskCapacity({ ...source, availableBytes: source.availableBytes - 1 }))
			.toMatchObject({ ok: false, deficitBytes: 1, requiredAvailableBytes: source.availableBytes });
		expect(source).toEqual(before);
	});
	it('denies missing coerced negative fractional and nonfinite native disk facts instead of converting them into a ready host', () => {
		const outcomes = [];
		for (const field of ['totalBytes', 'availableBytes', 'minimumReserveBytes', 'assignmentHeadroomBytes']) {
			for (const value of [-1, 0.5, '1', null, Infinity, NaN]) {
				const supplied = { path: '/isolated', totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3,
					minimumReserveBytes: 0, assignmentHeadroomBytes: 0, [field]: value };
				const wire = JSON.parse(JSON.stringify(supplied));
				try { evaluateProviderDiskCapacity(wire); outcomes.push('admitted'); } catch { outcomes.push('denied'); }
			}
		}
		for (const field of ['totalBytes', 'availableBytes']) {
			const wire = JSON.parse(JSON.stringify({ path: '/isolated', totalBytes: 100, availableBytes: 100 })); delete wire[field];
			try { evaluateProviderDiskCapacity(wire); outcomes.push('admitted'); } catch { outcomes.push('denied'); }
		}
		expect(outcomes).toEqual(Array.from({ length: 26 }, () => 'denied'));
	});
	it('retains a configured larger reserve and headroom rather than granting more slots by shrinking native hard limits', () => {
		const source = { path: '/isolated', totalBytes: 100 * 1024 ** 3, availableBytes: 30 * 1024 ** 3,
			minimumReserveBytes: 20 * 1024 ** 3, assignmentHeadroomBytes: 11 * 1024 ** 3 };
		const before = structuredClone(source);
		expect(evaluateProviderDiskCapacity(source)).toMatchObject({ ok: false, reserveBytes: source.minimumReserveBytes,
			assignmentHeadroomBytes: source.assignmentHeadroomBytes, requiredAvailableBytes: 31 * 1024 ** 3, deficitBytes: 1024 ** 3 });
		expect(source).toEqual(before);
	});
	it('binds terminal return only through the existing public operation and rejects missing path authority before any transport', () => {
		const parameters = { assignmentId: 'attempt /foreign?' }, before = structuredClone(parameters);
		const binding = CONTROL_PLANE_OPERATIONS.providers.returnAssignment;
		expect(providerOperationPath(binding, parameters)).toContain(encodeURIComponent(parameters.assignmentId));
		expect(() => providerOperationPath(binding, {})).toThrow(/requires path parameter/u);
		expect(parameters).toEqual(before);
	});
	it('requires distinct team and membership connections to one global provider while retaining every original manifest and exact denial', () => {
		const digest = `sha256:${'d'.repeat(64)}`, manifest = createManagedProviderManifestV5({ release: 'arbitration-authority',
			guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
		const capability = manifest.adapters[0]?.offers[0]?.offer.capabilities[0]?.id;
		expect(capability).toBeTruthy(); if (!capability) throw new Error('Original managed capability required');
		manifest.connections = ['busy-a', 'busy-b', 'quiet'].map(id => ({ id, controlPlaneUrl: 'http://127.0.0.1:7444',
			teamId: `${id}-team`, providerId: 'one-global-provider', membershipId: `membership-${id}`,
			membershipCredentialId: `credential-${id}`, membershipCredentialRef: `data://credential-${id}`,
			offer: { capabilities: [capability], maxConcurrentRunners: 1 } }));
		const before = structuredClone(manifest); expect(validateCapacityProviderManifestV5(manifest)).toEqual({ ok: true, diagnostics: [] });
		for (const [field, code] of [['teamId', 'provider_connection_team_duplicate'],
			['membershipId', 'provider_connection_membership_duplicate'], ['providerId', 'provider_connection_identity_mismatch']] as const) {
			const supplied = structuredClone(manifest);
			supplied.connections[1]![field] = field === 'providerId' ? 'foreign-global-provider' : supplied.connections[0]![field];
			const bytes = structuredClone(supplied), result = validateCapacityProviderManifestV5(supplied);
			expect(result.ok).toBe(false); expect(result.diagnostics.map(item => item.code)).toEqual([code]);
			expect(supplied).toEqual(bytes);
		}
		expect(manifest).toEqual(before);
	});
});
