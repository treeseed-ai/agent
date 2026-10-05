import { describe, expect, it } from 'vitest';
import { arbitrationFixture } from './arbitration-fixture.ts';
import { readFile } from 'node:fs/promises';
import { loadProviderManifest } from '../../../../src/provider/configuration/manifest.ts';
import { capabilityOfferDigest, capabilityOfferSchema, CORE_CAPABILITY_DEFINITIONS } from '@treeseed/sdk/capacity-provider';
import { verifyProviderConformanceSignature, verifyProviderQualification, verifyProviderPollingSelection } from '../../../acceptance/workday/support/record-custody.ts';
import { row } from '../../../acceptance/acceptance-cli.ts';

// Actual runtime/coordinator/OS custody/SDK HTTP/disk/store in independent
// processes, NOT mocks of arbitration. Controlled API replies remain INPUTS:
// these cases do not establish API hardgate policy, productive Kata execution,
// provider-generated external charges, physical cleanup or managed fairness.
describe('whole native provider polling arbitration boundary', () => {
	it('native original global runtime retains exact preclaim eligible metadata and measured seconds on failed custody so independent restart cannot replace the selected team history', async () => {
		const f = await arbitrationFixture();
		try {
			await f.measure('busy-a'); await f.measure('busy-b');
			const snapshot = await f.store.snapshot(), manifest = structuredClone(f.manifest), bytes = await readFile(f.config.manifestPath!);
			const expected = { connections: manifest.connections.map(connection => ({ connection: { id: connection.id }, teamId: connection.teamId! })),
				snapshot: { claims: snapshot.claims.map(claim => ({ connectionId: claim.connectionId })),
					events: snapshot.events.map(event => ({ connectionId: event.connectionId, outcome: event.outcome })),
					activeSecondsByConnection: structuredClone(snapshot.activeSecondsByConnection) } };
			const envelope = { assignment: { id: 'original-malformed-native-selection', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
				assignmentAttempt: {} }, leaseToken: 'isolated-original-selection-lease' };
			const supplied = structuredClone(envelope); f.setLease(envelope); await f.run();
			const held = await f.store.claimsForRecovery(); expect(held).toHaveLength(1);
			const owner = row(held[0]);
			expect(owner.connectionId).toBe('quiet'); expect(owner.selection).toEqual({ id: 'quiet', input: expected });
			expect(verifyProviderPollingSelection(owner, manifest.connections)).toEqual({ connectionId: 'quiet', teamId: 'quiet-team',
				eligibleTeams: manifest.connections.map(value => value.teamId), input: expected });
			expect(owner.failureMessage).toBeTruthy(); expect(owner.dispatchEnvelope === undefined).toBe(false);
			expect(held[0]?.dispatchEnvelope).toEqual(supplied); expect(envelope).toEqual(supplied);
			const before = structuredClone(owner.selection), cause = owner.failureMessage;
			await f.run(); const retained = await f.store.claimsForRecovery(); expect(retained).toHaveLength(1);
			expect(row(retained[0]).selection).toEqual(before); expect(retained[0]?.failureMessage).toBe(cause);
			const after = await f.store.snapshot(); expect(after.activeSecondsByConnection).toEqual(snapshot.activeSecondsByConnection);
			expect(after.events.filter(value => value.outcome === 'isolated-local-history'))
				.toEqual(snapshot.events.filter(value => value.outcome === 'isolated-local-history'));
			expect(await readFile(f.config.manifestPath!)).toEqual(bytes); expect(f.manifest).toEqual(manifest);
			// Independent native original runtime/coordinator/SDK/store children.
			// Supplied malformed lease is a failure input, not an executed model,
			// native API approval, canonical productive result or external charge.
		} finally { await f.close(); }
	});
	it('original native provider offer publication denies insufficient future missing and duplicate qualification before signing or changing host custody', async () => {
		const modes = ['insufficient', 'missing-suite', 'future', 'duplicate', 'failed-first', 'revoked-last'];
		// Use the same original initialization in the owned offer child, avoiding
		// a second module startup within the unchanged five-second watchdog.
		const f = await arbitrationFixture(1, true), outcomes: Array<{ mode: string; cause: unknown }> = [];
		try {
			await f.store.snapshot(); const baseline = await f.bytes(), routes = structuredClone(f.routes);
			const original = structuredClone(f.manifest), bytes = await readFile(f.config.manifestPath!);
			const offers = await f.openOffers();
			const first = row(await offers()); expect(f.routes).toEqual(routes); expect(await f.bytes()).toBe(baseline);
			const target = f.manifest.adapters.flatMap(adapter => adapter.offers).find(binding => binding.offer.conformance.some(receipt => receipt.tier === 'automated-suite'));
			if (!target) throw new Error('Original managed automated-suite input required');
			const source = structuredClone(target.offer), index = source.conformance.findIndex(receipt => receipt.tier === 'automated-suite');
			const definition = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === source.conformance[index]!.capability.id);
			if (!definition || definition.qualificationTier !== 'automated-suite') throw new Error('Original declared automated tier required');
			// Reuse the same retained native identity/history for all supplied-input
			// denials. Each retry reloads actual bytes in the same native child.
			for (const mode of modes) {
				const changed = structuredClone(source), receipt = changed.conformance[index]!;
				if (mode === 'insufficient') { receipt.tier = 'signed-attestation'; receipt.suite = null; }
				if (mode === 'missing-suite') receipt.suite = null;
				if (mode === 'future') receipt.issuedAt = new Date(Date.now() + 60_000).toISOString();
				if (mode === 'duplicate') changed.conformance.push(structuredClone(receipt));
				if (mode === 'failed-first') changed.conformance.unshift({ ...structuredClone(receipt), status: 'failed' });
				if (mode === 'revoked-last') changed.conformance.push({ ...structuredClone(receipt), status: 'revoked' });
				const { offerDigest: ignored, ...material } = changed; changed.offerDigest = capabilityOfferDigest(material);
				target.offer = changed; await f.write(); const retained = await readFile(f.config.manifestPath!), unchanged = structuredClone(f.manifest); let cause: unknown;
				try { await offers(); } catch (error) { cause = error; }
				expect((await readFile(f.config.manifestPath!)).equals(retained)).toBe(true); expect(f.manifest).toEqual(unchanged);
				expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
				target.offer = structuredClone(source); await f.write(); expect((await readFile(f.config.manifestPath!)).equals(bytes)).toBe(true);
			const retry = row(await offers()); expect(retry).toEqual(first);
			if (!Array.isArray(retry.adapters)) throw new Error('Native published adapter inventory required');
			expect(f.manifest).toEqual(original); expect((await readFile(f.config.manifestPath!)).equals(bytes)).toBe(true);
			expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
			// Real original publisher/loader/OS identity/native child boundary;
			// supplied suite metadata is not an independently executed suite.
				outcomes.push({ mode, cause });
			}
			// Every independently published retry above is exactly equal to this
			// same snapshot. Verify its immutable signatures once, not six times.
			if (!Array.isArray(first.adapters)) throw new Error('Native published adapter inventory required');
			for (const adapter of first.adapters.map(row)) {
				if (!Array.isArray(adapter.offers)) throw new Error('Native published offer inventory required');
				for (const binding of adapter.offers.map(row)) {
					const offer = capabilityOfferSchema.parse(binding.offer);
					const definitions = offer.capabilities.map(reference => {
						const declared = CORE_CAPABILITY_DEFINITIONS.find(value => value.id === reference.id && value.version === reference.version);
						if (!declared) throw new Error('Original fixture ontology required');
						return declared;
					});
					verifyProviderQualification(offer, definitions, first.publicJwk, original.connections[0]!.providerId, new Date().toISOString());
				}
			}
		} finally { await f.close(); }
		for (const outcome of outcomes) expect(outcome.cause, outcome.mode).toBeInstanceOf(Error);
		for (const outcome of outcomes) expect(String(outcome.cause), outcome.mode).toMatch(/conformance|qualification/iu);
	});
	it('independent original provider processes sign exact offer evidence with native encrypted host identity while preserving failed qualification and unchanged runtime history', async () => {
		const f = await arbitrationFixture();
		try {
			await f.store.snapshot();
			const baseline = await f.bytes(), routes = structuredClone(f.routes);
			const original = structuredClone(f.manifest), bytes = await readFile(f.config.manifestPath!);
			f.manifest.adapters[0]!.offers[0]!.offer.conformance[0]!.status = 'failed';
			f.manifest.adapters[0]!.offers[0]!.offer.conformance[1]!.status = 'revoked';
			const { offerDigest: _originalDigest, ...suppliedMaterial } = f.manifest.adapters[0]!.offers[0]!.offer;
			f.manifest.adapters[0]!.offers[0]!.offer.offerDigest = capabilityOfferDigest(suppliedMaterial);
			await f.write(); const denied = structuredClone(f.manifest), deniedBytes = await readFile(f.config.manifestPath!);
			await expect(f.offers()).rejects.toThrow(/Only passing capability conformance may be advertised/u);
			expect(await readFile(f.config.manifestPath!)).toEqual(deniedBytes); expect(f.manifest).toEqual(denied);
			expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
			f.manifest.adapters = structuredClone(original.adapters); await f.write();
			expect(await readFile(f.config.manifestPath!)).toEqual(bytes);
			const [firstValue, secondValue] = await Promise.all([f.offers(), f.offers()]);
			expect(secondValue).toEqual(firstValue); const first = row(firstValue);
			expect(Array.isArray(first.adapters)).toBe(true); if (!Array.isArray(first.adapters)) throw new Error('Original signed adapter inventory required');
			expect(first.adapters).toHaveLength(original.adapters.length);
			for (const [adapterIndex, rawAdapter] of first.adapters.entries()) {
				const adapter = row(rawAdapter); expect(adapter.id).toBe(original.adapters[adapterIndex]!.id);
				expect(Array.isArray(adapter.offers)).toBe(true); if (!Array.isArray(adapter.offers)) throw new Error('Original signed offer inventory required');
				expect(adapter.offers).toHaveLength(original.adapters[adapterIndex]!.offers.length);
				for (const [index, rawBinding] of adapter.offers.entries()) {
					const offer = capabilityOfferSchema.parse(row(rawBinding).offer), source = original.adapters[adapterIndex]!.offers[index]!.offer;
					expect(offer).toEqual(row(rawBinding).offer); expect(offer.conformance).toHaveLength(source.conformance.length);
					for (const [receiptIndex, receipt] of offer.conformance.entries()) {
						expect(receipt).toEqual({ ...source.conformance[receiptIndex]!, providerId: original.connections[0]!.providerId, signature: receipt.signature });
						verifyProviderConformanceSignature(receipt, first.publicJwk, original.connections[0]!.providerId);
						const changed = structuredClone(receipt); changed.evidenceDigest = `sha256:${'f'.repeat(64)}`;
						const before = structuredClone(changed);
						expect(() => verifyProviderConformanceSignature(changed, first.publicJwk, original.connections[0]!.providerId)).toThrow(/ACCEPTANCE_CONFORMANCE_SIGNATURE/u);
						expect(changed).toEqual(before);
					}
					const { offerDigest, ...material } = offer; expect(capabilityOfferDigest(material)).toBe(offerDigest);
				}
			}
			expect(await readFile(f.config.manifestPath!)).toEqual(bytes); expect(f.manifest).toEqual(original);
			expect(denied.adapters[0]!.offers[0]!.offer.conformance.slice(0, 2).map(value => value.status)).toEqual(['failed', 'revoked']);
			expect(deniedBytes.length).toBeGreaterThan(0);
			expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
			// Signing controlled status/evidence inputs is not execution of a
			// qualification suite, enrollment, API admission or productive dispatch.
		} finally { await f.close(); }
	});
	it('native quota manifests reject malformed model daily and capability limits before coordinator polling or changing retained capacity and admit only exact restored bytes', async () => {
		const f = await arbitrationFixture();
		try {
			await f.store.snapshot();
			const original = structuredClone(f.manifest), baseline = await f.bytes(), routes = structuredClone(f.routes);
			const limits = structuredClone(f.manifest.adapters[0]!.nativeLimits), capability = f.manifest.adapters[0]!.offers[0]!.offer.capabilities[0]!.id;
			const manifestBytes = await readFile(f.config.manifestPath!, 'utf8');
			const malformed: Record<string, unknown>[] = [];
			for (const modelConfigurationId of [undefined, null, '', ' ', 0, false, [], {}]) malformed.push({ ...limits, modelConfigurationId });
			for (const dailyActiveSecondsLimit of [undefined, null, '0', false, -1, NaN, Infinity, -Infinity]) {
				malformed.push({ ...limits, dailyActiveSecondsLimit }, { ...limits, capabilityLimits: { [capability]: { dailyActiveSecondsLimit } } });
			}
			for (const capabilityLimits of [undefined, null, [], {}, { [capability]: null }, { [capability]: [] },
				{ [capability]: { dailyActiveSecondsLimit: 0, minimumAssignmentSeconds: 1 } }]) malformed.push({ ...limits, capabilityLimits });
			for (const maximumAssignmentSeconds of [null, '1', false, 0, -1, 1.5, NaN, Infinity, -Infinity]) {
				malformed.push({ ...limits, capabilityLimits: { [capability]: { dailyActiveSecondsLimit: 0, maximumAssignmentSeconds } } });
			}
			for (const nativeLimits of malformed) {
				f.manifest.adapters[0]!.nativeLimits = nativeLimits; await f.write();
				const before = structuredClone(f.manifest), bytes = await readFile(f.config.manifestPath!, 'utf8');
				await expect(loadProviderManifest(f.config.manifestPath!, f.directory, {}))
					.rejects.toThrow(/Invalid capacity provider manifest:.*adapters\[0\]\.nativeLimits/u);
				expect(await readFile(f.config.manifestPath!, 'utf8')).toBe(bytes);
				expect(f.manifest).toEqual(before); expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
			}
			// Independent original-runtime children prove all three field categories
			// fail at that same loader before real coordinator/token/HTTP activity.
			for (const patch of [{ modelConfigurationId: '' }, { dailyActiveSecondsLimit: -1 }, { capabilityLimits: {} }]) {
				f.manifest.adapters[0]!.nativeLimits = { ...limits, ...patch }; await f.write();
				const bytes = await readFile(f.config.manifestPath!, 'utf8');
				await expect(f.run()).rejects.toThrow(/Invalid capacity provider manifest:.*adapters\[0\]\.nativeLimits/u);
				expect(await readFile(f.config.manifestPath!, 'utf8')).toBe(bytes);
				expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes);
			}
			f.manifest.adapters[0]!.nativeLimits = limits; await f.write();
			expect(await readFile(f.config.manifestPath!, 'utf8')).toBe(manifestBytes);
			await f.run(); expect(f.manifest).toEqual(original);
			expect(new Set(f.routes.filter(item => item.path === f.pollPath).map(item => item.connectionId)))
				.toEqual(new Set(original.connections.map(item => item.id)));
			expect((await f.store.snapshot()).claims).toEqual([]);
		} finally { await f.close(); }
	});
	it('flows an idle team share to the other eligible team within one original host slot without merging connection authority', async () => {
		const f = await arbitrationFixture();
		try {
			await f.run();
			const polls = f.routes.filter(item => item.path === f.pollPath);
			expect(polls.some(item => item.connectionId === 'quiet')).toBe(true);
			expect(new Set(polls.map(item => f.manifest.connections.find(connection => connection.id === item.connectionId)?.teamId)).size).toBe(3);
			// Retain the original busy-versus-quiet observation without confusing
			// its TWO activity groups with the THREE actual distinct team IDs.
			expect(new Set(polls.map(item => item.connectionId === 'quiet' ? 'quiet-team' : 'busy-team')).size).toBe(2);
			expect((await f.store.snapshot()).claims).toEqual([]);
			for (const poll of polls) expect(poll.body).toMatchObject({ leaseSeconds: 300 });
		} finally { await f.close(); }
	});
	it('compares measured actual local seconds across two busy teams before the quieter team without rewriting history', async () => {
		const f = await arbitrationFixture();
		try {
			await f.measure('busy-a'); await f.measure('busy-b');
			const before = await f.store.snapshot(); expect(before.activeSecondsByConnection['busy-a']).toBeGreaterThan(0);
			expect(before.activeSecondsByConnection['busy-b']).toBeGreaterThan(0);
			await f.run(); expect(f.routes.find(item => item.path === f.pollPath)?.connectionId).toBe('quiet');
			const after = await f.store.snapshot(); expect(after.activeSecondsByConnection).toEqual(before.activeSecondsByConnection);
			expect(after.events.filter(item => item.outcome === 'isolated-local-history'))
				.toEqual(before.events.filter(item => item.outcome === 'isolated-local-history'));
			expect(after.claims).toEqual([]);
		} finally { await f.close(); }
	});
	it('does not poll disabled denied or foreign token-bound connections and never borrows a healthy team token', async () => {
		const modes = ['disabled', 'denied', 'team', 'provider', 'membership', 'credential', 'short'];
		const outcomes = await Promise.all(modes.map(async mode => {
			const f = await arbitrationFixture();
			try {
				const busy = f.manifest.connections.find(item => item.id === 'busy-a')!;
				if (mode === 'disabled') busy.enabled = false;
				else if (mode === 'denied') f.faults.set(busy.id, { code: 403 });
				else f.faults.set(busy.id, { tokenPatch: mode === 'short' ? { expiresAt: new Date().toISOString() }
					: { [`${mode}Id`]: 'foreign' } });
				await f.write(); await f.run();
				return { foreignPoll: f.routes.some(item => item.path === f.pollPath && item.connectionId === busy.id),
					claims: (await f.store.snapshot()).claims.length };
			} finally { await f.close(); }
		}));
		expect(outcomes).toEqual(modes.map(() => ({ foreignPoll: false, claims: 0 })));
	});
	it('applies actual host disk denial before any assignment poll slot or productive accounting admission', async () => {
		const f = await arbitrationFixture();
		try {
			f.config.env.TREESEED_PROVIDER_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER); await f.write();
			await f.run(); expect(f.routes.filter(item => item.path === f.pollPath)).toEqual([]);
			const snapshot = await f.store.snapshot(); expect(snapshot.claims).toEqual([]); expect(snapshot.activeSecondsByConnection).toEqual({});
		} finally { await f.close(); }
	});
	it('retains the same global durable slot across overlapping independent runtimes and frees it only after the original poll finishes', async () => {
		const f = await arbitrationFixture();
		try {
			f.hold(); const first = f.run(); await f.awaitPoll();
			const held = await f.store.snapshot(); expect(held.claims).toHaveLength(1);
			await f.run(); expect(f.routes.filter(item => item.path === f.pollPath)).toHaveLength(1);
			expect((await f.store.snapshot()).claims.map(item => item.id)).toEqual(held.claims.map(item => item.id));
			f.release(); await first; expect((await f.store.snapshot()).claims).toEqual([]);
			await f.run(); expect(f.routes.filter(item => item.path === f.pollPath).length).toBeGreaterThan(1);
			expect((await f.store.snapshot()).activeSecondsByConnection).toEqual({});
		} finally { await f.close(); }
	});
	it('releases only unleased polling failures and retries denied unavailable reset and malformed transport without invented usage', async () => {
		const modes = ['denied', 'unavailable', 'reset', 'json'];
		const outcomes = await Promise.all(modes.map(async mode => {
			const f = await arbitrationFixture();
			try {
				// First populate independently scoped real coordinator tokens; fault applies to subsequent actual polls.
				await f.run(); f.routes.splice(0);
				f.faults.set('busy-a', mode === 'denied' ? { code: 403 } : mode === 'unavailable' ? { code: 503 }
					: { fault: mode === 'reset' ? 'reset' : 'json' });
				await f.run(); const snapshot = await f.store.snapshot();
				const outcome = { claims: snapshot.claims.length, seconds: snapshot.activeSecondsByConnection,
					terminal: f.routes.some(item => item.path.endsWith('/return')) };
				f.faults.clear(); await f.run(); expect((await f.store.snapshot()).claims).toEqual([]);
				return outcome;
			} finally { await f.close(); }
		}));
		expect(outcomes).toEqual(modes.map(() => ({ claims: 0, seconds: {}, terminal: false })));
	});
	it('retains malformed leased frozen authority and its original recovery cause rather than manufacturing successful execution', async () => {
		const f = await arbitrationFixture();
		try {
			const envelope = { assignment: { id: 'isolated-malformed', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
				assignmentAttempt: {} }, leaseToken: 'isolated-original-lease' };
			f.setLease(envelope); await f.run(); const retained = await f.store.claimsForRecovery();
			expect(retained).toHaveLength(1); expect(retained[0]?.dispatchEnvelope).toEqual(envelope);
			expect(retained[0]?.leaseToken).toBe(envelope.leaseToken); expect(retained[0]?.failureMessage).toBeTruthy();
			expect(f.routes.some(item => item.path.endsWith('/return'))).toBe(false);
			expect((await f.store.snapshot()).activeSecondsByConnection).toEqual({});
		} finally { await f.close(); }
	});
	it('retains rejected unbound-adapter returns with the original lease instead of treating transport denial as release', async () => {
		const f = await arbitrationFixture();
		try {
			const { assignmentAttemptSchema } = await import('@treeseed/sdk/agent-capacity');
			const { request } = await import('../../kernel/provider-kernel-fixture.ts');
			const original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
			const now = new Date().toISOString(), attempt = assignmentAttemptSchema.parse({ ...original, createdAt: now,
				deadline: new Date(Date.parse(now) + original.limits.maximumSeconds * 1000).toISOString(),
				provider: { ...original.provider, executionProviderId: 'unknown-configured-executor' } });
			const envelope = { assignment: { id: attempt.id, assignmentAttempt: attempt, leaseExpiresAt: attempt.deadline }, leaseToken: 'isolated-original-lease' };
			f.setLease(envelope, 403); await f.run(); const retained = await f.store.claimsForRecovery();
			expect(retained).toHaveLength(1); expect(retained[0]?.dispatchEnvelope).toEqual(envelope);
			expect(retained[0]?.leaseToken).toBe(envelope.leaseToken);
			const returned = f.routes.filter(item => item.path.endsWith('/return')); expect(returned).toHaveLength(1);
			expect(returned[0]?.body).toMatchObject({ code: 'assignment_adapter_unavailable', leaseToken: envelope.leaseToken });
			expect((await f.store.snapshot()).activeSecondsByConnection).toEqual({});
		} finally { await f.close(); }
	});
	it('native duplicate team membership and foreign global identity manifests deny before polling or changing retained local capacity then admit only the restored original input', async () => {
		const f = await arbitrationFixture();
		try {
			await f.store.snapshot();
			const original = structuredClone(f.manifest), baseline = await f.bytes(), routes = structuredClone(f.routes);
			for (const field of ['teamId', 'membershipId', 'providerId'] as const) {
				const first = f.manifest.connections[0]!, second = f.manifest.connections[1]!;
				second[field] = field === 'providerId' ? 'foreign-global-provider' : first[field];
				await f.write(); const supplied = structuredClone(f.manifest);
				await expect(f.run()).rejects.toThrow('Invalid capacity provider manifest');
				expect(await f.bytes()).toBe(baseline); expect(f.routes).toEqual(routes); expect(f.manifest).toEqual(supplied);
				f.manifest.connections = structuredClone(original.connections);
			}
			await f.write(); await f.run();
			expect(f.manifest).toEqual(original);
			const polls = f.routes.filter(item => item.path === f.pollPath);
			expect(new Set(polls.map(item => item.connectionId))).toEqual(new Set(original.connections.map(item => item.id)));
			expect((await f.store.snapshot()).claims).toEqual([]);
		} finally { await f.close(); }
	});
});
