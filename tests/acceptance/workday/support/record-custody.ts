import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assignmentAttemptSchema, assignmentResultSchema, capabilityAccountingLimitsSchema, usageSettlementSchema } from '@treeseed/sdk/agent-capacity';
import { capabilityConformanceSchema, capabilityDefinitionSchema, capabilityDefinitionDigest, capabilityOfferSchema } from '@treeseed/sdk/capacity-provider';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { row, type Row } from '../../acceptance-cli.ts';
import { orderConnectionsForFairPolling } from '../../../../src/provider/teams/multi-team-runtime.ts';
import { assertCanonicalRecordShapes } from './canonical-record-shape.ts';
import { readCompleteEvidence } from './evidence-pages.ts';

export function verifyReportRecordCustody(snapshot: Row, reporter: Row, assignments: Row[], team: string): void {
	assert.ok(Array.isArray(snapshot.attempts), 'ACCEPTANCE_REPORT_ATTEMPTS: Complete original assignment collection required');
	const observed = snapshot.attempts.map(value => { const attempt = row(value), result = typeof attempt.assignment_result_json === 'string' ? JSON.parse(attempt.assignment_result_json) : attempt.assignment_result_json;
		if (result !== null && result !== undefined) assert.deepEqual(assignmentResultSchema.parse(result), result); return { id: attempt.id, status: attempt.status, result: result ?? null }; });
	const original = assignments.filter(value => value.id !== reporter.id).map(value => ({ id: value.id, status: value.status, result: value.assignmentResult ?? null }));
	const byId = (left: { id: unknown }, right: { id: unknown }) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0;
	assert.deepEqual(observed.sort(byId), original.sort(byId), 'ACCEPTANCE_REPORT_ATTEMPTS: Every original attempt status and canonical result must be retained');
	assert.ok(Array.isArray(snapshot.settlements), 'ACCEPTANCE_REPORT_SETTLEMENTS: Complete canonical collection required');
	const represented = snapshot.settlements.map(value => {
		const parsed = usageSettlementSchema.parse(value); assert.deepEqual(parsed, value); return parsed;
	});
	assert.equal(new Set(represented.map(value => value.id)).size, represented.length, 'ACCEPTANCE_REPORT_SETTLEMENTS: Duplicate identity');
	const expected: typeof represented = [], assignmentIds = new Set(assignments.map(value => value.id));
	for (const projectId of new Set(assignments.map(value => String(value.projectId)))) {
		const args = ['capacity', 'ledger', '--project', projectId, '--workday', String(reporter.workDayId)];
		const ledger = readCompleteEvidence(args, team, 100, 'ACCEPTANCE_REPORT_LEDGER');
		assert.deepEqual(readCompleteEvidence(args, team, 100, 'ACCEPTANCE_REPORT_LEDGER'), ledger, 'ACCEPTANCE_REPORT_LEDGER_IMMUTABLE');
		for (const entry of ledger.filter(value => value.phase === 'task_completed_actual_settlement' && value.assignmentId !== reporter.id)) {
			const value = usageSettlementSchema.parse(entry.usageSettlement); assert.deepEqual(value, entry.usageSettlement);
			assert.ok(assignmentIds.has(value.assignmentId) && value.assignmentId === entry.assignmentId && value.id === entry.id
				&& value.teamId === snapshot.teamId && value.workdayId === reporter.workDayId && value.projectId === projectId
				&& value.settledAt === entry.createdAt, 'ACCEPTANCE_REPORT_SETTLEMENTS: Exact ledger and workday authority required');
			expected.push(value);
		}
	}
	assert.equal(expected.length, assignmentIds.size - 1, 'ACCEPTANCE_REPORT_SETTLEMENTS: Every pre-Reporter attempt requires its own settlement');
	assert.equal(new Set(expected.map(value => value.assignmentId)).size, expected.length,
		'ACCEPTANCE_REPORT_SETTLEMENTS: One attempt cannot substitute for another missing settlement');
	const order = (left: (typeof represented)[number], right: (typeof represented)[number]) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
	assert.deepEqual([...represented].sort(order), expected.sort(order), 'ACCEPTANCE_REPORT_SETTLEMENTS: Every original predecessor settlement must be retained');
}

/** Signature custody only: a signed status/evidence digest is not independent
 * evidence that a qualification suite actually ran or passed. */
export function verifyProviderConformanceSignature(value: unknown, publicIdentity: unknown, providerId: string): void {
	const receipt = capabilityConformanceSchema.parse(value), identity = row(publicIdentity);
	assert.deepEqual(receipt, value, 'ACCEPTANCE_CONFORMANCE_RAW: Receipt must already be canonical');
	assert.ok(providerId && providerId === providerId.trim());
	assert.equal(receipt.providerId, providerId, 'ACCEPTANCE_CONFORMANCE_PROVIDER: Exact advertised provider required');
	assert.equal(identity.kty, 'OKP'); assert.equal(identity.crv, 'Ed25519');
	assert.ok(typeof identity.x === 'string' && identity.x && !Object.hasOwn(identity, 'd'), 'ACCEPTANCE_CONFORMANCE_KEY: Public Ed25519 identity required');
	assert.equal(receipt.signature.keyId, `provider-${createHash('sha256').update(identity.x).digest('hex').slice(0, 16)}`,
		'ACCEPTANCE_CONFORMANCE_KEY: Receipt must use the original host identity');
	const signature = Buffer.from(receipt.signature.value, 'base64url');
	assert.ok(signature.length === 64 && signature.toString('base64url') === receipt.signature.value,
		'ACCEPTANCE_CONFORMANCE_SIGNATURE: Exact native Ed25519 signature bytes required');
	const unsigned = { ...receipt, signature: { ...receipt.signature, value: '' } };
	const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: identity.x }, format: 'jwk' });
	// The SDK serializer is independent of the publisher's local serializer;
	// these strict conformance objects have only their declared ASCII keys.
	assert.ok(verify(null, Buffer.from(canonicalStandardsJson(unsigned)), key, signature),
		'ACCEPTANCE_CONFORMANCE_SIGNATURE: Native signature does not bind the unchanged whole receipt');
}

/** The declared tier, exact receipt and clock are independently readable.
 * Suite identity/digest custody does NOT establish actual suite execution. */
export function verifyProviderQualification(value: unknown, definitionValue: unknown, publicIdentity: unknown, providerId: string, admittedAt: string): void {
	const offer = capabilityOfferSchema.parse(value);
	assert.deepEqual(offer, value);
	const definitions = Array.isArray(definitionValue) ? definitionValue : [definitionValue];
	assert.ok(definitions.length > 0, 'ACCEPTANCE_QUALIFICATION_DEFINITION: Nonempty declared ontology required');
	if (Array.isArray(definitionValue)) {
		const references = definitions.map(value => {
			const definition = capabilityDefinitionSchema.parse(value);
			return { id: definition.id, version: definition.version, digest: definition.digest };
		});
		assert.deepEqual(references, offer.capabilities, 'ACCEPTANCE_QUALIFICATION_REFERENCE: Complete original ordered ontology required');
	}
	for (const supplied of definitions) {
		const definition = capabilityDefinitionSchema.parse(supplied);
		assert.deepEqual(definition, supplied);
		const { digest, ...material } = definition;
		assert.equal(capabilityDefinitionDigest(material), digest, 'ACCEPTANCE_QUALIFICATION_DEFINITION: Exact public ontology bytes required');
		assert.notEqual(definition.status, 'revoked', 'ACCEPTANCE_QUALIFICATION_DEFINITION: Revoked capability cannot authorize supply');
		assert.ok(Number.isFinite(Date.parse(admittedAt)), 'ACCEPTANCE_QUALIFICATION_CLOCK: Original admission clock required');
		const references = offer.capabilities.filter(reference => reference.id === definition.id);
		assert.equal(references.length, 1, 'ACCEPTANCE_QUALIFICATION_REFERENCE: Unique exact declared capability required');
		assert.deepEqual(references[0], { id: definition.id, version: definition.version, digest });
		const receipts = offer.conformance.filter(receipt => receipt.capability.id === definition.id);
		assert.equal(receipts.length, 1, 'ACCEPTANCE_QUALIFICATION_RECEIPT: Duplicate or contradictory qualification cannot be selected by array order');
		const receipt = receipts[0]!;
		assert.deepEqual(receipt.capability, references[0]); verifyProviderConformanceSignature(receipt, publicIdentity, providerId);
		assert.equal(receipt.status, 'passed', 'ACCEPTANCE_QUALIFICATION_STATUS: Retained failed or revoked receipt is not passing supply');
		const tiers = ['signed-attestation', 'automated-suite', 'reviewed-certification'];
		assert.ok(tiers.indexOf(receipt.tier) >= tiers.indexOf(definition.qualificationTier), 'ACCEPTANCE_QUALIFICATION_TIER: Original declared minimum tier required');
		if (receipt.tier !== 'signed-attestation') assert.ok(receipt.suite, 'ACCEPTANCE_QUALIFICATION_SUITE: Automated or reviewed suite identity cannot be absent');
		assert.ok(Date.parse(receipt.issuedAt) <= Date.parse(admittedAt), 'ACCEPTANCE_QUALIFICATION_CLOCK: Future qualification is not authority at admission');
		if (receipt.expiresAt) assert.ok(Date.parse(receipt.expiresAt) > Date.parse(admittedAt)
			&& Date.parse(receipt.expiresAt) > Date.parse(receipt.issuedAt), 'ACCEPTANCE_QUALIFICATION_CLOCK: Original unexpired qualification required');
	}
}

export function publicCanonicalRecords(views: unknown[], schemaVersion: string): Row[] {
	const records = new Map<string, Row>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) { value.forEach(visit); return; }
		if (!value || typeof value !== 'object') return;
		const record = row(value);
		if (record.schemaVersion === schemaVersion) {
			assert.ok(typeof record.id === 'string' && record.id, 'ACCEPTANCE_CANONICAL_ID: Exact record identity required');
			const prior = records.get(record.id); if (prior) assert.deepEqual(record, prior, 'ACCEPTANCE_CANONICAL_VIEWS: Same stored record changed across public views');
			else records.set(record.id, record);
		}
		Object.values(record).forEach(visit);
	};
	views.forEach(visit); return [...records.values()];
}

/** Validate original public availability observations, not reconstructed charges
 * or provider-global completeness inferred from one team's readable inventory. */
export function verifyAvailabilityAccountingHistory(sessions: Row[], providerIds: Set<string>, teamId: string): void {
	assert.ok(sessions.length > 0 && providerIds.size > 0, 'ACCEPTANCE_AVAILABILITY_EMPTY: Actual participating provider history required');
	assert.equal(new Set(sessions.map(value => value.id)).size, sessions.length, 'ACCEPTANCE_AVAILABILITY_DUPLICATE: Session identity reused');
	const previous = new Map<string, Row>(), represented = new Set<string>();
	const sorted = [...sessions].sort((a, b) => Date.parse(String(a.refreshedAt)) - Date.parse(String(b.refreshedAt)) || String(a.id).localeCompare(String(b.id)));
	for (const session of sorted) {
		assert.equal(session.teamId, teamId, 'ACCEPTANCE_AVAILABILITY_TEAM: Foreign team history cannot supply this observation');
		assert.ok(typeof session.providerId === 'string' && providerIds.has(session.providerId), 'ACCEPTANCE_AVAILABILITY_PROVIDER: Exact participating provider required');
		represented.add(session.providerId);
		assert.ok(typeof session.id === 'string' && session.id && typeof session.membershipId === 'string' && session.membershipId,
			'ACCEPTANCE_AVAILABILITY_ID: Original session and membership required');
		assert.ok(typeof session.sequence === 'number' && Number.isInteger(session.sequence) && session.sequence > 0, 'ACCEPTANCE_AVAILABILITY_SEQUENCE: Original publication sequence required');
		const opened = Date.parse(String(session.openedAt)), refreshed = Date.parse(String(session.refreshedAt)), expires = Date.parse(String(session.expiresAt));
		assert.ok(Number.isFinite(opened) && Number.isFinite(refreshed) && Number.isFinite(expires) && opened <= refreshed && refreshed < expires,
			'ACCEPTANCE_AVAILABILITY_CLOCK: Publication clocks malformed or reversed');
		assert.ok(['open', 'draining', 'closed', 'expired'].includes(String(session.status)), 'ACCEPTANCE_AVAILABILITY_STATUS: Canonical lifecycle required');
		const adapters = row(session.snapshot).adapters;
		assert.ok(Array.isArray(adapters) && adapters.length > 0, 'ACCEPTANCE_AVAILABILITY_ADAPTERS: Original nonempty adapter observations required');
		for (const value of adapters) {
			const adapter = row(value), limits = capabilityAccountingLimitsSchema.parse(adapter.nativeLimits), accounting = row(adapter.accountingObservation);
			const observations: Array<[string, number, unknown]> = [['model', limits.dailyActiveSecondsLimit, accounting.modelUsage],
				...Object.entries(limits.capabilityLimits).map<[string, number, unknown]>(([id, limit]) => [`capability:${id}`, limit.dailyActiveSecondsLimit, row(accounting.capabilityUsage)[id]])];
			for (const [scope, cap, observation] of observations) {
				const observed = row(observation), clock = Date.parse(String(observed.observedAt));
				assert.equal(typeof observed.healthy, 'boolean', 'ACCEPTANCE_AVAILABILITY_HEALTH: No coerced health authority');
				assert.ok(typeof observed.activeSeconds === 'number' && Number.isFinite(observed.activeSeconds) && observed.activeSeconds >= 0
					&& typeof observed.reservedSeconds === 'number' && Number.isFinite(observed.reservedSeconds) && observed.reservedSeconds >= 0,
					'ACCEPTANCE_AVAILABILITY_USAGE: Exact finite nonnegative measurements required');
				assert.ok(Number.isFinite(clock) && clock <= refreshed && observed.day === new Date(clock).toISOString().slice(0, 10),
					'ACCEPTANCE_AVAILABILITY_OBSERVED: Original UTC scope and observation clock required');
				assert.ok(Number.isFinite(cap) && cap >= 0, 'ACCEPTANCE_AVAILABILITY_CAP: Exact original ceiling required');
				const key = JSON.stringify([session.providerId, limits.modelConfigurationId, scope]), prior = previous.get(key);
				if (prior) {
					assert.ok(clock >= Date.parse(String(prior.observedAt)), 'ACCEPTANCE_AVAILABILITY_MONOTONIC: Observation clock moved backward');
					if (prior.day === observed.day) assert.ok(observed.activeSeconds >= Number(prior.activeSeconds), 'ACCEPTANCE_AVAILABILITY_MONOTONIC: Restart or adapter rename reset shared usage');
				}
				previous.set(key, observed);
			}
		}
	}
	assert.deepEqual(represented, providerIds, 'ACCEPTANCE_AVAILABILITY_EMPTY: Participating provider omitted from history');
}

/** Failed model-backed execution must retain its diagnostic observation beside,
 * not instead of, the sole terminal charge. These are supported public records;
 * a teardown receipt is not independent proof of physical resource absence. */
export function verifyFailedExecutionCustody(items: Row[], measurements: Row[]) {
	const ids = new Set(items.map(item => item.id));
	for (const measurement of measurements.filter(item => item.accountingMode === 'informational')) {
		assert.ok(ids.has(measurement.assignmentId), 'ACCEPTANCE_FAILED_USAGE: Orphan informational observation');
		assert.equal(measurement.activeSeconds, 0, 'ACCEPTANCE_FAILED_USAGE: Diagnostic cannot charge productive time');
		assert.equal(measurement.elapsedSeconds, 0, 'ACCEPTANCE_FAILED_USAGE: Diagnostic cannot charge elapsed time');
	}
	const failures = items.filter(item => ['failed', 'returned'].includes(String(item.status))
		&& typeof row(row(row(item.capacityEnvelope).budget).time).executionStartedAt === 'string'
		&& row(row(item.assignmentAttempt).effectiveProfile).handler !== 'reporter');
	assert.ok(failures.length > 0, 'ACCEPTANCE_FAILED_USAGE: Actual failed productive model-backed execution required');
	for (const item of failures) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), output = row(item.lifecycleOutput), teardown = row(output.teardown);
		assert.equal(item.id, attempt.id);
		assert.ok(typeof output.sandboxId === 'string' && output.sandboxId, 'ACCEPTANCE_FAILED_OUTPUT: Owning sandbox identity lost');
		assert.equal(teardown.verified, true, 'ACCEPTANCE_FAILED_OUTPUT: Failed execution must retain verified closeout');
		const closed = Date.parse(String(teardown.completedAt)), terminal = Date.parse(String(item.returnedAt ?? item.failedAt ?? item.completedAt));
		const started = Date.parse(String(row(row(row(item.capacityEnvelope).budget).time).executionStartedAt));
		assert.ok(Number.isFinite(started) && Number.isFinite(closed) && Number.isFinite(terminal) && started <= closed && closed <= terminal,
			'ACCEPTANCE_FAILED_OUTPUT: Teardown must fall within its recorded start and terminal interval');
		const diagnostic = measurements.filter(measurement => measurement.assignmentId === item.id && measurement.accountingMode === 'informational'
			&& measurement.usageDimension === 'diagnostic-0');
		const aggregate = measurements.filter(measurement => measurement.assignmentId === item.id && measurement.accountingMode === 'aggregate');
		assert.equal(diagnostic.length, 1, 'ACCEPTANCE_FAILED_USAGE: First executor observation missing or duplicated');
		assert.equal(aggregate.length, 1, 'ACCEPTANCE_FAILED_USAGE: Exactly one independent terminal aggregate required');
		for (const measurement of [diagnostic[0]!, aggregate[0]!]) {
			assert.equal(measurement.assignmentAttempt, attempt.attempt);
			assert.equal(measurement.projectId, attempt.projectId); assert.equal(measurement.workDayId, attempt.workdayId);
			assert.equal(measurement.capacityProviderId, attempt.provider.providerId);
			assert.ok(typeof measurement.id === 'string' && measurement.id && typeof measurement.idempotencyKey === 'string' && measurement.idempotencyKey);
		}
		assert.notEqual(diagnostic[0]!.id, aggregate[0]!.id); assert.notEqual(diagnostic[0]!.idempotencyKey, aggregate[0]!.idempotencyKey);
		const native = row(aggregate[0]!.nativeUsage);
		assert.ok(Object.keys(native).length > 0 && Object.values(native).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0),
			'ACCEPTANCE_FAILED_USAGE: Nonempty original native measurement required');
		assert.deepEqual(diagnostic[0]!.nativeUsage, native, 'ACCEPTANCE_FAILED_USAGE: Failure classification changed native usage');
		for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']) {
			assert.equal(diagnostic[0]![field], aggregate[0]![field], `ACCEPTANCE_FAILED_USAGE: ${field} changed during closeout`);
		}
	}
}
/** Public closeout custody only: never infer host/container/path absence from a
 * positive receipt. Reporter and pre-isolation failures have no sandbox scope. */
export function verifySandboxCloseoutCustody(items: Row[]): void {
	const isolated = items.filter(item => Object.hasOwn(row(item.lifecycleOutput), 'sandboxId')
		|| (typeof row(row(row(item.capacityEnvelope).budget).time).executionStartedAt === 'string'
			&& row(row(item.assignmentAttempt).effectiveProfile).handler !== 'reporter'));
	assert.ok(isolated.length > 0, 'ACCEPTANCE_SANDBOX_EMPTY: Actual isolated execution required');
	const identities = new Set<string>();
	for (const item of isolated) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), output = row(item.lifecycleOutput), teardown = row(output.teardown);
		assert.equal(item.id, attempt.id, 'ACCEPTANCE_SANDBOX_OWNER: Original owning attempt required');
		assert.ok(typeof output.sandboxId === 'string' && output.sandboxId.trim(), 'ACCEPTANCE_SANDBOX_ID: Nonempty original sandbox required');
		assert.ok(!identities.has(output.sandboxId), 'ACCEPTANCE_SANDBOX_REUSED: Sandbox identity reused across attempts'); identities.add(output.sandboxId);
		assert.equal(teardown.verified, true, 'ACCEPTANCE_SANDBOX_UNVERIFIED: Terminal execution cannot erase failed teardown');
		assert.ok(typeof teardown.completedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(teardown.completedAt), 'ACCEPTANCE_SANDBOX_CLOCK: Exact closeout clock required');
		const closed = Date.parse(teardown.completedAt), startedValue = row(row(row(item.capacityEnvelope).budget).time).executionStartedAt;
		const started = Date.parse(typeof startedValue === 'string' ? startedValue : attempt.createdAt);
		const terminal = Date.parse(String(item.returnedAt ?? item.failedAt ?? item.cancelledAt ?? item.expiredAt ?? item.completedAt));
		assert.ok(Number.isFinite(started) && Number.isFinite(closed) && Number.isFinite(terminal) && started <= closed && closed <= terminal,
			'ACCEPTANCE_SANDBOX_CLOCK: Closeout must remain within its own recorded lifecycle');
		assert.ok(['completed', 'returned', 'failed', 'cancelled', 'expired'].includes(String(item.status)), 'ACCEPTANCE_SANDBOX_TERMINAL: Public scope remains live');
		if (item.status === 'completed') {
			const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.assignmentId, attempt.id); assert.equal(result.status, 'completed');
		} else {
			for (const value of [item.assignmentResult, output.assignmentResult]) {
				if (value === undefined || value === null) continue;
				const result = assignmentResultSchema.parse(value);
				assert.equal(result.assignmentId, attempt.id, 'ACCEPTANCE_SANDBOX_LATE_RESULT: Late result belongs to another attempt');
				assert.notEqual(result.status, 'completed', 'ACCEPTANCE_SANDBOX_LATE_RESULT: Failed or revoked execution retained a false completed result');
			}
		}
	}
}
/** Independently observed host inventories, never a positive broker receipt.
 * Only the exact represented execution IDs are checked; unrelated warm pool
 * resources are legitimate and are not deleted or required to disappear. */
export function verifySandboxHostAbsence(items: Row[], connections: Array<{ providerId: string; teamId: string }>,
	root: string, tasks: string, containers: string, mountInfo: string): string[] {
	verifySandboxCloseoutCustody(items);
	assert.ok(isAbsolute(root) && resolve(root) === root && root !== '/', 'ACCEPTANCE_SANDBOX_ROOT: Exact owning native state root required');
	const inventory = (bytes: string) => {
		const ids = bytes.trim() ? bytes.trim().split(/\s+/u) : [];
		assert.ok(ids.every(id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id)) && new Set(ids).size === ids.length,
			'ACCEPTANCE_SANDBOX_INVENTORY: Complete native quiet inventory malformed'); return new Set(ids);
	};
	const taskIds = inventory(tasks), containerIds = inventory(containers);
	assert.ok(mountInfo.trim(), 'ACCEPTANCE_SANDBOX_MOUNTS: Readable host mount inventory required');
	const mounts = mountInfo.trim().split('\n').map(line => {
		const fields = line.split(' '), separator = fields.indexOf('-');
		assert.ok(separator >= 6 && fields.length >= separator + 4 && /^\d+$/u.test(fields[0]!) && /^\d+$/u.test(fields[1]!),
			'ACCEPTANCE_SANDBOX_MOUNTS: Incomplete native mountinfo cannot prove absence');
		return fields[4]!.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
	});
	return items.filter(item => Object.hasOwn(row(item.lifecycleOutput), 'sandboxId')).map(item => {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), id = row(item.lifecycleOutput).sandboxId;
		assert.ok(connections.some(connection => connection.providerId === attempt.provider.providerId && connection.teamId === attempt.teamId),
			'ACCEPTANCE_SANDBOX_HOST: Remote or foreign provider cannot be checked on this host');
		assert.ok(typeof id === 'string' && /^sandbox-[a-zA-Z0-9-]+-[1-9][0-9]*-[a-f0-9]{8}$/u.test(id),
			'ACCEPTANCE_SANDBOX_PATH: Exact original native sandbox identity required');
		assert.ok(!taskIds.has(id) && !containerIds.has(id), 'ACCEPTANCE_SANDBOX_RESIDUE: Native task or container remains');
		const path = resolve(root, id);
		assert.ok(!mounts.some(mount => mount === path || mount.startsWith(`${path}/`)), 'ACCEPTANCE_SANDBOX_RESIDUE: Owning host mount remains');
		return path;
	});
}
export function verifySandboxDirectoryAbsence(paths: string[]): void {
	assert.ok(paths.length > 0 && new Set(paths).size === paths.length, 'ACCEPTANCE_SANDBOX_PATH: Nonempty distinct owning paths required');
	for (const path of paths) {
		let absent = false;
		try { lstatSync(path); } catch (error) { absent = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }
		assert.ok(absent, 'ACCEPTANCE_SANDBOX_RESIDUE: Directory, file, dangling symlink or unreadable path is not verified absent');
	}
}
/** Read only the existing local slot/terminal-event authority. Never call
 * snapshot()/recovery here: those methods mutate accounting and revision.
 * Return credential-free joins; raw local tokens/envelopes must not appear in
 * assertion diagnostics. This is local slot closure, not session/VM absence. */
export function verifyProviderLocalSlotClosure(items: Row[], connections: Array<{ id: string; providerId?: string | null;
	teamId?: string | null; membershipId?: string | null }>, value: unknown): Row[] {
	const state = row(value);
	assert.ok(state.schemaVersion === 1 && typeof state.revision === 'number' && Number.isInteger(state.revision) && state.revision >= 0,
		'ACCEPTANCE_PROVIDER_LOCAL_STATE: Exact existing local state revision required');
	assert.ok(Array.isArray(state.claims) && Array.isArray(state.events), 'ACCEPTANCE_PROVIDER_LOCAL_STATE: Whole readable slot and event inventories required');
	assert.ok(items.length > 0, 'ACCEPTANCE_PROVIDER_LOCAL_EMPTY: Actual represented attempts required');
	const claims = state.claims.map(row), events = state.events.map(row), eventIds = events.map(event => event.id);
	assert.ok(claims.every(claim => typeof claim.id === 'string' && claim.id && typeof claim.connectionId === 'string' && claim.connectionId
		&& ['polling', 'ready', 'running', 'recovery'].includes(String(claim.status))
		&& (claim.status === 'polling' || (typeof claim.assignmentId === 'string' && claim.assignmentId))),
		'ACCEPTANCE_PROVIDER_LOCAL_STATE: Malformed unrelated claim cannot conceal retained authority');
	assert.ok(eventIds.every(id => typeof id === 'string' && id && id === id.trim()) && new Set(eventIds).size === eventIds.length,
		'ACCEPTANCE_PROVIDER_LOCAL_EVENTS: Missing or reused local event identity');
	const ids = new Set<string>(), usedClaims = new Set<string>();
	return items.map(item => {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(item.id, attempt.id); assert.ok(!ids.has(attempt.id), 'ACCEPTANCE_PROVIDER_LOCAL_OWNER: Attempt reused'); ids.add(attempt.id);
		assert.ok(['completed', 'failed', 'returned', 'cancelled', 'expired'].includes(String(item.status)), 'ACCEPTANCE_PROVIDER_LOCAL_TERMINAL: Represented attempt is still live');
		assert.ok(typeof item.membershipId === 'string' && item.membershipId, 'ACCEPTANCE_PROVIDER_LOCAL_OWNER: Approved membership identity required');
		const owners = connections.filter(connection => connection.providerId === attempt.provider.providerId
			&& connection.teamId === attempt.teamId && connection.membershipId === item.membershipId);
		assert.equal(owners.length, 1, 'ACCEPTANCE_PROVIDER_LOCAL_HOST: Exact unique installed provider team membership required');
		const owner = owners[0]!;
		assert.ok(typeof owner.id === 'string' && owner.id, 'ACCEPTANCE_PROVIDER_LOCAL_HOST: Original connection ID required');
		assert.ok(!claims.some(claim => claim.assignmentId === attempt.id), 'ACCEPTANCE_PROVIDER_LOCAL_RESIDUE: Terminal attempt retains a polling ready running or recovery reservation');
		const retained = events.filter(event => event.assignmentId === attempt.id), leased = retained.filter(event => event.outcome === 'leased');
		assert.equal(leased.length, 1, 'ACCEPTANCE_PROVIDER_LOCAL_HISTORY: Exact leased history required; missing bounded history is unproven');
		const lease = leased[0]!;
		assert.ok(typeof lease.claimId === 'string' && lease.claimId && lease.connectionId === owner.id,
			'ACCEPTANCE_PROVIDER_LOCAL_OWNER: Original claim belongs to another configured connection');
		assert.ok(!usedClaims.has(lease.claimId), 'ACCEPTANCE_PROVIDER_LOCAL_OWNER: Local claim reused across attempts'); usedClaims.add(lease.claimId);
		assert.ok(!claims.some(claim => claim.id === lease.claimId), 'ACCEPTANCE_PROVIDER_LOCAL_RESIDUE: Original terminal slot remains under a changed assignment ID');
		assert.ok(retained.every(event => event.claimId === lease.claimId && event.connectionId === owner.id),
			'ACCEPTANCE_PROVIDER_LOCAL_OWNER: Terminal event changed the original owning slot');
		const outcomes = new Set(['terminal-receipt-confirmed', `authoritative-${String(item.status)}`,
			...(item.status === 'returned' ? ['restart-return-confirmed'] : [])]);
		const terminal = retained.filter(event => outcomes.has(String(event.outcome)));
		assert.equal(terminal.length, 1, 'ACCEPTANCE_PROVIDER_LOCAL_HISTORY: Exactly one confirmed terminal observation required');
		assert.ok(retained.every(event => event === lease || event === terminal[0] || ['lifecycle-unconfirmed', 'lease-expired-recovery-required'].includes(String(event.outcome))),
			'ACCEPTANCE_PROVIDER_LOCAL_HISTORY: Unknown unleased or contradictory terminal outcome cannot prove release');
		assert.ok(typeof lease.recordedAt === 'string' && typeof terminal[0]!.recordedAt === 'string', 'ACCEPTANCE_PROVIDER_LOCAL_CLOCK: Original string clocks required');
		const acquired = Date.parse(lease.recordedAt), finished = Date.parse(terminal[0]!.recordedAt);
		assert.ok(Number.isFinite(acquired) && Number.isFinite(finished) && acquired >= Date.parse(attempt.createdAt) && finished >= acquired,
			'ACCEPTANCE_PROVIDER_LOCAL_CLOCK: Exact ordered owning event clocks required');
		return { assignmentId: attempt.id, claimId: lease.claimId, connectionId: owner.id, outcome: terminal[0]!.outcome,
			leaseRecordedAt: lease.recordedAt, recordedAt: terminal[0]!.recordedAt };
	});
}
/** Replay scheduling metadata retained on the ORIGINAL local claim/lease event.
 * Never reconstruct its historical input from current usage. No credentials,
 * assignment content, new ledger, alternate ranker or provider policy here.
 * Native producer tests independently compare these inputs with their actual
 * before-state; replay alone cannot prove all upstream eligibility decisions. */
export function verifyProviderPollingSelection(owner: Row, registered: Array<{ id: string; teamId?: string | null }>): Row {
	const selection = row(owner.selection), input = row(selection.input), snapshot = row(input.snapshot);
	const keys = (value: Row, allowed: string[]) => assert.deepEqual(Object.keys(value).sort(), [...allowed].sort(),
		'ACCEPTANCE_PROVIDER_SELECTION_FIELDS: Only original credential-free scheduling inputs may be retained');
	keys(selection, ['id', 'input']); keys(input, ['connections', 'snapshot']);
	keys(snapshot, ['claims', 'events', 'activeSecondsByConnection']);
	assert.ok(Array.isArray(input.connections) && input.connections.length > 0 && Array.isArray(snapshot.claims) && Array.isArray(snapshot.events),
		'ACCEPTANCE_PROVIDER_SELECTION_EMPTY: Original complete eligible scheduling inputs required');
	const connections = input.connections.map(value => {
		const entry = row(value), connection = row(entry.connection); keys(entry, ['connection', 'teamId']); keys(connection, ['id']);
		assert.ok(typeof connection.id === 'string' && connection.id && typeof entry.teamId === 'string' && entry.teamId,
			'ACCEPTANCE_PROVIDER_SELECTION_ID: Original connection and team identity required');
		assert.equal(registered.filter(candidate => candidate.id === connection.id && candidate.teamId === entry.teamId).length, 1,
			'ACCEPTANCE_PROVIDER_SELECTION_OWNER: Exact unique native manifest identity required');
		return { connection: { id: connection.id }, teamId: entry.teamId };
	});
	assert.equal(new Set(connections.map(value => value.connection.id)).size, connections.length);
	assert.equal(new Set(connections.map(value => value.teamId)).size, connections.length);
	const claims = snapshot.claims.map(value => {
		const claim = row(value); keys(claim, ['connectionId']); assert.ok(typeof claim.connectionId === 'string' && claim.connectionId);
		return { connectionId: claim.connectionId };
	});
	const events = snapshot.events.map(value => {
		const event = row(value); keys(event, ['connectionId', 'outcome']);
		assert.ok(typeof event.connectionId === 'string' && event.connectionId && typeof event.outcome === 'string' && event.outcome);
		return { connectionId: event.connectionId, outcome: event.outcome };
	});
	const usage = row(snapshot.activeSecondsByConnection); assert.ok(snapshot.activeSecondsByConnection && typeof snapshot.activeSecondsByConnection === 'object' && !Array.isArray(snapshot.activeSecondsByConnection));
	const activeSecondsByConnection: Record<string, number> = {};
	for (const [id, seconds] of Object.entries(usage)) {
		assert.ok(id && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0,
			'ACCEPTANCE_PROVIDER_SELECTION_USAGE: Exact native measured seconds required'); activeSecondsByConnection[id] = seconds;
	}
	assert.equal(selection.id, owner.connectionId, 'ACCEPTANCE_PROVIDER_SELECTION_OWNER: Retained winner changed its owning slot');
	const ordered = orderConnectionsForFairPolling(connections, { claims, events, activeSecondsByConnection });
	assert.equal(ordered[0]?.connection.id, selection.id, 'ACCEPTANCE_PROVIDER_SELECTION_FAIR: Owning global choice disagrees with original actual-seconds input');
	return { connectionId: selection.id, teamId: ordered[0]!.teamId, eligibleTeams: connections.map(value => value.teamId),
		input: structuredClone(input) };
}
/** Exact existing Workday ancestry and immutable attempt authority, not another
 * continuation receipt or a substitute for native governance/content approval. */
export function verifyWorkdayContinuationCustody(runs: Row[], items: Row[]): void {
	assert.ok(runs.length >= 2 && runs.length <= 64, 'ACCEPTANCE_CONTINUATION_BOUND: Complete original bounded ancestry required');
	const first = runs[0]!, ids = new Set(runs.map(run => run.id));
	assert.equal(ids.size, runs.length, 'ACCEPTANCE_CONTINUATION_CYCLE: Workday identity reused');
	assert.ok(typeof first.teamId === 'string' && first.teamId && typeof first.capacityProviderId === 'string' && first.capacityProviderId,
		'ACCEPTANCE_CONTINUATION_SCOPE: Exact team/provider custody required');
	assert.ok(['production', 'simulation'].includes(String(first.executionMode)), 'ACCEPTANCE_CONTINUATION_MODE: Exact execution mode required');
	const attempts = items.map(item => { const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); assert.equal(item.id, attempt.id); return attempt; });
	assert.equal(new Set(attempts.map(attempt => attempt.id)).size, attempts.length, 'ACCEPTANCE_CONTINUATION_ATTEMPT: Prior attempt reused');
	for (const item of items) {
		assert.ok(['completed', 'failed', 'returned', 'cancelled', 'expired', 'blocked'].includes(String(item.status)),
			'ACCEPTANCE_CONTINUATION_UNSETTLED: Retained assignment is not terminal');
		assert.ok(['unleased', 'released', 'expired'].includes(String(item.leaseState))
			&& [item.leaseToken, item.leaseExpiresAt, item.leaseRenewedAt].every(value => value === null || value === undefined),
			'ACCEPTANCE_CONTINUATION_UNSETTLED: Retained lease authority must be closed');
	}
	const resultIds = items.filter(item => item.assignmentResult !== undefined && item.assignmentResult !== null).map(item => {
		const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.assignmentId, item.id); return result.id;
	});
	assert.equal(new Set(resultIds).size, resultIds.length, 'ACCEPTANCE_CONTINUATION_RESULT: Result identity reused across workdays');
	for (const [index, run] of runs.entries()) {
		assert.equal(run.teamId, first.teamId); assert.equal(run.capacityProviderId, first.capacityProviderId); assert.equal(run.executionMode, first.executionMode);
		assert.equal(run.executionKind, 'workday'); assert.ok(['completed', 'degraded', 'cancelled', 'failed'].includes(String(run.status)), 'ACCEPTANCE_CONTINUATION_UNSETTLED: Workday still active');
		const started = run.startedAt, finished = run.completedAt;
		assert.ok(typeof started === 'string' && typeof finished === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(started) && /^\d{4}-\d{2}-\d{2}T/u.test(finished)
			&& Number.isFinite(Date.parse(started)) && Number.isFinite(Date.parse(finished)) && Date.parse(started) <= Date.parse(finished), 'ACCEPTANCE_CONTINUATION_CLOCK: Original terminal interval required');
		const parameters = row(run.parameters), parent = runs[index + 1], selected = parameters.scheduledProjectIds;
		assert.ok(Array.isArray(selected) && selected.length > 0 && selected.every(id => typeof id === 'string' && id), 'ACCEPTANCE_CONTINUATION_PROJECT: Original project scope required');
		assert.equal(new Set(selected).size, selected.length);
		if (parent) {
			assert.equal(parameters.continueFromWorkdayId, parent.id, 'ACCEPTANCE_CONTINUATION_PARENT: Missing substituted or skipped ancestor');
			const parentProjects = row(parent.parameters).scheduledProjectIds;
			assert.ok(Array.isArray(parentProjects) && selected.every(id => parentProjects.includes(id)), 'ACCEPTANCE_CONTINUATION_PROJECT: Project expansion denied');
			assert.ok(Number.isFinite(Date.parse(String(parent.completedAt))) && Number.isFinite(Date.parse(String(run.startedAt)))
				&& Date.parse(String(parent.completedAt)) <= Date.parse(String(run.startedAt)), 'ACCEPTANCE_CONTINUATION_CLOCK: Continuation precedes prior terminal custody');
			const selectedDecisions = parameters.decisionIds, priorIds = new Set(runs.slice(index + 1).map(value => value.id));
			assert.ok(Array.isArray(selectedDecisions) && selectedDecisions.length > 0 && selectedDecisions.every(id => typeof id === 'string' && id)
				&& new Set(selectedDecisions).size === selectedDecisions.length, 'ACCEPTANCE_CONTINUATION_DECISION: Exact nonempty original selection required');
			for (const id of selectedDecisions) assert.ok(attempts.some(prior => priorIds.has(prior.workdayId)
				&& prior.authorityRefs.some(ref => ref.model === 'decision' && ref.id === id)), 'ACCEPTANCE_CONTINUATION_DECISION: Selected Decision has no executed ancestor');
		} else assert.equal(Object.hasOwn(parameters, 'continueFromWorkdayId'), false, 'ACCEPTANCE_CONTINUATION_TAIL: Original root not reached');
		const own = attempts.filter(attempt => attempt.workdayId === run.id);
		assert.ok(own.length > 0, 'ACCEPTANCE_CONTINUATION_EMPTY: Ancestry cannot stand in for actual execution');
		for (const attempt of own) {
			assert.equal(attempt.teamId, first.teamId); assert.equal(attempt.provider.providerId, first.capacityProviderId);
			assert.ok(selected.includes(attempt.projectId), 'ACCEPTANCE_CONTINUATION_PROJECT: Attempt outside original scope');
			if (!parent || !['acting', 'reviewing'].includes(attempt.effectiveProfile.activity)) continue;
			const decisions = attempt.authorityRefs.filter(ref => ref.model === 'decision');
			assert.ok(decisions.length > 0, 'ACCEPTANCE_CONTINUATION_DECISION: Acting requires exact prior Decision authority');
			const priorIds = new Set(runs.slice(index + 1).map(value => value.id));
			const decisionIds = parameters.decisionIds;
			assert.ok(Array.isArray(decisionIds) && decisions.every(ref => decisionIds.includes(ref.id)), 'ACCEPTANCE_CONTINUATION_DECISION: Assignment escaped original selection');
			for (const decision of decisions) assert.ok(attempts.some(prior => priorIds.has(prior.workdayId)
				&& prior.projectId === attempt.projectId && isDeepStrictEqual(prior.sourceRef, attempt.sourceRef)
				&& prior.authorityRefs.some(ref => isDeepStrictEqual(ref, decision))), 'ACCEPTANCE_CONTINUATION_DECISION: Source or Decision authority substituted');
		}
	}
	assert.ok(attempts.every(attempt => ids.has(attempt.workdayId)), 'ACCEPTANCE_CONTINUATION_ORPHAN: Attempt outside exact ancestry');
}
export function verifyTerminalRecordCustody(items: Row[], leases: Row[], reservations: Row[], settlements: Row[], measurements: Row[]): void {
	assert.ok(items.length > 0, 'ACCEPTANCE_CANONICAL_EMPTY: Every real attempt must be independently available');
	assertCanonicalRecordShapes([['Lease', leases], ['Reservation', reservations], ['UsageSettlement', settlements]]);
	for (const records of [leases, reservations, settlements]) {
		assert.equal(new Set(records.map(record => record.id)).size, records.length, 'ACCEPTANCE_CANONICAL_DUPLICATE: Duplicate operational identity');
	}
	assert.equal(new Set(settlements.map(record => record.idempotencyKey)).size, settlements.length, 'ACCEPTANCE_CANONICAL_DUPLICATE: Settlement key reused');
	assert.equal(new Set(items.map(item => item.id)).size, items.length, 'ACCEPTANCE_CANONICAL_DUPLICATE: Attempt identity reused');
	assert.equal(leases.length, items.length); assert.equal(reservations.length, items.length); assert.equal(settlements.length, items.length);
	const ids = new Set(items.map(item => item.id)), resultIds = new Set<string>();
	const aggregates = measurements.filter(value => value.accountingMode === 'aggregate');
	assert.equal(aggregates.length, items.length, 'ACCEPTANCE_CANONICAL_MEASURED: Exact represented aggregate inventory required');
	assert.ok(aggregates.every(value => ids.has(value.assignmentId)), 'ACCEPTANCE_CANONICAL_MEASURED: Orphan aggregate');
	assert.ok(aggregates.every(value => typeof value.id === 'string' && value.id && value.id === value.id.trim()), 'ACCEPTANCE_CANONICAL_MEASURED: Original measurement identity required');
	assert.equal(new Set(aggregates.map(value => value.id)).size, aggregates.length, 'ACCEPTANCE_CANONICAL_MEASURED: Measurement identity reused');
	for (const item of items) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.deepEqual(attempt, item.assignmentAttempt, 'ACCEPTANCE_CANONICAL_RAW: Parsing cannot repair frozen authority');
		assert.equal(item.id, attempt.id); assert.equal(item.attemptCount, attempt.attempt);
		for (const [field, expected] of Object.entries({ teamId: attempt.teamId, projectId: attempt.projectId,
			capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId,
			workDayId: attempt.workdayId, executionNodeId: attempt.nodeId, executionNodeRevision: attempt.nodeRevision, graphRevision: attempt.graphRevision })) {
			assert.equal(item[field], expected, `ACCEPTANCE_CANONICAL_BINDING: Public ${field} differs from the unchanged frozen attempt`);
		}
		assert.ok(typeof item.membershipId === 'string' && item.membershipId && item.membershipId === item.membershipId.trim(),
			'ACCEPTANCE_CANONICAL_BINDING: Original approved provider membership identity required');
		assert.ok(['completed', 'blocked', 'failed', 'cancelled', 'expired'].includes(attempt.status), 'ACCEPTANCE_CANONICAL_TERMINAL: Nonterminal attempt');
		const lease = leases.filter(record => record.assignmentId === attempt.id), reservation = reservations.filter(record => record.assignmentId === attempt.id), settlement = settlements.filter(record => record.assignmentId === attempt.id);
		assert.equal(lease.length, 1); assert.equal(reservation.length, 1); assert.equal(settlement.length, 1);
		const l = lease[0]!, r = reservation[0]!, s = settlement[0]!;
		assert.equal(l.id, attempt.leaseId); assert.equal(r.id, attempt.reservationId); assert.equal(s.reservationId, r.id);
		for (const record of [l, r, s]) assert.equal(record.providerId, attempt.provider.providerId, 'ACCEPTANCE_CANONICAL_JOIN: Provider differs from original attempt');
		assert.equal(r.workdayId, attempt.workdayId); assert.equal(s.workdayId, attempt.workdayId); assert.equal(s.teamId, attempt.teamId);
		assert.equal(s.projectId, attempt.projectId); assert.equal(s.agentClass, attempt.agentClass);
		assert.ok(l.state !== 'active' && r.state !== 'held', 'ACCEPTANCE_CANONICAL_TERMINAL: Lease or reservation remains live');
		assert.ok(Date.parse(String(l.acquiredAt)) <= Date.parse(String(l.expiresAt)), 'ACCEPTANCE_CANONICAL_CLOCK: Lease clock reversed');
		if (l.releasedAt !== undefined) assert.ok(Date.parse(String(l.releasedAt)) >= Date.parse(String(l.acquiredAt)), 'ACCEPTANCE_CANONICAL_CLOCK: Lease release precedes acquisition');
		if (r.closedAt !== undefined) assert.ok(Date.parse(String(r.closedAt)) >= Date.parse(String(r.reservedAt)), 'ACCEPTANCE_CANONICAL_CLOCK: Reservation closure precedes reservation');
		assert.ok(Date.parse(String(s.settledAt)) >= Date.parse(attempt.createdAt), 'ACCEPTANCE_CANONICAL_CLOCK: Settlement preceded attempt');
		const aggregate = measurements.filter(value => value.assignmentId === attempt.id && value.accountingMode === 'aggregate');
		assert.equal(aggregate.length, 1, 'ACCEPTANCE_CANONICAL_MEASURED: One independently read aggregate required');
		assert.equal(aggregate[0]!.assignmentAttempt, attempt.attempt); assert.equal(s.actualSeconds, aggregate[0]!.activeSeconds);
		assert.equal(aggregate[0]!.projectId, attempt.projectId); assert.equal(aggregate[0]!.workDayId, attempt.workdayId);
		assert.deepEqual(s.nativeUsage, aggregate[0]!.nativeUsage, 'ACCEPTANCE_CANONICAL_MEASURED: Native units changed');
		if (attempt.status === 'completed' || item.assignmentResult !== null && item.assignmentResult !== undefined) {
			const result = assignmentResultSchema.parse(item.assignmentResult);
			assert.deepEqual(result, item.assignmentResult, 'ACCEPTANCE_CANONICAL_RAW: Parsing cannot repair result authority');
			assert.equal(result.assignmentId, attempt.id); assert.equal(result.status, attempt.status);
			assert.ok(!resultIds.has(result.id), 'ACCEPTANCE_CANONICAL_DUPLICATE: Result identity reused'); resultIds.add(result.id);
			const completed = Date.parse(result.completedAt), start = Date.parse(attempt.startedAt ?? attempt.createdAt), finish = Date.parse(attempt.finishedAt ?? attempt.deadline);
			assert.ok(start <= completed && completed <= finish && completed <= Date.parse(attempt.deadline), 'ACCEPTANCE_CANONICAL_CLOCK: Result outside original productive interval');
			assert.equal(result.usage.elapsedSeconds, aggregate[0]!.elapsedSeconds);
			assert.deepEqual(result.usage.native, s.nativeUsage, 'ACCEPTANCE_CANONICAL_MEASURED: Result and stored settlement disagree');
		}
	}
}
