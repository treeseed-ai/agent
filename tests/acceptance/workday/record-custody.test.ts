import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProviderConfig, loadProviderManifest, loadCapacityProviderIdentity } from '@treeseed/agent/provider-governance';
import { assignmentAttemptSchema, assignmentResultSchema, capabilityAccountingLimitsSchema, remainingCapabilitySeconds, usageSettlementSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { capabilityOfferDigest, capabilityOfferSchema } from '@treeseed/sdk/capacity-provider';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { verifyPlatformRepository } from '@treeseed/sdk/platform';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';
import { readCompleteEvidence } from './support/evidence-pages.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody, verifyFailedExecutionCustody, verifyAvailabilityAccountingHistory, verifySandboxCloseoutCustody, verifyWorkdayContinuationCustody, verifySandboxHostAbsence, verifySandboxDirectoryAbsence, verifyProviderConformanceSignature, verifyProviderQualification, verifyProviderLocalSlotClosure, verifyProviderPollingSelection } from './support/record-custody.ts';
import { actual, verify, availabilityHistory } from './support/record-readback.ts';
import { verifyPublicSandboxAbsence } from './support/physical/sandbox-inventory.ts';

// Existing supported public reads, complete pages and SAME native managed run.
// No private route, canonical reconstruction, inferred charge, alternate runner
// or physical closure claim from SQL IDs. Physical/resource guarantees remain separate.
test('Every native managed attempt exposes one unchanged canonical lease reservation result and UsageSettlement across public views', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f);
	for (const item of f.items) assert.deepEqual(validateProviderAssignment(item), { ok: true, diagnostics: [] },
		'ACCEPTANCE_CANONICAL_PUBLIC: Exact operational identities and canonical snapshots must agree without repair');
	const settlements = publicCanonicalRecords(f.views, 'treeseed.usage-settlement/v1');
	assert.equal(settlements.length, f.items.length, 'ACCEPTANCE_NATIVE_UNITS: One actual stored settlement per attempt required');
	for (const settlement of settlements) {
		assert.deepEqual(usageSettlementSchema.parse(settlement), settlement, 'ACCEPTANCE_SETTLEMENT_RAW: Stored canonical authority must not be normalized');
		const native = row(settlement.nativeUsage);
		assert.ok(settlement.nativeUsage && typeof settlement.nativeUsage === 'object' && !Array.isArray(settlement.nativeUsage));
		assert.ok(!Object.hasOwn(native, 'provenance'), 'ACCEPTANCE_NATIVE_UNITS: Diagnostic provenance is not a native measurement');
		for (const value of Object.values(native)) assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0,
			'ACCEPTANCE_NATIVE_UNITS: Original numeric units must remain uncoerced');
		const aggregate = f.measurements.filter(value => value.assignmentId === settlement.assignmentId && value.accountingMode === 'aggregate');
		assert.equal(aggregate.length, 1); assert.deepEqual(aggregate[0]!.nativeUsage, native);
		for (const field of ['activeSeconds', 'elapsedSeconds'] as const) if (Object.hasOwn(native, field)) {
			assert.equal(native[field], aggregate[0]![field],
				'ACCEPTANCE_NATIVE_SECONDS: Repeated terminal seconds must agree without charging infrastructure as active work');
		}
	}
	verify(f); verifyGolden('settlement'); verifyGolden('reporter'); assert.deepEqual(f, before); assert.deepEqual(actual(), before);
});
test('Actual managed continuation reads its complete original settled ancestry and retains exact prior source Decision result and charge history without expanding custody', { timeout: 120_000 }, () => {
	const lineage: Array<ReturnType<typeof actual>> = [], seen = new Set<string>(); let id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	while (id) {
		assert.ok(!seen.has(id) && seen.size < 64, 'ACCEPTANCE_CONTINUATION_CYCLE: Original complete bounded ancestry required'); seen.add(id);
		const observed = actual(id); lineage.push(observed); const parameters = row(observed.run.parameters);
		if (!Object.hasOwn(parameters, 'continueFromWorkdayId')) break;
		assert.ok(typeof parameters.continueFromWorkdayId === 'string' && parameters.continueFromWorkdayId.trim(), 'ACCEPTANCE_CONTINUATION_PARENT: Malformed ancestry cannot become a fresh root');
		id = parameters.continueFromWorkdayId;
	}
	assert.ok(lineage.length >= 2, 'ACCEPTANCE_CONTINUATION_EMPTY: Actual continuation required; ordinary golden run is not a substitute');
	const before = structuredClone(lineage); verifyWorkdayContinuationCustody(lineage.map(value => value.run), lineage.flatMap(value => value.items));
	for (const observed of lineage) verify(observed);
	assert.deepEqual(lineage, before); assert.deepEqual(lineage.map(value => actual(value.id)), before); verifyGolden('stopped');
	// Existing public Workday/assignment/usage/ledger readers only. This does not
	// prove a model's before-deadline proposal, governance votes, physical closure,
	// or provider-generated charge provenance from record agreement alone.
});
test('Actual managed continuation retains a returned ancestor with its exact released lease failed history and settled charge instead of a completed replacement', { timeout: 120_000 }, () => {
	const lineage: Array<ReturnType<typeof actual>> = [], seen = new Set<string>(); let id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	while (id) {
		assert.ok(!seen.has(id) && seen.size < 64, 'ACCEPTANCE_CONTINUATION_CYCLE: Complete original ancestry required'); seen.add(id);
		const observed = actual(id); lineage.push(observed); const parameters = row(observed.run.parameters);
		if (!Object.hasOwn(parameters, 'continueFromWorkdayId')) break;
		assert.ok(typeof parameters.continueFromWorkdayId === 'string' && parameters.continueFromWorkdayId.trim()); id = parameters.continueFromWorkdayId;
	}
	assert.ok(lineage.length >= 2, 'ACCEPTANCE_CONTINUATION_EMPTY: Actual continued workday required');
	const before = structuredClone(lineage), ancestors = lineage.slice(1), returned = ancestors.flatMap(value => value.items).filter(item => item.status === 'returned');
	assert.ok(returned.length > 0, 'ACCEPTANCE_CONTINUATION_RETURNED: A genuine retained returned ancestor is required');
	verifyWorkdayContinuationCustody(lineage.map(value => value.run), lineage.flatMap(value => value.items));
	for (const observed of lineage) verify(observed);
	for (const item of returned) {
		assert.equal(item.leaseState, 'released'); assert.equal(item.completedAt, null);
		assert.ok(typeof item.returnedAt === 'string' && Number.isFinite(Date.parse(item.returnedAt)));
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), owner = ancestors.find(value => value.id === attempt.workdayId);
		assert.ok(owner); const leases = publicCanonicalRecords(owner.views, 'treeseed.lease/v1'), settlements = publicCanonicalRecords(owner.views, 'treeseed.usage-settlement/v1');
		assert.equal(leases.filter(value => value.assignmentId === item.id && value.state === 'released').length, 1);
		assert.equal(settlements.filter(value => value.assignmentId === item.id && value.reservationId === attempt.reservationId).length, 1);
		if (item.assignmentResult !== null && item.assignmentResult !== undefined) {
			const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.assignmentId, item.id); assert.notEqual(result.status, 'completed');
		}
	}
	assert.deepEqual(lineage, before); assert.deepEqual(lineage.map(value => actual(value.id)), before); verifyGolden('stopped');
});
test('Actual completed and failed isolated attempts retain distinct verified public closeout beside unchanged candidates results and terminal charges', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f), isolated = f.items.filter(item => Object.hasOwn(row(item.lifecycleOutput), 'sandboxId'));
	for (const item of f.items) assert.notEqual(item.lifecycleCode, 'assignment_timeout',
		'ACCEPTANCE_FATAL_TIMEOUT: Unexpected managed agent expiry is a fatal architecture defect, not passing failed-path coverage');
	assert.ok(isolated.some(item => item.status === 'completed'), 'ACCEPTANCE_SANDBOX_COMPLETED: Actual completed isolated execution required');
	assert.ok(isolated.some(item => ['failed', 'returned', 'cancelled', 'expired'].includes(String(item.status))),
		'ACCEPTANCE_SANDBOX_FAILURE: Actual interrupted or failed isolated execution required');
	verifySandboxCloseoutCustody(f.items); verify(f); verifyGolden('stopped');
	assert.deepEqual(f, before); const again = actual(); verifySandboxCloseoutCustody(again.items); assert.deepEqual(again, before);
	// This independently reads original public custody, not container/process/
	// filesystem absence. Native broker/Kata physical closure remains separate.
});
test('Actual normal SDK workday reads complete public owning host sandbox absence while retaining unrelated resources and original settled history', { timeout: 120_000 }, async () => {
 const deadline = performance.now() + 120_000, f = actual(), before = structuredClone(f);
 assert.equal(f.run.status, 'completed');
 const isolated = f.items.filter(item => Object.hasOwn(row(item.lifecycleOutput), 'sandboxId'));
 assert.ok(isolated.length > 0 && isolated.every(item => item.status === 'completed'),
  'ACCEPTANCE_SANDBOX_NORMAL: Completed normal workday required; controlled failures belong to their separate case');
 const config = resolveProviderConfig({ requireConnection: true }); assert.ok(config.manifestPath);
 const loaded = await loadProviderManifest(config.manifestPath, config.dataDir), manifestBefore = structuredClone(loaded.manifest);
 const inspect = () => {
  const remaining = Math.floor(deadline - performance.now() - 5_000); assert.ok(remaining > 0, 'ACCEPTANCE_SANDBOX_OBSERVATION_TIME: Original case deadline exhausted');
  return verifyPublicSandboxAbsence(f.items, loaded.manifest.connections, loaded.manifest.sandbox.brokerSocket,
   read(['host', 'sandbox', 'status'], '', true, remaining));
 };
 const paths = inspect(); verify(f); assert.deepEqual(inspect(), paths); assert.deepEqual(f, before);
 assert.deepEqual((await loadProviderManifest(config.manifestPath, config.dataDir)).manifest, manifestBefore);
 // Exact represented sandboxes only. Warm VMs, NBD, source jobs, sessions and
 // complete producer inventory remain independent obligations, not inferred absence.
});
test('Actual owning host independently reads native task container mount and directory absence for completed and failed managed sandboxes without erasing history', { timeout: 120_000 }, async () => {
	const f = actual(), before = structuredClone(f), config = resolveProviderConfig({ requireConnection: true });
	assert.ok(config.manifestPath); const loaded = await loadProviderManifest(config.manifestPath, config.dataDir);
	const manifestBefore = structuredClone(loaded.manifest), configurationPath = '/etc/treeseed/sandbox/broker.json';
	const bytes = readFileSync(configurationPath), broker = row(JSON.parse(bytes.toString('utf8')));
	assert.equal(broker.socketPath, loaded.manifest.sandbox.brokerSocket); assert.equal(broker.namespace, 'treeseed-sandboxes'); assert.equal(broker.runtime, 'io.containerd.kata.v2');
	assert.ok(typeof broker.containerdAddress === 'string' && broker.containerdAddress.startsWith('/run/'));
	assert.ok(typeof broker.stateRoot === 'string' && broker.stateRoot.startsWith('/var/lib/treeseed/sandboxes'));
	const address = broker.containerdAddress, stateRoot = broker.stateRoot;
	assert.ok(lstatSync(stateRoot).isDirectory(), 'ACCEPTANCE_SANDBOX_ROOT: Readable actual directory required, not a symlink or guessed absent root');
	assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'), 'ACCEPTANCE_SANDBOX_HOST: Acceptance must inspect the owning host mount namespace');
	const isolated = f.items.filter(item => Object.hasOwn(row(item.lifecycleOutput), 'sandboxId'));
	assert.ok(isolated.some(item => item.status === 'completed') && isolated.some(item => ['failed', 'returned', 'cancelled', 'expired'].includes(String(item.status))),
		'ACCEPTANCE_SANDBOX_EMPTY: Actual completed and interrupted or failed isolation required');
	const inspect = () => {
		const inventory = (kind: 'tasks' | 'containers') => execFileSync('/usr/bin/ctr', ['--address', address,
			'--namespace', 'treeseed-sandboxes', kind, 'list', '--quiet'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
				env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
		const paths = verifySandboxHostAbsence(f.items, loaded.manifest.connections, stateRoot, inventory('tasks'), inventory('containers'), readFileSync('/proc/1/mountinfo', 'utf8'));
		verifySandboxDirectoryAbsence(paths); return paths;
	};
	const paths = inspect(); verify(f); verifyGolden('stopped'); assert.deepEqual(inspect(), paths); assert.deepEqual(actual(), before);
	assert.deepEqual((await loadProviderManifest(config.manifestPath, config.dataDir)).manifest, manifestBefore); assert.deepEqual(readFileSync(configurationPath), bytes);
	// Only recorded execution IDs on the same configured provider/team host.
	// No broker startup/reconcile, deletion, inferred borrowed warm/source IDs,
	// remote-host fallback or claim of all descendant namespaces/session closure.
});
test('Actual owning provider host reads retained completed and failed local slot closure without recovery mutation or replacing public charges', { timeout: 120_000 }, async () => {
	const f = actual(), before = structuredClone(f), config = resolveProviderConfig({ requireConnection: true });
	assert.ok(config.manifestPath); const loaded = await loadProviderManifest(config.manifestPath, config.dataDir);
	const manifest = structuredClone(loaded.manifest), manifestBytes = readFileSync(loaded.path);
	const items = f.items.filter(item => typeof row(row(row(item.capacityEnvelope).budget).time).executionStartedAt === 'string'
		&& row(row(item.assignmentAttempt).effectiveProfile).handler !== 'reporter');
	assert.ok(items.some(item => item.status === 'completed') && items.some(item => ['failed', 'returned', 'cancelled', 'expired'].includes(String(item.status))),
		'ACCEPTANCE_PROVIDER_LOCAL_EMPTY: Actual completed and failed productive managed executions required');
	assert.equal(readlinkSync('/proc/self/ns/mnt'), readlinkSync('/proc/1/ns/mnt'), 'ACCEPTANCE_PROVIDER_LOCAL_HOST: Original owning host namespace required');
	const path = resolve(config.dataDir, 'runtime', 'capacity-state.json');
	const inspect = () => {
		const info = lstatSync(path);
		assert.ok(info.isFile() && (info.mode & 0o077) === 0 && info.nlink === 1, 'ACCEPTANCE_PROVIDER_LOCAL_FILE: Original private regular state file required');
		assert.equal(realpathSync(path), path, 'ACCEPTANCE_PROVIDER_LOCAL_FILE: No redirected host authority');
		// Raw state contains encrypted-account metadata/token custody. Never
		// include those bytes or parsed fields in assertion error output.
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8')), state = row(raw);
		return { revision: state.revision, proof: verifyProviderLocalSlotClosure(items, loaded.manifest.connections, raw) };
	};
	const first = inspect(); verify(f); verifyGolden('stopped'); const second = inspect();
	assert.deepEqual(second.proof, first.proof, 'ACCEPTANCE_PROVIDER_LOCAL_HISTORY: Terminal observations changed or bounded history disappeared');
	assert.ok(typeof second.revision === 'number' && typeof first.revision === 'number' && second.revision >= first.revision,
		'ACCEPTANCE_PROVIDER_LOCAL_REVISION: Legitimate unrelated polling cannot move durable state backward');
	assert.deepEqual(actual(), before); assert.deepEqual((await loadProviderManifest(config.manifestPath, config.dataDir)).manifest, manifest);
	assert.ok(readFileSync(loaded.path).equals(manifestBytes));
	// No snapshot, recovery, finalize, session close or provider stop is called.
	// Other teams' polling slots/tokens/open availability are legitimate. Local
	// slot closure is NOT all-session absence or exact external model billing.
});
test('Actual participating provider availability retains closed accounting history and monotonic exact public observations beside unchanged terminal attempt charges', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f), attempts = f.items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt));
	const providers = new Set(attempts.map(attempt => attempt.provider.providerId)), teamIds = new Set(attempts.map(attempt => attempt.teamId));
	assert.equal(teamIds.size, 1); const teamId = attempts[0]!.teamId;
	const all = availabilityHistory(f.team), participating = all.filter(session => typeof session.providerId === 'string' && providers.has(session.providerId));
	assert.ok(participating.some(session => session.status === 'closed'), 'ACCEPTANCE_AVAILABILITY_CLOSED: Actual retained closed publication required');
	verifyAvailabilityAccountingHistory(participating, providers, teamId);
	for (const session of participating) {
		const ids = row(session.snapshot).activeAssignmentIds;
		assert.ok(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0)
			&& new Set(ids).size === ids.length, 'ACCEPTANCE_AVAILABILITY_ASSIGNMENTS: Exact unique assignment inventory required');
		for (const id of ids) {
			const item = read(['assignments', 'show', id], f.team), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
			assert.equal(item.id, id); assert.equal(attempt.id, id); assert.equal(attempt.teamId, session.teamId);
			assert.equal(attempt.provider.providerId, session.providerId); assert.equal(item.membershipId, session.membershipId);
			assert.ok(Date.parse(attempt.createdAt) <= Date.parse(String(session.refreshedAt)),
				'ACCEPTANCE_AVAILABILITY_ASSIGNMENTS: Future assignment cannot be retained publication authority');
		}
		// A retained recovery claim may outlive remote completion until local
		// terminal confirmation. Latest session snapshots do not prove every
		// historical active set; native producer tests cover that publication.
		const adapters = row(session.snapshot).adapters; assert.ok(Array.isArray(adapters) && adapters.length > 0);
		const offerIds = new Set<string>();
		for (const adapter of adapters.map(row)) {
			assert.ok(typeof adapter.runtimeBuild === 'string' && /^sha256:[a-f0-9]{64}$/u.test(adapter.runtimeBuild),
				'ACCEPTANCE_AVAILABILITY_BUILD: Exact retained runtime build required');
			assert.ok(Array.isArray(adapter.offers) && adapter.offers.length > 0,
				'ACCEPTANCE_AVAILABILITY_OFFERS: Public readback must retain every executable offer');
			for (const raw of adapter.offers) {
				const offer = capabilityOfferSchema.parse(raw);
				assert.deepEqual(offer, raw, 'ACCEPTANCE_AVAILABILITY_OFFER_RAW: Retained authority cannot be normalized');
				assert.ok(!offerIds.has(offer.offerId), 'ACCEPTANCE_AVAILABILITY_OFFER_ID: Provider-global offer identities must remain unique within publication');
				offerIds.add(offer.offerId);
				const { offerDigest, ...material } = offer;
				assert.equal(capabilityOfferDigest(material), offerDigest, 'ACCEPTANCE_AVAILABILITY_OFFER_DIGEST: Whole retained offer bytes must agree');
			}
			const limits = capabilityAccountingLimitsSchema.parse(adapter.nativeLimits), report = row(adapter.accountingObservation);
			const scopes = [[limits.dailyActiveSecondsLimit, report.modelUsage], ...Object.entries(limits.capabilityLimits)
				.map(([id, bound]) => [bound.dailyActiveSecondsLimit, row(report.capabilityUsage)[id]])];
			for (const [ceiling, raw] of scopes) {
				const observation = row(raw);
				assert.ok(typeof ceiling === 'number' && typeof observation.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(observation.day));
				assert.ok(typeof observation.observedAt === 'string' && Number.isFinite(Date.parse(observation.observedAt))
					&& new Date(observation.observedAt).toISOString().slice(0, 10) === observation.day, 'ACCEPTANCE_AVAILABILITY_DAY: Retained day and clock must agree');
				assert.ok(typeof observation.healthy === 'boolean' && typeof observation.activeSeconds === 'number'
					&& Number.isFinite(observation.activeSeconds) && observation.activeSeconds >= 0 && typeof observation.reservedSeconds === 'number'
					&& Number.isFinite(observation.reservedSeconds) && observation.reservedSeconds >= 0, 'ACCEPTANCE_AVAILABILITY_RETAINED: Every retained native observation must remain valid');
				const exact = { day: observation.day, observedAt: observation.observedAt, healthy: observation.healthy,
					activeSeconds: observation.activeSeconds, reservedSeconds: observation.reservedSeconds };
				const checked = remainingCapabilitySeconds({ now: exact.observedAt, maximumObservationAgeSeconds: 90,
					dailyLimitSeconds: ceiling, observation: exact, previousObservation: exact, ledgerActiveSeconds: 0, ledgerReservedSeconds: 0 });
				assert.equal(checked.reason, exact.healthy ? 'accounted' : 'unhealthy');
			}
		}
	}
	const next = availabilityHistory(f.team), nextParticipating = next.filter(session => typeof session.providerId === 'string' && providers.has(session.providerId));
	verifyAvailabilityAccountingHistory(nextParticipating, providers, teamId);
	for (const session of participating) {
		const retained = nextParticipating.filter(value => value.id === session.id); assert.equal(retained.length, 1);
		for (const field of ['id', 'membershipId', 'providerId', 'teamId', 'openedAt']) assert.equal(retained[0]![field], session[field]);
		if (session.status === 'closed' || session.status === 'expired') assert.deepEqual(retained[0], session, 'ACCEPTANCE_AVAILABILITY_HISTORY: Terminal publication history changed');
		else {
			assert.ok(Number(retained[0]!.sequence) >= Number(session.sequence), 'ACCEPTANCE_AVAILABILITY_SEQUENCE: Live renewal cannot reset sequence');
			const originalAdapters = row(session.snapshot).adapters, currentAdapters = row(retained[0]!.snapshot).adapters;
			assert.ok(Array.isArray(originalAdapters) && Array.isArray(currentAdapters));
			for (const original of originalAdapters.map(row)) {
				const limits = row(original.nativeLimits), accounting = row(original.accountingObservation);
				const matches = currentAdapters.map(row).filter(adapter => row(adapter.nativeLimits).modelConfigurationId === limits.modelConfigurationId);
				assert.ok(matches.length > 0, 'ACCEPTANCE_AVAILABILITY_HISTORY: Live publication cannot discard its shared model history');
				for (const current of matches) {
					const observed = row(current.accountingObservation), scopes = [['model', accounting.modelUsage, observed.modelUsage],
						...Object.keys(row(limits.capabilityLimits)).map(id => [id, row(accounting.capabilityUsage)[id], row(observed.capabilityUsage)[id]])];
					for (const [, pastValue, presentValue] of scopes) {
						const past = row(pastValue), present = row(presentValue);
						assert.ok(Date.parse(String(present.observedAt)) >= Date.parse(String(past.observedAt)), 'ACCEPTANCE_AVAILABILITY_MONOTONIC: Live report moved backward');
						if (present.day === past.day) assert.ok(typeof present.activeSeconds === 'number' && present.activeSeconds >= Number(past.activeSeconds),
							'ACCEPTANCE_AVAILABILITY_MONOTONIC: Live refresh reset measured usage');
					}
				}
			}
		}
	}
	verify(f); verifyGolden('stopped'); assert.deepEqual(f, before);
	// Complete readable team history is not an independently complete global
	// provider inventory. Renewing open sessions are legitimate mutations; no
	// external charge or physical restart is inferred from retained SQL rows.
});
test('Native failed controlled attempts retain their own canonical settlement and original frozen authority on repeated public readback', { timeout: 120_000 }, () => {
	const f = actual(); assert.ok(f.items.some(item => ['failed', 'returned', 'expired', 'cancelled'].includes(String(item.status))), 'ACCEPTANCE_CANONICAL_FAILURE: Actual controlled failed attempt required');
	for (const item of f.items.filter(item => item.status === 'cancelled')) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(item.completedAt, null, 'ACCEPTANCE_CANCELLATION_HISTORY: Cancellation cannot become completed execution');
		const aggregate = f.measurements.filter(value => value.assignmentId === item.id && value.assignmentAttempt === attempt.attempt && value.accountingMode === 'aggregate');
		assert.equal(aggregate.length, 1, 'ACCEPTANCE_CANCELLATION_USAGE: Cancellation requires its original exactly-once terminal measurement');
		assert.ok(typeof aggregate[0]!.activeSeconds === 'number' && Number.isFinite(aggregate[0]!.activeSeconds)
			&& typeof aggregate[0]!.elapsedSeconds === 'number' && Number.isFinite(aggregate[0]!.elapsedSeconds));
	}
	verify(f); verifyGolden('stopped');
});
test('Actual failed productive execution retains owning closeout and unchanged informational native usage beside exactly one terminal charge', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f);
	verifyFailedExecutionCustody(f.items, f.measurements);
	verify(f); verifyGolden('stopped');
	assert.deepEqual(f, before); assert.deepEqual(actual(), before);
});
test('Actual tool proxy failure retains its public cause verified closeout and one unchanged terminal charge without a passing replay', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f);
	const failures = f.items.filter(item => item.lifecycleCode === 'assignment_tool_proxy_failed');
	assert.ok(failures.length > 0, 'ACCEPTANCE_TOOL_FAILURE_EMPTY: Actual controlled tool-proxy failure required');
	for (const item of failures) {
		assert.equal(item.status, 'failed'); assert.equal(typeof item.lifecycleReason, 'string'); assert.ok(String(item.lifecycleReason).trim());
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); assert.equal(attempt.status, 'failed');
		assert.equal(item.id, attempt.id); assert.ok(item.failedAt); assert.equal(item.completedAt, null);
		if (item.assignmentResult !== null && item.assignmentResult !== undefined) {
			const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.status, 'failed'); assert.equal(result.assignmentId, attempt.id);
		}
	}
	verifyFailedExecutionCustody(f.items, f.measurements); verify(f); verifyGolden('stopped');
	assert.deepEqual(f, before); assert.deepEqual(actual(), before);
	// Requires actual failed managed execution, not seeded failure, a controlled
	// transport response, inferred physical absence, or a completed golden run.
});
test('Actual model timing refusal remains returned with its exact failed history closeout and terminal charge rather than a completed replay', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f);
	const refused = f.items.filter(item => item.lifecycleCode === 'assignment_timing_awareness_missing');
	assert.ok(refused.length > 0, 'ACCEPTANCE_TIMING_REFUSAL_EMPTY: Actual managed timing refusal required');
	for (const item of refused) {
		assert.equal(item.status, 'returned'); assert.equal(item.completedAt, null);
		assert.ok(typeof item.lifecycleReason === 'string' && item.lifecycleReason.trim());
		assert.ok(typeof item.returnedAt === 'string' && Number.isFinite(Date.parse(item.returnedAt)));
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); assert.equal(item.id, attempt.id);
		if (item.assignmentResult !== null && item.assignmentResult !== undefined) {
			const result = assignmentResultSchema.parse(item.assignmentResult);
			assert.equal(result.assignmentId, attempt.id); assert.notEqual(result.status, 'completed');
		}
		assert.equal(f.items.filter(other => other.id === item.id).length, 1);
	}
	verifyFailedExecutionCustody(f.items, f.measurements); verify(f); verifyGolden('stopped');
	assert.deepEqual(f, before); assert.deepEqual(actual(), before);
	// Public refusal and accounting custody do not establish actual clock
	// readings, scope adaptation, accepted continuation, or physical absence.
});
test('Native terminal accounting retains exactly the represented aggregate inventory and validates actual failed results and owning lifecycle clocks', { timeout: 120_000 }, () => {
	const f = actual(), immutable = structuredClone(f);
	verify(f);
	const attempts = f.items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt));
	const ids = new Set(attempts.map(attempt => attempt.id));
	assert.equal(ids.size, attempts.length);
	assert.equal(new Set(f.measurements.map(measurement => measurement.id)).size, f.measurements.length,
		'ACCEPTANCE_CANONICAL_MEASURED: Public usage identities cannot be reused across attempts');
	const aggregate = f.measurements.filter(measurement => measurement.accountingMode === 'aggregate');
	assert.equal(aggregate.length, attempts.length, 'ACCEPTANCE_CANONICAL_MEASURED: No orphan or second aggregate may be hidden beside matching charges');
	for (const measurement of aggregate) assert.ok(ids.has(String(measurement.assignmentId)), 'ACCEPTANCE_CANONICAL_MEASURED: Aggregate has no represented immutable attempt');
	const productive = f.items.filter(item => typeof row(row(row(item.capacityEnvelope).budget).time).executionStartedAt === 'string'
		&& row(row(item.assignmentAttempt).effectiveProfile).handler !== 'reporter');
	assert.ok(productive.some(item => item.status === 'completed'), 'ACCEPTANCE_NATIVE_USAGE: Actual completed productive model execution required');
	assert.ok(productive.some(item => ['failed', 'returned'].includes(String(item.status))), 'ACCEPTANCE_NATIVE_USAGE: Actual failed or returned productive model execution required');
	for (const item of productive) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		const diagnostic = f.measurements.filter(value => value.assignmentId === attempt.id && value.accountingMode === 'informational'
			&& value.usageDimension === 'diagnostic-0'), charged = aggregate.filter(value => value.assignmentId === attempt.id);
		assert.equal(diagnostic.length, 1, 'ACCEPTANCE_NATIVE_USAGE: First executor observation must survive successful as well as failed closeout');
		assert.equal(charged.length, 1);
		assert.equal(diagnostic[0]!.activeSeconds, 0); assert.equal(diagnostic[0]!.elapsedSeconds, 0);
		for (const measurement of [diagnostic[0]!, charged[0]!]) {
			assert.equal(measurement.assignmentAttempt, attempt.attempt); assert.equal(measurement.capacityProviderId, attempt.provider.providerId);
			assert.equal(measurement.projectId, attempt.projectId); assert.equal(measurement.workDayId, attempt.workdayId);
		}
		assert.notEqual(diagnostic[0]!.id, charged[0]!.id); assert.notEqual(diagnostic[0]!.idempotencyKey, charged[0]!.idempotencyKey);
		assert.deepEqual(diagnostic[0]!.nativeUsage, charged[0]!.nativeUsage, 'ACCEPTANCE_NATIVE_USAGE: Success or failure classification changed the native counters');
		for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']) assert.equal(diagnostic[0]![field], charged[0]![field]);
	}
	const results = f.items.filter(item => item.assignmentResult !== null && item.assignmentResult !== undefined)
		.map(item => ({ attempt: assignmentAttemptSchema.parse(item.assignmentAttempt), result: assignmentResultSchema.parse(item.assignmentResult) }));
	assert.ok(results.some(({ attempt, result }) => attempt.status === 'failed' && result.status === 'failed'),
		'ACCEPTANCE_CANONICAL_FAILURE: An actual failed handler result is required, not a fabricated result or only an expired row');
	assert.equal(new Set(results.map(({ result }) => result.id)).size, results.length, 'ACCEPTANCE_CANONICAL_RESULT: Result identity reused across attempts');
	for (const { attempt, result } of results) {
		assert.equal(result.assignmentId, attempt.id);
		if (['completed', 'blocked', 'failed'].includes(attempt.status)) assert.equal(result.status, attempt.status);
		const measured = aggregate.filter(measurement => measurement.assignmentId === attempt.id);
		assert.equal(measured.length, 1);
		assert.equal(result.usage.elapsedSeconds, measured[0]!.elapsedSeconds);
		assert.deepEqual(result.usage.native, measured[0]!.nativeUsage);
		const completed = Date.parse(result.completedAt);
		assert.ok(Number.isFinite(completed) && completed >= Date.parse(attempt.startedAt ?? attempt.createdAt));
		if (attempt.finishedAt) assert.ok(completed <= Date.parse(attempt.finishedAt), 'ACCEPTANCE_CANONICAL_CLOCK: Result outside its recorded execution interval');
	}
	for (const lease of publicCanonicalRecords(f.views, 'treeseed.lease/v1')) {
		if (lease.releasedAt !== undefined) assert.ok(Date.parse(String(lease.releasedAt)) >= Date.parse(String(lease.acquiredAt)), 'ACCEPTANCE_CANONICAL_CLOCK: Release preceded its acquisition');
	}
	for (const reservation of publicCanonicalRecords(f.views, 'treeseed.reservation/v1')) {
		if (reservation.closedAt !== undefined) assert.ok(Date.parse(String(reservation.closedAt)) >= Date.parse(String(reservation.reservedAt)), 'ACCEPTANCE_CANONICAL_CLOCK: Closure preceded its reservation');
	}
	// The real provider settles before completion. Recorded lifecycle clocks do
	// not imply physical commit ordering, external charge provenance or teardown.
	assert.deepEqual(f, immutable);
	const again = actual();
	assert.deepEqual(again, f);
	verifyGolden('stopped');
});
