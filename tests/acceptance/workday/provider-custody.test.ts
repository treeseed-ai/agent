import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProviderConfig } from '../../../src/provider/configuration/config.ts';
import { loadProviderManifest } from '../../../src/provider/configuration/manifest.ts';
import { loadCapacityProviderIdentity } from '../../../src/provider/accounts/identity.ts';
import { assignmentAttemptSchema, assignmentResultSchema, capabilityAccountingLimitsSchema, remainingCapabilitySeconds } from '@treeseed/sdk/agent-capacity';
import { capabilityOfferDigest, capabilityOfferSchema } from '@treeseed/sdk/capacity-provider';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { verifyPlatformRepository } from '@treeseed/sdk/platform';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';
import { readCompleteEvidence } from './support/evidence-pages.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody, verifyFailedExecutionCustody, verifyAvailabilityAccountingHistory, verifySandboxCloseoutCustody, verifyWorkdayContinuationCustody, verifySandboxHostAbsence, verifySandboxDirectoryAbsence, verifyProviderConformanceSignature, verifyProviderQualification, verifyProviderLocalSlotClosure, verifyProviderPollingSelection } from './support/record-custody.ts';
import { actual, verify, availabilityHistory } from './support/record-readback.ts';

test('Actual global provider retains original multi-team polling choices beside complete public terminal attempts and unchanged exactly-once charges without reconstructing historical eligibility', { timeout: 120_000 }, async () => {
	const f = actual(), before = structuredClone(f), config = resolveProviderConfig({ requireConnection: true });
	assert.ok(config.manifestPath); const loaded = await loadProviderManifest(config.manifestPath, config.dataDir);
	const manifest = structuredClone(loaded.manifest), bytes = readFileSync(loaded.path);
	assert.ok(new Set(manifest.connections.map(connection => connection.teamId)).size >= 2,
		'ACCEPTANCE_PROVIDER_SELECTION_GLOBAL: Actual multi-team native provider required');
	assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'));
	const path = resolve(config.dataDir, 'runtime', 'capacity-state.json');
	const inspect = () => {
		const info = lstatSync(path); assert.ok(info.isFile() && (info.mode & 0o077) === 0 && info.nlink === 1);
		assert.equal(realpathSync(path), path);
		const state = row(JSON.parse(readFileSync(path, 'utf8'))); assert.ok(Array.isArray(state.events));
		const events = state.events.map(row).filter(event => event.outcome === 'leased');
		assert.ok(events.length > 0); const ids = new Set<string>();
		return events.map(event => {
			assert.ok(typeof event.id === 'string' && event.id && !ids.has(event.id)); ids.add(event.id);
			assert.ok(typeof event.assignmentId === 'string' && event.assignmentId && typeof event.claimId === 'string' && event.claimId);
			const selection = verifyProviderPollingSelection(event, manifest.connections);
			assert.ok(typeof selection.teamId === 'string' && typeof selection.connectionId === 'string' && Array.isArray(selection.eligibleTeams));
			return { id: event.id, assignmentId: event.assignmentId, claimId: event.claimId, connectionId: selection.connectionId,
				teamId: selection.teamId, eligibleTeams: selection.eligibleTeams, input: selection.input };
		});
	};
	// Only credential-free assertions escape the original private host state.
	const proofs = inspect(), terminal: Row[] = [], scopes = new Map<string, { team: string; id: string }>();
	for (const proof of proofs) {
		assert.ok(typeof proof.teamId === 'string' && typeof proof.connectionId === 'string');
		const item = read(['assignments', 'show', proof.assignmentId], proof.teamId), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(item.id, proof.assignmentId); assert.equal(attempt.teamId, proof.teamId);
		const connection = manifest.connections.find(value => value.id === proof.connectionId); assert.ok(connection);
		assert.equal(attempt.provider.providerId, connection.providerId); assert.equal(item.membershipId, connection.membershipId);
		if (!['completed', 'failed', 'returned', 'cancelled', 'expired'].includes(String(item.status))) continue;
		terminal.push({ ...proof, status: item.status }); scopes.set(`${proof.teamId}/${attempt.workdayId}`, { team: proof.teamId, id: attempt.workdayId });
	}
	assert.ok(new Set(terminal.map(value => value.teamId)).size >= 2 && terminal.some(value => value.status === 'completed')
		&& terminal.some(value => ['failed', 'returned', 'cancelled', 'expired'].includes(String(value.status))),
		'ACCEPTANCE_PROVIDER_SELECTION_TERMINAL: Actual completed and failed multi-team executions required');
	assert.ok(terminal.some(value => Array.isArray(value.eligibleTeams) && value.eligibleTeams.length >= 2));
	for (const { team, id } of scopes.values()) {
		const observed = read(['workdays', 'show', id], team), run = row(observed.run); assert.equal(run.id, id);
		const collect = () => {
			const items = readWorkdayAssignments(id, String(run.startedAt), team), views: unknown[] = [observed, items], measurements = [];
			assert.ok(items.length > 0);
			for (const item of items) { assert.deepEqual(assignmentAttemptSchema.parse(item.assignmentAttempt), item.assignmentAttempt);
				const shown = read(['assignments', 'show', String(item.id)], team); assert.deepEqual(shown, item); views.push(shown); }
			for (const project of new Set(items.map(item => String(item.projectId)))) {
				assert.ok(project && project !== 'undefined');
				measurements.push(...readCompleteEvidence(['capacity', 'usage', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_PROVIDER_SELECTION_USAGE'));
				views.push(readCompleteEvidence(['capacity', 'ledger', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_PROVIDER_SELECTION_LEDGER'));
			}
			return { items, views, measurements };
		};
		const { items, views, measurements } = collect();
		verifyTerminalRecordCustody(items, publicCanonicalRecords(views, 'treeseed.lease/v1'), publicCanonicalRecords(views, 'treeseed.reservation/v1'),
			publicCanonicalRecords(views, 'treeseed.usage-settlement/v1'), measurements);
		const owned = terminal.filter(value => value.teamId === team && items.some(item => item.id === value.assignmentId)); assert.ok(owned.length > 0);
		for (const item of items.filter(item => terminal.some(value => value.teamId === team && value.assignmentId === item.id)))
			assert.equal(proofs.filter(value => value.assignmentId === item.id && value.teamId === team).length, 1);
		assert.deepEqual(collect(), { items, views, measurements }); assert.deepEqual(read(['workdays', 'show', id], team), observed);
	}
	// Bounded host history may not silently drop any SDK productive attempt.
	for (const item of f.items.filter(item => typeof row(row(row(item.capacityEnvelope).budget).time).executionStartedAt === 'string'
		&& row(row(item.assignmentAttempt).effectiveProfile).handler !== 'reporter'))
		assert.equal(proofs.filter(value => value.assignmentId === item.id && value.teamId === f.run.teamId).length, 1);
	verify(f); verifyGolden('stopped'); assert.deepEqual(inspect(), proofs); assert.deepEqual(actual(), before);
	assert.deepEqual((await loadProviderManifest(config.manifestPath, config.dataDir)).manifest, manifest); assert.ok(readFileSync(loaded.path).equals(bytes));
	// Native component cases independently bind complete before-claim input.
	// Historical replay alone is not proof of every upstream hard gate. No
	// recovery/snapshot/stop, new journal, current-usage substitution or bypass
	// of another team's public authorization is permitted by this read-back.
});
test('Actual managed provider retains one exact current manifest and packaged read-only plan without compatibility translation or changed execution history', { timeout: 120_000 }, async () => {
	const f = actual(), before = structuredClone(f), config = resolveProviderConfig({ requireConnection: true });
	assert.ok(config.manifestPath); const loaded = await loadProviderManifest(config.manifestPath, config.dataDir);
	const manifest = structuredClone(loaded.manifest), manifestBytes = readFileSync(loaded.path);
	const publicIdentity = (await loadCapacityProviderIdentity({ ref: manifest.identity.privateKeyRef, baseDirectory: loaded.directory,
		dataDirectory: config.dataDir, env: config.env })).publicJwk;
	const identityBefore = structuredClone(publicIdentity);
	const offerInventories = new Map<string, ReturnType<typeof read>>();
	const qualificationDefinitions = new Map<string, { id: string; version: string; value: ReturnType<typeof read> }>();
	for (const providerId of new Set(f.items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt).provider.providerId))) {
		const inventory = read(['providers', 'offers', 'show', providerId], f.team);
		assert.equal(inventory.schemaVersion, 'treeseed.provider-offer-inventory/v1'); assert.equal(inventory.providerId, providerId);
		assert.ok(typeof inventory.revision === 'number' && Number.isInteger(inventory.revision) && inventory.revision > 0);
		assert.ok(Array.isArray(inventory.offers) && inventory.offers.length > 0, 'ACCEPTANCE_PROVIDER_OFFERS: Original public offer inventory required');
		const ids = new Set<string>();
		for (const value of inventory.offers) {
			const published = row(value), offer = capabilityOfferSchema.parse(published.offer), { offerDigest, ...material } = offer;
			assert.deepEqual(offer, published.offer); assert.equal(published.offerId, offer.offerId); assert.equal(published.offerDigest, offerDigest);
			assert.equal(capabilityOfferDigest(material), offerDigest);
			for (const receipt of offer.conformance) verifyProviderConformanceSignature(receipt, publicIdentity, providerId);
			assert.ok(typeof published.executionProviderId === 'string' && published.executionProviderId && !ids.has(offer.offerId)); ids.add(offer.offerId);
			assert.ok(typeof published.observedAt === 'string' && Number.isFinite(Date.parse(published.observedAt)));
		}
		offerInventories.set(providerId, inventory);
	}
	assert.equal(manifest.schemaVersion, 5); assert.equal(Object.hasOwn(manifest.metadata ?? {}, 'compatibilityMigration'), false);
	assert.ok(!manifest.configuration.generation.endsWith('-compat-v5'), 'ACCEPTANCE_PROVIDER_CUTOVER: Translated generation is not current authority');
	assert.ok(manifest.connections.length > 0, 'ACCEPTANCE_PROVIDER_CONNECTIONS: Original approved membership inventory required');
	assert.equal(new Set(manifest.connections.map(connection => connection.teamId)).size, manifest.connections.length,
		'ACCEPTANCE_PROVIDER_CONNECTIONS: Original one-connection-per-team authority duplicated');
	assert.equal(new Set(manifest.connections.map(connection => connection.membershipId)).size, manifest.connections.length,
		'ACCEPTANCE_PROVIDER_CONNECTIONS: Approved membership reused across runtime connections');
	assert.equal(new Set(manifest.connections.map(connection => connection.providerId)).size, 1,
		'ACCEPTANCE_PROVIDER_CONNECTIONS: One native global provider identity required across participating teams');
	for (const adapter of manifest.adapters) {
		capabilityAccountingLimitsSchema.parse(adapter.nativeLimits);
		assert.ok(adapter.offers.length > 0, 'ACCEPTANCE_PROVIDER_OFFERS: Actual installed supply cannot be empty');
		assert.equal(new Set(adapter.offers.map(binding => binding.offer.offerId)).size, adapter.offers.length,
			'ACCEPTANCE_PROVIDER_OFFERS: Installed offer identity is ambiguous');
		for (const binding of adapter.offers) {
			const offer = capabilityOfferSchema.parse(binding.offer), { offerDigest, ...material } = offer;
			assert.deepEqual(offer, binding.offer, 'ACCEPTANCE_PROVIDER_OFFERS: Installed offers must already be canonical, not repaired by parsing');
			assert.equal(capabilityOfferDigest(material), offerDigest, 'ACCEPTANCE_PROVIDER_OFFERS: Exact installed offer digest required');
		}
	}
	for (const item of f.items) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		const inventory = offerInventories.get(attempt.provider.providerId)!;
		assert.ok(Array.isArray(inventory.offers));
		const published = inventory.offers.map(row).filter(value => value.offerId === attempt.provider.offerId
			&& value.executionProviderId === attempt.provider.executionProviderId);
		assert.equal(published.length, 1, 'ACCEPTANCE_PROVIDER_OFFERS: Exact actual owning adapter and frozen offer required');
		const supply = capabilityOfferSchema.parse(published[0]!.offer);
		assert.equal(published[0]!.status, 'active', 'ACCEPTANCE_PROVIDER_OFFERS: Disabled or quarantined supply cannot prove the selected offer');
		for (const capability of attempt.requiredCapabilities) {
			const references = supply.capabilities.filter(value => value.id === capability); assert.equal(references.length, 1);
			const reference = references[0]!;
			const conformance = supply.conformance.filter(value => value.providerId === attempt.provider.providerId && value.capability.id === reference.id
				&& value.capability.version === reference.version && value.capability.digest === reference.digest);
			assert.equal(conformance.length, 1); assert.equal(conformance[0]!.status, 'passed');
			assert.ok(Date.parse(conformance[0]!.issuedAt) <= Date.parse(attempt.createdAt));
			if (conformance[0]!.expiresAt) assert.ok(Date.parse(conformance[0]!.expiresAt) > Date.parse(attempt.createdAt));
			const key = `${reference.id}@${reference.version}`;
			let declared = qualificationDefinitions.get(key);
			if (!declared) {
				declared = { id: reference.id, version: reference.version, value: read(['capabilities', 'show', reference.id, '--version', reference.version], f.team) };
				qualificationDefinitions.set(key, declared);
			}
			verifyProviderQualification(supply, declared.value, publicIdentity, attempt.provider.providerId, attempt.createdAt);
		}
		assert.ok(manifest.connections.some(connection => connection.providerId === attempt.provider.providerId && connection.teamId === attempt.teamId),
			'ACCEPTANCE_PROVIDER_CUTOVER: Actual run must belong to the configured current provider/team');
		assert.ok(manifest.connections.some(connection => connection.providerId === attempt.provider.providerId && connection.teamId === attempt.teamId
			&& connection.membershipId === item.membershipId), 'ACCEPTANCE_PROVIDER_MEMBERSHIP: Public execution belongs to another approved runtime connection');
		const adapters = manifest.adapters.filter(adapter => adapter.id === attempt.provider.executionProviderId);
		assert.equal(adapters.length, 1, 'ACCEPTANCE_PROVIDER_QUOTA: Exactly one actual configured adapter must own the frozen attempt');
		const adapter = adapters[0]!, limits = capabilityAccountingLimitsSchema.parse(adapter.nativeLimits);
		assert.equal(limits.modelConfigurationId, attempt.provider.modelConfigurationId, 'ACCEPTANCE_PROVIDER_QUOTA: Shared model scope changed');
		const capability = limits.capabilityLimits[attempt.provider.executionCapabilityId];
		assert.ok(capability, 'ACCEPTANCE_PROVIDER_QUOTA: Actual attempt lacks its configured capability quota');
		assert.ok(adapter.offers.some(binding => binding.offer.offerId === attempt.provider.offerId
			&& binding.offer.capabilities.some(value => value.id === attempt.provider.executionCapabilityId)),
			'ACCEPTANCE_PROVIDER_QUOTA: Frozen offer and capability are not the actual installed supply');
		assert.ok(attempt.limits.maximumSeconds <= limits.dailyActiveSecondsLimit
			&& attempt.limits.maximumSeconds <= capability.dailyActiveSecondsLimit,
			'ACCEPTANCE_PROVIDER_QUOTA: Zero or smaller installed quota cannot authorize the frozen maximum');
		if (capability.maximumAssignmentSeconds !== undefined) assert.ok(attempt.limits.maximumSeconds <= capability.maximumAssignmentSeconds,
			'ACCEPTANCE_PROVIDER_QUOTA: Frozen duration exceeds the explicit installed assignment maximum');
	}
	const entrypoint = resolve('dist/provider/lifecycle/entrypoint.js'), entrypointBytes = readFileSync(entrypoint);
	const output = execFileSync(process.execPath, [entrypoint, 'plan', '--json'], { env: process.env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4_194_304 });
	const plan = row(JSON.parse(output)); assert.equal(plan.ok, true); assert.equal(plan.mode, 'plan');
	assert.deepEqual(plan.capacity, manifest.capacity); assert.deepEqual(plan.adapters, manifest.adapters); assert.deepEqual(plan.lanes, manifest.lanes);
	assert.deepEqual((await loadProviderManifest(config.manifestPath, config.dataDir)).manifest, manifest);
	assert.deepEqual(readFileSync(loaded.path), manifestBytes); assert.deepEqual(readFileSync(entrypoint), entrypointBytes);
	for (const [providerId, inventory] of offerInventories) assert.deepEqual(read(['providers', 'offers', 'show', providerId], f.team), inventory);
	for (const declared of qualificationDefinitions.values()) assert.deepEqual(read(['capabilities', 'show', declared.id, '--version', declared.version], f.team), declared.value);
	assert.deepEqual((await loadCapacityProviderIdentity({ ref: manifest.identity.privateKeyRef, baseDirectory: loaded.directory,
		dataDirectory: config.dataDir, env: config.env })).publicJwk, identityBefore);
	verify(f); verifyGolden('stopped'); assert.deepEqual(actual(), before);
	// Current configured/package consumer readback only. No registry release,
	// source-to-selected-build proof, registered identity agreement or
	// independent qualification suite evidence, productive
	// model invocation or coordinated multi-package clean cutover is inferred.
});
