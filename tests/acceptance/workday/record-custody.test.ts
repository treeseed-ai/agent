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
import { readCompleteEvidence } from './evidence-pages.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody, verifyFailedExecutionCustody, verifyAvailabilityAccountingHistory, verifySandboxCloseoutCustody, verifyWorkdayContinuationCustody, verifySandboxHostAbsence, verifySandboxDirectoryAbsence, verifyProviderConformanceSignature, verifyProviderQualification, verifyProviderLocalSlotClosure, verifyProviderPollingSelection } from './record-custody.ts';

function actual(id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '') {
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_CANONICAL_RUN: Exact native workday required');
	const observed = read(['workdays', 'show', id], team), run = row(observed.run); assert.equal(run.id, id); assert.equal(run.executionMode, 'simulation');
	const items = readWorkdayAssignments(id, String(run.startedAt), team), views: unknown[] = [observed, items], measurements = [];
	assert.ok(items.length > 0);
	for (const item of items) { const shown = read(['assignments', 'show', String(item.id)], team); assert.deepEqual(shown, item); views.push(shown); }
	for (const project of new Set(items.map(item => String(item.projectId)))) {
		assert.ok(project && project !== 'undefined');
		measurements.push(...readCompleteEvidence(['capacity', 'usage', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CANONICAL_USAGE'));
		views.push(readCompleteEvidence(['capacity', 'ledger', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CANONICAL_LEDGER'));
	}
	return { id, team, run, observed, items, views, measurements };
}
function verify(f: ReturnType<typeof actual>) {
	// Public record shape checks are NOT the whole canonical equivalence gate.
	// Use the original owning SDK repository verifier on the exact existing
	// development authority, with no copied schema or record reconstruction.
	const root = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	assert.ok(root, 'ACCEPTANCE_CANONICAL_INPUT: Existing exact development authority required');
	const schemaPath = resolve(root, 'docs/agent.schema.yml'), bytes = readFileSync(schemaPath, 'utf8');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	assert.equal(execFileSync('git', ['show', `${head}:docs/agent.schema.yml`], { cwd: root, encoding: 'utf8' }), bytes);
	const canonical = verifyPlatformRepository(root);
	assert.equal(canonical.ok, true, 'ACCEPTANCE_CANONICAL_EQUIVALENCE: Complete original SDK contract verification must pass before records can be accepted');
	assert.deepEqual(canonical.diagnostics, []);
	for (const item of f.items) {
		assert.deepEqual(assignmentAttemptSchema.parse(item.assignmentAttempt), item.assignmentAttempt,
			'ACCEPTANCE_CANONICAL_RAW: Frozen attempt must already be canonical; parsing cannot repair authority');
		if (item.assignmentResult !== null && item.assignmentResult !== undefined) assert.deepEqual(
			assignmentResultSchema.parse(item.assignmentResult), item.assignmentResult,
			'ACCEPTANCE_CANONICAL_RAW: Completed and failed results must retain their original canonical identities');
	}
	verifyTerminalRecordCustody(f.items, publicCanonicalRecords(f.views, 'treeseed.lease/v1'), publicCanonicalRecords(f.views, 'treeseed.reservation/v1'),
		publicCanonicalRecords(f.views, 'treeseed.usage-settlement/v1'), f.measurements);
	const again = actual(f.id); assert.deepEqual(again.observed, f.observed); assert.deepEqual(again.items, f.items); assert.deepEqual(again.views, f.views); assert.deepEqual(again.measurements, f.measurements);
	assert.deepEqual(verifyPlatformRepository(root), canonical);
	assert.equal(readFileSync(schemaPath, 'utf8'), bytes);
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
}
function availabilityHistory(team: string) {
	const sessions = [], identities = new Set<string>(), cursors = new Set<string>(); let cursor: string | undefined;
	let previous: { id: string; time: number } | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
		const observed = read(['capacity', 'status', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], team), page = row(observed.page);
		assert.ok(Array.isArray(observed.items) && observed.items.length <= 100 && page.limit === 100 && typeof page.hasMore === 'boolean',
			'ACCEPTANCE_AVAILABILITY_PAGE: Original complete page authority required');
		for (const value of observed.items) {
			const session = row(value), id = typeof session.id === 'string' ? session.id : '', time = Date.parse(String(session.openedAt));
			assert.ok(id && Number.isFinite(time) && !identities.has(id), 'ACCEPTANCE_AVAILABILITY_PAGE: Unique session identity and owning opening clock required');
			assert.ok(!previous || time < previous.time || (time === previous.time && id < previous.id), 'ACCEPTANCE_AVAILABILITY_PAGE: Original descending opening order required');
			identities.add(id); previous = { id, time }; sessions.push(session);
		}
		if (!page.hasMore) { assert.equal(page.nextCursor, null, 'ACCEPTANCE_AVAILABILITY_PAGE: Explicit terminal cursor required'); return sessions; }
		assert.ok(observed.items.length === 100 && typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor),
			'ACCEPTANCE_AVAILABILITY_PAGE: Complete progressing inventory required');
		const next = decodeCapacityPageCursor(page.nextCursor), last = sessions.at(-1)!;
		// Original repository creation/opening clocks are the same publication input.
		assert.ok(next && next.id === last.id && next.createdAt === last.openedAt, 'ACCEPTANCE_AVAILABILITY_PAGE: Cursor must bind the actual last session');
		cursor = page.nextCursor; cursors.add(cursor);
	}
	assert.fail('ACCEPTANCE_AVAILABILITY_PAGE: Complete inventory exceeds the original forty-page acceptance bound');
}
// Existing supported public reads, complete pages and SAME native managed run.
// No private route, canonical reconstruction, inferred charge, alternate runner
// or physical closure claim from SQL IDs. Physical/resource guarantees remain separate.
test('Every native managed attempt exposes one unchanged canonical lease reservation result and UsageSettlement across public views', { timeout: 120_000 }, () => {
	const f = actual(); verify(f); verifyGolden('settlement'); verifyGolden('reporter');
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
test('Actual participating provider availability retains closed accounting history and monotonic exact public observations beside unchanged terminal attempt charges', { timeout: 120_000 }, () => {
	const f = actual(), before = structuredClone(f), attempts = f.items.map(item => assignmentAttemptSchema.parse(item.assignmentAttempt));
	const providers = new Set(attempts.map(attempt => attempt.provider.providerId)), teamIds = new Set(attempts.map(attempt => attempt.teamId));
	assert.equal(teamIds.size, 1); const teamId = attempts[0]!.teamId;
	const all = availabilityHistory(f.team), participating = all.filter(session => typeof session.providerId === 'string' && providers.has(session.providerId));
	assert.ok(participating.some(session => session.status === 'closed'), 'ACCEPTANCE_AVAILABILITY_CLOSED: Actual retained closed publication required');
	verifyAvailabilityAccountingHistory(participating, providers, teamId);
	for (const session of participating) {
		const adapters = row(session.snapshot).adapters; assert.ok(Array.isArray(adapters) && adapters.length > 0);
		for (const adapter of adapters.map(row)) {
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
