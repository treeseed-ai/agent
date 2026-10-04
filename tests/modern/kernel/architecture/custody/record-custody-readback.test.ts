import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../provider-kernel-fixture.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody, verifyFailedExecutionCustody, verifyAvailabilityAccountingHistory, verifySandboxCloseoutCustody, verifyWorkdayContinuationCustody, verifyProviderLocalSlotClosure, verifyProviderPollingSelection } from '../../../../acceptance/workday/support/record-custody.ts';
import { row, type Row } from '../../../../acceptance/acceptance-cli.ts';

function supplied() {
	const items: Row[] = [], leases: Row[] = [], reservations: Row[] = [], settlements: Row[] = [], measurements: Row[] = [];
	for (const [index, status] of ['completed', 'failed'].entries()) {
		const original = request().assignment.assignmentAttempt; if (!original) throw new Error('Complete canonical attempt required');
		const at = '2026-09-13T12:00:01.000Z', attempt = assignmentAttemptSchema.parse({ ...original, id: `attempt-${index}`, idempotencyKey: `attempt-${index}`,
			leaseId: `lease-${index}`, reservationId: `reservation-${index}`, status, deadline: '2026-09-13T12:00:30.000Z' });
		const nativeUsage = { activeSeconds: 1, tokens: 7 };
		items.push({ id: attempt.id, attemptCount: attempt.attempt, teamId: attempt.teamId, projectId: attempt.projectId,
			membershipId: 'supplied-approved-membership', capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId,
			workDayId: attempt.workdayId, executionNodeId: attempt.nodeId, executionNodeRevision: attempt.nodeRevision, graphRevision: attempt.graphRevision,
			assignmentAttempt: attempt, assignmentResult: status === 'completed' ? assignmentResultSchema.parse({
			schemaVersion: 'treeseed.assignment-result/v1', id: `result-${index}`, assignmentId: attempt.id, status: 'completed', summary: 'Supplied custody input, not generated model usage.',
			references: [], verification: [], usage: { elapsedSeconds: 1, native: nativeUsage }, diagnostics: [], completedAt: at }) : null });
		leases.push({ schemaVersion: 'treeseed.lease/v1', id: attempt.leaseId, assignmentId: attempt.id, providerId: attempt.provider.providerId,
			state: 'released', acquiredAt: attempt.createdAt, expiresAt: attempt.deadline, releasedAt: at, revision: 1 });
		reservations.push({ schemaVersion: 'treeseed.reservation/v1', id: attempt.reservationId, assignmentId: attempt.id, workdayId: attempt.workdayId,
			providerId: attempt.provider.providerId, estimatedSeconds: attempt.estimate.expectedSeconds, state: 'consumed', reservedAt: attempt.createdAt, closedAt: at });
		settlements.push({ schemaVersion: 'treeseed.usage-settlement/v1', id: `settlement-${index}`, idempotencyKey: `settlement-${index}`, assignmentId: attempt.id,
			reservationId: attempt.reservationId, workdayId: attempt.workdayId, teamId: attempt.teamId, projectId: attempt.projectId, agentClass: attempt.agentClass,
			providerId: attempt.provider.providerId, actualSeconds: 1, nativeUsage, settledAt: at });
		measurements.push({ id: `measurement-${index}`, assignmentId: attempt.id, assignmentAttempt: attempt.attempt, projectId: attempt.projectId, workDayId: attempt.workdayId,
			accountingMode: 'aggregate', activeSeconds: 1, elapsedSeconds: 1, nativeUsage });
	}
	return { items, leases, reservations, settlements, measurements };
}
function check(f: ReturnType<typeof supplied>) { verifyTerminalRecordCustody(f.items, f.leases, f.reservations, f.settlements, f.measurements); }

describe('original provider polling selection custody', () => {
	const registered = ['busy-a', 'busy-b', 'quiet'].map(id => ({ id, teamId: `${id}-team` }));
	const original = () => ({ connectionId: 'quiet', selection: { id: 'quiet', input: {
		connections: registered.map(value => ({ connection: { id: value.id }, teamId: value.teamId })),
		snapshot: { claims: [], events: [], activeSecondsByConnection: { 'busy-a': 3, 'busy-b': 4, quiet: 0 } },
	} } });
	it('replays exact credential-free original global polling inputs without replacing them with a later terminal usage snapshot', () => {
		const owner = original(), before = structuredClone(owner), manifest = structuredClone(registered);
		const proof = verifyProviderPollingSelection(owner, registered);
		expect(proof).toEqual({ connectionId: 'quiet', teamId: 'quiet-team', eligibleTeams: registered.map(value => value.teamId), input: owner.selection.input });
		expect(owner).toEqual(before); expect(registered).toEqual(manifest);
		owner.selection.input.snapshot.activeSecondsByConnection.quiet = 9;
		expect(proof.input).toEqual(before.selection.input);
		expect(() => verifyProviderPollingSelection(owner, registered)).toThrow(/ACCEPTANCE_PROVIDER_SELECTION_FAIR/u);
	});
	it('denies absent reused foreign secret-bearing malformed and changed global choice inputs while preserving every supplied failed observation', () => {
		for (const mode of ['missing', 'empty', 'duplicate', 'foreign', 'winner', 'wrong-owner', 'secret', 'coerced', 'negative', 'infinite', 'missing-usage']) {
			const owner: Row = original(), selection = row(owner.selection), input = row(selection.input), snapshot = row(input.snapshot);
			const entries = input.connections; if (!Array.isArray(entries)) throw new Error('Original supplied eligible inventory required');
			if (mode === 'missing') delete owner.selection; if (mode === 'empty') input.connections = [];
			if (mode === 'duplicate') entries.push(structuredClone(entries[0]));
			if (mode === 'foreign') row(entries[0]).teamId = 'foreign-team';
			if (mode === 'winner') { selection.id = 'busy-a'; owner.connectionId = 'busy-a'; }
			if (mode === 'wrong-owner') owner.connectionId = 'busy-a';
			if (mode === 'secret') row(row(entries[0]).connection).accessToken = 'supplied-private-token-never-publish';
			if (mode === 'coerced') row(snapshot.activeSecondsByConnection)['busy-a'] = '3';
			if (mode === 'negative') row(snapshot.activeSecondsByConnection)['busy-a'] = -1;
			if (mode === 'infinite') row(snapshot.activeSecondsByConnection)['busy-a'] = Infinity;
			if (mode === 'missing-usage') delete snapshot.activeSecondsByConnection;
			const before = structuredClone(owner); let denied = false;
			try { verifyProviderPollingSelection(owner, registered); } catch { denied = true; }
			expect(denied, mode).toBe(true); expect(owner).toEqual(before);
		}
	});
});
function continuation() {
	const f = supplied(), parentId = 'workday-prior', childId = 'workday-next';
	for (const [index, item] of f.items.entries()) {
		const original = assignmentAttemptSchema.parse(item.assignmentAttempt);
		item.status = original.status; item.leaseState = 'released'; item.leaseToken = null; item.leaseExpiresAt = null; item.leaseRenewedAt = null;
		item.assignmentAttempt = assignmentAttemptSchema.parse({ ...original, workdayId: index === 0 ? parentId : childId,
			createdAt: index === 0 ? '2026-09-13T12:00:00.000Z' : '2026-09-13T12:00:03.000Z' });
	}
	const runs: Row[] = [{ id: childId, teamId: 'team-1', capacityProviderId: 'provider-1', executionMode: 'simulation', executionKind: 'workday', status: 'failed',
		startedAt: '2026-09-13T12:00:03.000Z', completedAt: '2026-09-13T12:00:04.000Z', parameters: { scheduledProjectIds: ['project-1'], decisionIds: ['decision-1'], continueFromWorkdayId: parentId } },
		{ id: parentId, teamId: 'team-1', capacityProviderId: 'provider-1', executionMode: 'simulation', executionKind: 'workday', status: 'completed',
			startedAt: '2026-09-13T12:00:00.000Z', completedAt: '2026-09-13T12:00:02.000Z', parameters: { scheduledProjectIds: ['project-1'] } }];
	return { runs, items: f.items };
}
function availability(): Row[] {
	return [10, 11].map((activeSeconds, index) => {
		const time = `2026-10-03T21:00:0${index}.000Z`, observed = { day: '2026-10-03', observedAt: time, healthy: true, activeSeconds, reservedSeconds: 2 };
		return { id: `session-${index}`, membershipId: `membership-${index}`, providerId: 'provider', teamId: 'team', sequence: 1,
			status: index === 0 ? 'closed' : 'open', openedAt: time, refreshedAt: time, expiresAt: '2026-10-03T21:01:30.000Z',
			snapshot: { adapters: [{ id: `renamed-adapter-${index}`, nativeLimits: { modelConfigurationId: 'shared-model', dailyActiveSecondsLimit: 120,
				capabilityLimits: { implementation: { dailyActiveSecondsLimit: 60 } } }, accountingObservation: {
					modelUsage: { ...observed }, capabilityUsage: { implementation: { ...observed } } } }] } };
	});
}
// UNIT of the exact managed record assertions. Canonical rows/measurements are
// supplied inputs, not native admission, producer completeness or live charges.
describe('whole canonical terminal record readback custody', () => {
	it('retains returned failed continuation history while denying an active assignment or retained lease without converting failure into a completed replay', () => {
		const f = continuation(), parent = f.items[0]!, original = assignmentAttemptSchema.parse(parent.assignmentAttempt);
		parent.status = 'returned'; parent.returnedAt = '2026-09-13T12:00:01.000Z';
		parent.assignmentAttempt = assignmentAttemptSchema.parse({ ...original, status: 'failed' });
		parent.assignmentResult = assignmentResultSchema.parse({ ...row(parent.assignmentResult), status: 'failed' });
		const before = structuredClone(f); expect(() => verifyWorkdayContinuationCustody(f.runs, f.items)).not.toThrow(); expect(f).toEqual(before);
		for (const mode of ['pending', 'leased', 'running', 'missing-status', 'missing-lease', 'leased-state', 'token', 'expiry', 'renewal']) {
			const input = structuredClone(f), item = input.items[0]!;
			if (['pending', 'leased', 'running'].includes(mode)) item.status = mode;
			if (mode === 'missing-status') delete item.status; if (mode === 'missing-lease') delete item.leaseState;
			if (mode === 'leased-state') item.leaseState = 'leased'; if (mode === 'token') item.leaseToken = 'retained';
			if (mode === 'expiry') item.leaseExpiresAt = original.deadline; if (mode === 'renewal') item.leaseRenewedAt = original.createdAt;
			const held = structuredClone(input); expect(() => verifyWorkdayContinuationCustody(input.runs, input.items)).toThrow(/ACCEPTANCE_CONTINUATION_UNSETTLED/u);
			expect(input).toEqual(held);
		}
	});
	it('requires exact local terminal slot history and denies retained renamed foreign duplicate or missing custody without disclosing or changing supplied state', () => {
		const f = supplied(), connection = { id: 'configured-renamed-connection', providerId: 'provider-1', teamId: 'team-1', membershipId: 'supplied-approved-membership' };
		const events = f.items.flatMap((item, index) => [
			{ id: `leased-${index}`, claimId: `claim-${index}`, connectionId: connection.id, assignmentId: item.id, outcome: 'leased', recordedAt: '2026-09-13T12:00:00.000Z' },
			{ id: `terminal-${index}`, claimId: `claim-${index}`, connectionId: connection.id, assignmentId: item.id, outcome: 'terminal-receipt-confirmed', recordedAt: '2026-09-13T12:00:02.000Z' }]);
		const state = { schemaVersion: 1, revision: 2, claims: [], events }, before = structuredClone({ state, items: f.items, connection });
		expect(verifyProviderLocalSlotClosure(f.items, [connection], state).map(item => item.assignmentId)).toEqual(f.items.map(item => item.id));
		expect({ state, items: f.items, connection }).toEqual(before);
		for (const mode of ['missing-claims', 'missing-events', 'revision', 'active', 'renamed-claim', 'foreign-connection', 'foreign-membership',
			'duplicate-owner', 'duplicate-terminal', 'duplicate-event', 'missing-lease', 'missing-terminal', 'unknown-terminal', 'foreign-claim', 'reused-claim', 'clock', 'numeric-clock', 'malformed-claim']) {
			const changedEvents = structuredClone(events), input: Row = { ...structuredClone(state), events: changedEvents }, owners = [structuredClone(connection)];
			if (mode === 'missing-claims') delete input.claims; if (mode === 'missing-events') delete input.events; if (mode === 'revision') input.revision = '2';
			if (mode === 'active') input.claims = [{ id: 'claim-0', connectionId: connection.id, assignmentId: f.items[0]!.id, status: 'recovery' }];
			if (mode === 'renamed-claim') input.claims = [{ id: 'claim-0', connectionId: connection.id, assignmentId: 'foreign', status: 'ready' }];
			if (mode === 'malformed-claim') input.claims = [null];
			if (mode === 'foreign-connection') changedEvents[1]!.connectionId = 'foreign';
			if (mode === 'foreign-membership') owners[0]!.membershipId = 'foreign'; if (mode === 'duplicate-owner') owners.push(structuredClone(connection));
			if (mode === 'duplicate-terminal') changedEvents.push({ ...changedEvents[1]!, id: 'extra-terminal' });
			if (mode === 'duplicate-event') changedEvents.push(structuredClone(changedEvents[1]!));
			if (mode === 'missing-lease') changedEvents.splice(0, 1); if (mode === 'missing-terminal') changedEvents.splice(1, 1);
			if (mode === 'unknown-terminal') changedEvents[1]!.outcome = 'authoritative-unknown';
			if (mode === 'foreign-claim') changedEvents[1]!.claimId = 'foreign'; if (mode === 'clock') changedEvents[1]!.recordedAt = '2026-09-12T12:00:00.000Z';
			if (mode === 'reused-claim') { changedEvents[2]!.claimId = 'claim-0'; changedEvents[3]!.claimId = 'claim-0'; }
			if (mode === 'numeric-clock') input.events = changedEvents.map((event, index) => index === 1 ? { ...event, recordedAt: Date.parse(event.recordedAt) } : event);
			const held = structuredClone({ input, owners }); expect(() => verifyProviderLocalSlotClosure(f.items, owners, input)).toThrow(/ACCEPTANCE_PROVIDER_LOCAL/u);
			expect({ input, owners }).toEqual(held);
		}
	});
	it('retains exact public continuation ancestry source and executed Decision custody with distinct unchanged original attempts and results', () => {
		const f = continuation(), before = structuredClone(f); expect(() => verifyWorkdayContinuationCustody(f.runs, f.items)).not.toThrow(); expect(f).toEqual(before);
	});
	it('denies incomplete cyclic foreign expanded stale and reused public continuation evidence without repairing prior failed history', () => {
		for (const mode of ['empty', 'tail', 'cycle', 'team', 'provider', 'mode', 'missing-mode', 'active', 'kind', 'expanded', 'missing-projects',
			'missing-decisions', 'foreign-decision', 'early-start', 'missing-clock', 'numeric-clock', 'reused-attempt', 'reused-result', 'orphan', 'missing-parent-attempt', 'moved-source', 'moved-decision', 'missing-authority']) {
			const f = continuation(), child = f.runs[0]!, parent = f.runs[1]!, attempt = row(f.items[1]!.assignmentAttempt);
			if (mode === 'empty') f.runs.length = 0; if (mode === 'tail') row(parent.parameters).continueFromWorkdayId = 'missing-root';
			if (mode === 'cycle') parent.id = child.id; if (mode === 'team') parent.teamId = 'foreign'; if (mode === 'provider') parent.capacityProviderId = 'foreign';
			if (mode === 'mode') parent.executionMode = 'production'; if (mode === 'missing-mode') { delete child.executionMode; delete parent.executionMode; }
			if (mode === 'active') parent.status = 'running'; if (mode === 'kind') parent.executionKind = 'conversation';
			if (mode === 'expanded') row(child.parameters).scheduledProjectIds = ['project-1', 'foreign']; if (mode === 'missing-projects') delete row(child.parameters).scheduledProjectIds;
			if (mode === 'missing-decisions') delete row(child.parameters).decisionIds; if (mode === 'foreign-decision') row(child.parameters).decisionIds = ['unexecuted-decision'];
			if (mode === 'early-start') child.startedAt = '2026-09-13T12:00:01.999Z'; if (mode === 'missing-clock') delete parent.completedAt;
			if (mode === 'numeric-clock') parent.completedAt = Date.parse('2026-09-13T12:00:02.000Z');
			if (mode === 'reused-attempt') { f.items[1]!.id = f.items[0]!.id; attempt.id = f.items[0]!.id; }
			if (mode === 'reused-result') f.items[1]!.assignmentResult = { ...row(f.items[0]!.assignmentResult), assignmentId: f.items[1]!.id };
			if (mode === 'orphan') attempt.workdayId = 'foreign'; if (mode === 'missing-parent-attempt') f.items.shift();
			if (mode === 'moved-source') row(attempt.sourceRef).revision = 2;
			if (mode === 'moved-decision') { const refs = attempt.authorityRefs; if (!Array.isArray(refs)) throw new Error('Supplied exact authority refs required'); row(refs[0]).digest = `sha256:${'f'.repeat(64)}`; }
			if (mode === 'missing-authority') attempt.authorityRefs = [];
			const before = structuredClone(f); expect(() => verifyWorkdayContinuationCustody(f.runs, f.items)).toThrow(); expect(f).toEqual(before);
		}
	});
	it('retains distinct completed and failed public sandbox closeout without treating an empty Reporter scope as physical isolation', () => {
		const f = supplied();
		for (const [index, item] of f.items.entries()) {
			item.status = index === 0 ? 'completed' : 'failed'; item.completedAt = index === 0 ? '2026-09-13T12:00:02.000Z' : null;
			item.failedAt = index === 1 ? '2026-09-13T12:00:02.000Z' : null;
			item.capacityEnvelope = { budget: { time: { executionStartedAt: '2026-09-13T12:00:00.000Z' } } };
			item.lifecycleOutput = { sandboxId: `owned-sandbox-${index}`, teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } };
		}
		f.items.push({ id: 'empty-reporter-scope', lifecycleOutput: { teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } } });
		const before = structuredClone(f); expect(() => verifySandboxCloseoutCustody(f.items)).not.toThrow(); expect(f).toEqual(before);
		for (const status of ['returned', 'cancelled', 'expired'] as const) {
			const changed = structuredClone(f), failed = changed.items[1]!;
			failed.status = status; failed.failedAt = null;
			failed[status === 'returned' ? 'returnedAt' : status === 'cancelled' ? 'cancelledAt' : 'expiredAt'] = '2026-09-13T12:00:02.000Z';
			const exact = structuredClone(changed); expect(() => verifySandboxCloseoutCustody(changed.items)).not.toThrow(); expect(changed).toEqual(exact);
		}
		// Supplied custody inputs, not a broker allocation or physical absence.
	});
	it('denies missing coerced reused foreign and outside-lifecycle sandbox closeout without repairing failed public history', () => {
		for (const mode of ['empty', 'owner', 'sandbox', 'missing-sandbox', 'reused', 'receipt', 'false', 'coerced', 'missing-clock', 'number-clock', 'malformed-clock',
			'before-start', 'after-terminal', 'missing-terminal', 'active', 'foreign-result', 'late-canonical-result', 'late-output-result', 'foreign-failed-result', 'malformed-failed-result']) {
			const f = supplied();
			for (const [index, item] of f.items.entries()) {
				item.status = index === 0 ? 'completed' : 'failed'; item.completedAt = index === 0 ? '2026-09-13T12:00:02.000Z' : null;
				item.failedAt = index === 1 ? '2026-09-13T12:00:02.000Z' : null;
				item.capacityEnvelope = { budget: { time: { executionStartedAt: '2026-09-13T12:00:00.000Z' } } };
				item.lifecycleOutput = { sandboxId: `owned-sandbox-${index}`, teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } };
			}
			const item = f.items[0]!, output = row(item.lifecycleOutput), teardown = row(output.teardown);
			if (mode === 'empty') f.items.length = 0; if (mode === 'owner') item.id = 'foreign'; if (mode === 'sandbox') output.sandboxId = '';
			if (mode === 'missing-sandbox') delete output.sandboxId;
			if (mode === 'reused') row(f.items[1]!.lifecycleOutput).sandboxId = output.sandboxId;
			if (mode === 'receipt') delete output.teardown; if (mode === 'false') teardown.verified = false; if (mode === 'coerced') teardown.verified = 'true';
			if (mode === 'missing-clock') delete teardown.completedAt; if (mode === 'number-clock') teardown.completedAt = Date.parse('2026-09-13T12:00:01.000Z');
			if (mode === 'malformed-clock') teardown.completedAt = 'invalid'; if (mode === 'before-start') teardown.completedAt = '2026-09-13T11:59:59.999Z';
			if (mode === 'after-terminal') teardown.completedAt = '2026-09-13T12:00:02.001Z'; if (mode === 'missing-terminal') delete item.completedAt;
			if (mode === 'active') item.status = 'running'; if (mode === 'foreign-result') row(item.assignmentResult).assignmentId = 'foreign';
			if (mode === 'late-canonical-result' || mode === 'late-output-result' || mode === 'foreign-failed-result') {
				const failed = f.items[1]!, lateResult = { ...row(item.assignmentResult), assignmentId: failed.id };
				if (mode === 'foreign-failed-result') { lateResult.assignmentId = 'foreign'; Object.assign(lateResult, { status: 'failed' }); }
				if (mode === 'late-output-result') row(failed.lifecycleOutput).assignmentResult = lateResult; else failed.assignmentResult = lateResult;
			}
			if (mode === 'malformed-failed-result') f.items[1]!.assignmentResult = { status: 'failed' };
			const before = structuredClone(f); expect(() => verifySandboxCloseoutCustody(f.items)).toThrow(); expect(f).toEqual(before);
		}
	});
	it('retains exact public shared model and capability accounting across closed memberships renamed adapters and legitimate UTC rollover', () => {
		const sessions = availability(), before = structuredClone(sessions);
		expect(() => verifyAvailabilityAccountingHistory(sessions, new Set(['provider']), 'team')).not.toThrow(); expect(sessions).toEqual(before);
		const rollover = structuredClone(sessions), latest = rollover[1]!;
		latest.openedAt = latest.refreshedAt = '2026-10-04T00:00:00.000Z'; latest.expiresAt = '2026-10-04T00:01:30.000Z';
		const adapters = row(latest.snapshot).adapters;
		if (!Array.isArray(adapters)) throw new Error('Supplied original adapter inventory required');
		const observation = row(row(adapters[0]).accountingObservation);
		for (const value of [row(observation.modelUsage), row(row(observation.capabilityUsage).implementation)]) Object.assign(value,
			{ day: '2026-10-04', observedAt: latest.refreshedAt, activeSeconds: 0 });
		const changed = structuredClone(rollover); expect(() => verifyAvailabilityAccountingHistory(rollover, new Set(['provider']), 'team')).not.toThrow(); expect(rollover).toEqual(changed);
	});
	it('denies malformed health clocks usage scopes and reset public availability history without repairing original observations', () => {
		for (const failure of ['team', 'provider', 'missing-provider', 'duplicate', 'sequence', 'clock', 'model-regression', 'capability-regression',
			'health', 'coerced', 'negative', 'day', 'future', 'missing-capability', 'missing-adapters']) {
			const sessions = availability(), latest = sessions[1]!, adapters = row(latest.snapshot).adapters;
			if (!Array.isArray(adapters)) throw new Error('Supplied original adapter inventory required');
			const observation = row(row(adapters[0]).accountingObservation), model = row(observation.modelUsage), capability = row(row(observation.capabilityUsage).implementation);
			if (failure === 'team') latest.teamId = 'foreign'; if (failure === 'provider') latest.providerId = 'foreign';
			if (failure === 'duplicate') sessions.push(structuredClone(latest)); if (failure === 'sequence') latest.sequence = '1';
			if (failure === 'clock') latest.refreshedAt = 'invalid'; if (failure === 'model-regression') model.activeSeconds = 9;
			if (failure === 'capability-regression') capability.activeSeconds = 9; if (failure === 'health') model.healthy = 'true';
			if (failure === 'coerced') model.activeSeconds = '11'; if (failure === 'negative') capability.reservedSeconds = -1;
			if (failure === 'day') model.day = '2026-10-04'; if (failure === 'future') model.observedAt = '2026-10-03T21:00:02.000Z';
			if (failure === 'missing-capability') delete row(observation.capabilityUsage).implementation;
			if (failure === 'missing-adapters') row(latest.snapshot).adapters = [];
			const before = structuredClone(sessions), providers = new Set(failure === 'missing-provider' ? ['provider', 'absent-provider'] : ['provider']);
			expect(() => verifyAvailabilityAccountingHistory(sessions, providers, 'team')).toThrow(); expect(sessions).toEqual(before);
		}
	});
	it('binds failed productive closeout to its exact zero-charge diagnostic and distinct terminal native measurement', () => {
		const f = supplied(), item = f.items[1]!, attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		item.status = 'failed'; item.failedAt = '2026-09-13T12:00:02.000Z';
		item.capacityEnvelope = { budget: { time: { executionStartedAt: attempt.createdAt } } };
		item.lifecycleOutput = { sandboxId: 'own-failed-sandbox', teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } };
		const aggregate = f.measurements[1]!;
		Object.assign(aggregate, { idempotencyKey: 'aggregate-key', usageDimension: 'aggregate', capacityProviderId: attempt.provider.providerId, inputTokens: 7 });
		f.measurements.push({ ...structuredClone(aggregate), id: 'failed-diagnostic', idempotencyKey: 'diagnostic-key', usageDimension: 'diagnostic-0',
			accountingMode: 'informational', activeSeconds: 0, elapsedSeconds: 0 });
		const before = structuredClone(f);
		expect(() => verifyFailedExecutionCustody(f.items, f.measurements)).not.toThrow(); expect(f).toEqual(before);
		const outcomes = [];
		for (const mode of ['missing-output', 'missing-sandbox', 'unverified', 'missing-close', 'late-close', 'missing-diagnostic', 'duplicate-diagnostic',
			'orphan', 'charge', 'elapsed-charge', 'native', 'tokens', 'ordinal', 'provider', 'project', 'workday', 'reused-id', 'reused-key', 'empty-native']) {
			const changed = structuredClone(f), failed = changed.items[1]!, diagnostic = changed.measurements[2]!, output = row(failed.lifecycleOutput);
			if (mode === 'missing-output') delete failed.lifecycleOutput;
			if (mode === 'missing-sandbox') delete output.sandboxId;
			if (mode === 'unverified') row(output.teardown).verified = false;
			if (mode === 'missing-close') delete row(output.teardown).completedAt;
			if (mode === 'late-close') row(output.teardown).completedAt = '2026-09-13T12:00:02.001Z';
			if (mode === 'missing-diagnostic') changed.measurements.pop();
			if (mode === 'duplicate-diagnostic') changed.measurements.push({ ...diagnostic, id: 'duplicate', idempotencyKey: 'duplicate-key' });
			if (mode === 'orphan') diagnostic.assignmentId = 'unrepresented';
			if (mode === 'charge') diagnostic.activeSeconds = 1;
			if (mode === 'elapsed-charge') diagnostic.elapsedSeconds = 1;
			if (mode === 'native') diagnostic.nativeUsage = { tokens: 8 };
			if (mode === 'tokens') diagnostic.inputTokens = 8;
			if (mode === 'ordinal') diagnostic.assignmentAttempt = attempt.attempt + 1;
			if (mode === 'provider') diagnostic.capacityProviderId = 'foreign';
			if (mode === 'project') diagnostic.projectId = 'foreign';
			if (mode === 'workday') diagnostic.workDayId = 'foreign';
			if (mode === 'reused-id') diagnostic.id = changed.measurements[1]!.id;
			if (mode === 'reused-key') diagnostic.idempotencyKey = changed.measurements[1]!.idempotencyKey;
			if (mode === 'empty-native') { diagnostic.nativeUsage = {}; changed.measurements[1]!.nativeUsage = {}; }
			const mutated = structuredClone(changed); let denied = false;
			try { verifyFailedExecutionCustody(changed.items, changed.measurements); } catch { denied = true; }
			outcomes.push(denied); expect(changed).toEqual(mutated);
		}
		expect(outcomes).toEqual(Array(19).fill(true));
	});
	it('retains supplied completed and failed attempts with one distinct canonical lease reservation result and settlement each', () => {
		const f = supplied(), before = structuredClone(f); expect(() => check(f)).not.toThrow(); expect(f).toEqual(before);
		const optional = supplied();
		for (const settlement of optional.settlements) Object.assign(settlement, { cost: 0, currency: 'USD' });
		optional.settlements[0]!.id = 's'.repeat(200); optional.settlements[0]!.idempotencyKey = 'k'.repeat(200);
		optional.leases[0]!.revision = 2;
		// Provider-native counters may be fractional; fairness seconds remain
		// the original integral seconds. Neither unit is converted into the other.
		for (const [index, settlement] of optional.settlements.entries()) {
			const native = { tokens: 7.5, providerSeconds: 0.25 };
			settlement.nativeUsage = structuredClone(native); optional.measurements[index]!.nativeUsage = structuredClone(native);
			const result = optional.items[index]!.assignmentResult;
			if (result) row(row(result).usage).native = structuredClone(native);
		}
		const exact = structuredClone(optional); expect(() => check(optional)).not.toThrow(); expect(optional).toEqual(exact);
	});
	it('denies absent canonical records and never upgrades a legacy ledger or metadata settlement key into a UsageSettlement', () => {
		const outcomes = ['lease', 'reservation', 'settlement', 'legacy'].map(mode => { const f = supplied();
			if (mode === 'lease') f.leases.pop(); if (mode === 'reservation') f.reservations.pop(); if (mode === 'settlement') f.settlements.pop();
			if (mode === 'legacy') f.settlements[0] = { id: 'legacy-ledger', settlementKey: 'present', assignmentId: f.items[0]!.id, activeSeconds: 1, metadata: { settlementKey: 'present' } };
			try { check(f); return 'admitted'; } catch { return 'denied'; }
		}); expect(outcomes).toEqual(Array(4).fill('denied'));
	});
	it('denies duplicate settlement identities reused keys and conflicting copies across public views without rewriting any evidence', () => {
		const outcomes = ['duplicate', 'key', 'view'].map(mode => { const f = supplied(), before = structuredClone(f);
			if (mode === 'duplicate') f.settlements.push(structuredClone(f.settlements[0]!));
			if (mode === 'key') f.settlements[1]!.idempotencyKey = f.settlements[0]!.idempotencyKey;
			let admitted = false; const mutated = structuredClone(f);
			try { if (mode === 'view') publicCanonicalRecords([f.settlements, [{ ...f.settlements[0], actualSeconds: 2 }]], 'treeseed.usage-settlement/v1'); else check(f); admitted = true; } catch { /* Deliberate supplied contradiction. */ }
			expect(f).toEqual(mode === 'view' ? before : mutated); return admitted;
		}); expect(outcomes).toEqual([false, false, false]);
		const f = supplied(); expect(publicCanonicalRecords([f.settlements, structuredClone(f.settlements)], 'treeseed.usage-settlement/v1')).toEqual(f.settlements);
	});
	it('denies foreign assignment reservation workday team project provider and class joins against the same immutable attempt', () => {
		for (const field of ['teamId', 'projectId', 'capacityProviderId', 'executionProviderId', 'workDayId', 'executionNodeId', 'executionNodeRevision', 'graphRevision', 'membershipId']) {
			for (const value of [undefined, null, '', 'foreign-or-coerced', 7]) {
				// Membership is an independent public identity, not present on the
				// frozen attempt; its foreign ownership is checked against the real
				// configured connection by the managed manifest acceptance.
				if (field === 'membershipId' && value === 'foreign-or-coerced') continue;
				const f = supplied(); if (value === undefined) delete f.items[0]![field]; else f.items[0]![field] = value;
				const before = structuredClone(f); expect(() => check(f)).toThrow(); expect(f).toEqual(before);
			}
		}
		const fields = ['assignmentId', 'reservationId', 'workdayId', 'teamId', 'projectId', 'providerId', 'agentClass'];
		const outcomes = fields.map(field => { const f = supplied(); f.settlements[0]![field] = 'foreign'; const before = structuredClone(f);
			let admitted = false; try { check(f); admitted = true; } catch { /* Supplied foreign authority. */ } expect(f).toEqual(before); return admitted; });
		expect(outcomes).toEqual(fields.map(() => false));
		// Frozen authority is already canonical. A successful SDK parse must not
		// silently repair supplied identities before the custody comparison.
		for (const path of [['idempotencyKey'], ['nodeId'], ['sourceRef', 'id'], ['authorityRefs', 'id'],
			['effectiveProfile', 'profileRef', 'id'], ['provider', 'offerId'], ['provider', 'executionProviderId'],
			['provider', 'modelConfigurationId'], ['provider', 'executionCapabilityId']]) {
			const f = supplied(); let target = row(f.items[0]!.assignmentAttempt);
			for (const field of path.slice(0, -1)) { const value = target[field]; target = row(Array.isArray(value) ? value[0] : value); }
			const field = path.at(-1)!; expect(typeof target[field]).toBe('string'); target[field] = ` ${target[field]} `;
			const before = structuredClone(f); expect(() => check(f), path.join('.')).toThrow(); expect(f).toEqual(before);
		}
		for (const field of ['id', 'assignmentId']) {
			const f = supplied(), result = row(f.items[0]!.assignmentResult); result[field] = ` ${result[field]} `;
			const before = structuredClone(f); expect(() => check(f), `result.${field}`).toThrow(); expect(f).toEqual(before);
		}
	});
	it('denies coerced negative nonfinite missing and extra settlement facts using the unchanged exact canonical target', () => {
		const mutations = [{ actualSeconds: '1' }, { actualSeconds: -1 }, { actualSeconds: Infinity }, { nativeUsage: { tokens: '7' } },
			{ nativeUsage: { tokens: -1 } }, { nativeUsage: { tokens: NaN } }, { settledAt: 'invalid' }, { settledAt: '2026-09-13T11:59:59.999Z' },
			{ assignmentAttempt: 1 }, { cost: -1 }, { currency: 'usd' }];
		const outcomes = mutations.map(change => { const f = supplied(); Object.assign(f.settlements[0]!, change); const before = structuredClone(f);
			let admitted = false; try { check(f); admitted = true; } catch { /* Supplied malformed fact. */ } expect(f).toEqual(before); return admitted; });
		expect(outcomes).toEqual(mutations.map(() => false));
		const root = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
		expect(typeof root).toBe('string'); if (!root) throw new Error('Exact existing canonical authority required');
		const target = row(row(parse(readFileSync(resolve(root, 'docs/agent.schema.yml'), 'utf8'))).$defs);
		for (const [name, field] of [['Lease', 'leases'], ['Reservation', 'reservations'], ['UsageSettlement', 'settlements']] as const) {
			const required = row(target[name]).required; expect(Array.isArray(required)).toBe(true);
			if (!Array.isArray(required)) throw new Error('Canonical required fields unavailable');
			for (const key of required) {
				if (typeof key !== 'string') throw new Error('Canonical field name malformed');
				for (const missing of ['absent', 'undefined', 'null'] as const) {
					const changed = supplied(), record = changed[field][0]!;
					if (missing === 'absent') delete record[key]; else record[key] = missing === 'null' ? null : undefined;
					const retained = structuredClone(changed); expect(() => check(changed), `${name}.${key}:${missing}`).toThrow(); expect(changed).toEqual(retained);
				}
			}
			for (const extra of ['legacyState', 'assignmentPlan', 'handlerOutput']) {
				const changed = supplied(); changed[field][0]![extra] = {};
				const retained = structuredClone(changed); expect(() => check(changed), `${name}.${extra}`).toThrow(); expect(changed).toEqual(retained);
			}
		}
		for (const change of [{ id: 's'.repeat(201) }, { id: ' invalid ' }, { id: 'é' }, { agentClass: 'UpperCase' },
			{ agentClass: 'a'.repeat(101) }, { actualSeconds: 0.5 }, { actualSeconds: NaN }, { cost: '0' }, { cost: Infinity },
			{ currency: 'US' }, { currency: 'USDD' }, { currency: 840 }, { nativeUsage: [] }, { nativeUsage: null },
			{ nativeUsage: { tokens: Infinity } }, { settledAt: '2026-09-13T12:00:01' }, { settledAt: '2026-02-30T12:00:01.000Z' }]) {
			const changed = supplied(); Object.assign(changed.settlements[0]!, change);
			const retained = structuredClone(changed); expect(() => check(changed)).toThrow(); expect(changed).toEqual(retained);
		}
	});
	it('denies foreign duplicate active and reversed-clock lease or reservation authority for a terminal attempt', () => {
		const modes = ['lease-id', 'lease-provider', 'lease-active', 'lease-clock', 'lease-revision', 'lease-duplicate', 'reservation-id', 'reservation-provider', 'reservation-workday', 'reservation-held', 'reservation-duplicate'];
		const outcomes = modes.map(mode => { const f = supplied(), lease = f.leases[0]!, reservation = f.reservations[0]!;
			if (mode === 'lease-id') lease.id = 'foreign'; if (mode === 'lease-provider') lease.providerId = 'foreign'; if (mode === 'lease-active') lease.state = 'active';
			if (mode === 'lease-clock') lease.acquiredAt = '2026-09-13T12:00:31.000Z'; if (mode === 'lease-revision') lease.revision = 0;
			if (mode === 'lease-duplicate') f.leases.push(structuredClone(lease));
			if (mode === 'reservation-id') reservation.id = 'foreign'; if (mode === 'reservation-provider') reservation.providerId = 'foreign';
			if (mode === 'reservation-workday') reservation.workdayId = 'foreign'; if (mode === 'reservation-held') reservation.state = 'held';
			if (mode === 'reservation-duplicate') f.reservations.push(structuredClone(reservation));
			try { check(f); return 'admitted'; } catch { return 'denied'; }
		}); expect(outcomes).toEqual(modes.map(() => 'denied'));
	});
	it('denies missing foreign or mismatched aggregate and result usage without discarding the failed predecessor attempt', () => {
		const outcomes = ['missing', 'ordinal', 'project', 'seconds', 'native', 'result'].map(mode => { const f = supplied();
			if (mode === 'missing') f.measurements.pop(); if (mode === 'ordinal') f.measurements[0]!.assignmentAttempt = 2;
			if (mode === 'project') f.measurements[0]!.projectId = 'foreign'; if (mode === 'seconds') f.measurements[0]!.activeSeconds = 0;
			if (mode === 'native') f.measurements[0]!.nativeUsage = { activeSeconds: 1, tokens: 8 };
			if (mode === 'result') f.items[0]!.assignmentResult = { ...row(f.items[0]!.assignmentResult), assignmentId: 'foreign' };
			const before = structuredClone(f); let admitted = false; try { check(f); admitted = true; } catch { /* Supplied contradictory readback. */ }
			expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(Array(6).fill(false));
	});
	it('denies orphan aggregate rows and reused measurement identities even when every terminal attempt has a matching charge', () => {
		for (const mode of ['orphan', 'identity', 'duplicate-aggregate']) {
			const f = supplied();
			if (mode === 'orphan') f.measurements.push({ ...f.measurements[0], id: 'orphan-measurement', assignmentId: 'unrepresented-attempt' });
			if (mode === 'identity') f.measurements[1]!.id = f.measurements[0]!.id;
			if (mode === 'duplicate-aggregate') f.measurements.push({ ...f.measurements[0], id: 'second-aggregate' });
			const before = structuredClone(f);
			expect(() => check(f), mode).toThrow();
			expect(f).toEqual(before);
		}
	});
	it('validates every supplied failed result against its own immutable attempt and measured usage without replacing failed history', () => {
		const f = supplied(), failed = f.items[1]!;
		failed.assignmentResult = assignmentResultSchema.parse({ ...row(f.items[0]!.assignmentResult), id: 'failed-result', assignmentId: failed.id, status: 'failed' });
		const before = structuredClone(f);
		expect(() => check(f)).not.toThrow();
		expect(f).toEqual(before);
		for (const mode of ['assignment', 'status', 'elapsed', 'native', 'malformed']) {
			const changed = structuredClone(f), result = row(changed.items[1]!.assignmentResult);
			if (mode === 'assignment') result.assignmentId = changed.items[0]!.id;
			if (mode === 'status') result.status = 'completed';
			if (mode === 'elapsed') row(result.usage).elapsedSeconds = 2;
			if (mode === 'native') row(result.usage).native = { activeSeconds: 1, tokens: 8 };
			if (mode === 'malformed') delete result.completedAt;
			const immutable = structuredClone(changed);
			expect(() => check(changed), mode).toThrow();
			expect(changed).toEqual(immutable);
		}
	});
	it('denies reused result identities and result clocks outside the recorded productive interval while retaining distinct failed results', () => {
		const f = supplied();
		for (const item of f.items) {
			item.assignmentAttempt = assignmentAttemptSchema.parse({ ...row(item.assignmentAttempt), startedAt: '2026-09-13T12:00:00.000Z', finishedAt: '2026-09-13T12:00:01.000Z' });
		}
		f.items[1]!.assignmentResult = assignmentResultSchema.parse({ ...row(f.items[0]!.assignmentResult), id: 'distinct-failed-result', assignmentId: f.items[1]!.id, status: 'failed' });
		expect(() => check(f)).not.toThrow();
		for (const mode of ['identity', 'before-start', 'after-finish', 'failed-before-start', 'failed-after-finish']) {
			const changed = structuredClone(f), result = row(changed.items[mode.startsWith('failed-') ? 1 : 0]!.assignmentResult);
			if (mode === 'identity') row(changed.items[1]!.assignmentResult).id = result.id;
			else result.completedAt = mode.endsWith('before-start') ? '2026-09-13T11:59:59.999Z' : '2026-09-13T12:00:01.001Z';
			const immutable = structuredClone(changed);
			expect(() => check(changed), mode).toThrow();
			expect(changed).toEqual(immutable);
		}
	});
	it('denies terminal lease and reservation closure clocks preceding their own acquisition without inventing settlement after completion', () => {
		for (const mode of ['lease-release', 'reservation-close']) {
			const f = supplied();
			if (mode === 'lease-release') f.leases[0]!.releasedAt = '2026-09-13T11:59:59.999Z';
			if (mode === 'reservation-close') f.reservations[0]!.closedAt = '2026-09-13T11:59:59.999Z';
			const immutable = structuredClone(f);
			expect(() => check(f), mode).toThrow();
			expect(f).toEqual(immutable);
		}
	});
});
