import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { orderConnectionsForFairPolling } from '../../../../src/provider/teams/multi-team-runtime.ts';
import { capacityFixture } from './capacity-fixture.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { verifyProviderLocalSlotClosure } from '../../../acceptance/workday/support/record-custody.ts';
import type { Row } from '../../../acceptance/acceptance-cli.ts';

// Real files, lock/atomic rename, independent Node processes and actual wall
// clocks. Frozen clocks/grants are fixture inputs, NOT API time, native model
// charges, real control-plane authentication or physical sandbox closure.
describe('document-wide native provider capacity custody', () => {
	it('native valid zero model and capability ceilings refuse concurrent positive reservations after failed measured execution without replacing polling or accounting custody', async () => {
		const f = await capacityFixture();
		try {
			const prior = await f.store.claim({ connectionId: 'measured-prior-team', globalLimit: 2, connectionLimit: 1 });
			if (!prior) throw new Error('Original native measurement slot required');
			const original = f.lease('measured-prior-attempt');
			await f.store.attachLease(prior.id, original); await f.store.claimDispatch(prior.id); await f.store.beginActiveExecution(prior.id);
			await delay(5); await f.store.finishActiveExecution(prior.id);
			await f.store.recordFailure(prior.id, 'original native zero-quota failure history');
			await f.store.finalize(prior.id, 'native-accounted-terminal-confirmed');
			const history = await f.reopen().snapshot(); expect(history.claims).toEqual([]);
			expect(history.activeSecondsByConnection['measured-prior-team']).toBeGreaterThan(0);
			const claims = [];
			for (const connectionId of ['quota-team-a', 'quota-team-b']) {
				const claim = await f.store.claim({ connectionId, globalLimit: 2, connectionLimit: 1 });
				if (!claim) throw new Error('Original native polling slot required'); claims.push(claim);
			}
			const before = await f.bytes(), originalLease = structuredClone(original);
			for (const scope of ['model', 'capability'] as const) {
				const outcomes = await Promise.all(claims.map(async (claim, index) => {
					const input = f.lease(`zero-quota-${index}`);
					Object.assign(input.accounting, scope === 'model' ? { dailyActiveSecondsLimit: 0 } : { capabilityDailyActiveSecondsLimit: 0 });
					const saved = structuredClone(input); let cause: unknown;
					try { await f.reopen().attachLease(claim.id, input); } catch (error) { cause = error; }
					expect(input).toEqual(saved); return cause;
				}));
				for (const cause of outcomes) {
					expect(cause).toBeInstanceOf(Error);
					expect(String(cause)).toBe('Error: Provider-local daily active-time capacity is exhausted.');
				}
				expect(await f.bytes()).toBe(before);
			}
			expect(original).toEqual(originalLease);
			const after = await f.reopen().snapshot();
			expect(after.claims.map(value => ({ id: value.id, status: value.status })))
				.toEqual(claims.map(value => ({ id: value.id, status: 'polling' })));
			expect(after.activeSecondsByConnection).toEqual(history.activeSecondsByConnection); expect(after.events).toEqual(history.events);
			expect(await f.entries()).toEqual(['capacity-state.json']);
			// Actual owning store, native files, locks and measured failed history.
			// Polling alone is not productive admission; no stricter no-HTTP
			// contract, external quota increase, model charge or Kata proof.
		} finally { await f.close(); }
	});
	it('native terminal slot history survives restart concurrent finalization and failed closeout without retained local reservations or a duplicate terminal event', async () => {
		const f = await capacityFixture(); try {
			const items: Row[] = [], connections: Array<{ id: string; providerId: string; teamId: string; membershipId: string }> = [],
				claims: Array<NonNullable<Awaited<ReturnType<typeof f.store.claim>>>> = [];
			for (const [index, status] of ['completed', 'failed'].entries()) {
				const connectionId = `original-local-owner-${index}`, claim = await f.store.claim({ connectionId, globalLimit: 2, connectionLimit: 1 });
				if (!claim) throw new Error('Original allocated local slot required');
				const lease = f.lease(`local-attempt-${index}`), attempt = assignmentAttemptSchema.parse(lease.dispatchEnvelope.assignment.assignmentAttempt);
				claims.push(claim); connections.push({ id: connectionId, providerId: attempt.provider.providerId, teamId: attempt.teamId, membershipId: `membership-${index}` });
				await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id); await f.store.beginActiveExecution(claim.id);
				await f.store.finishActiveExecution(claim.id);
				if (status === 'failed') await f.store.recordFailure(claim.id, 'original allocated closeout failure');
				items.push({ id: attempt.id, assignmentAttempt: attempt, status, membershipId: `membership-${index}` });
			}
			const input = structuredClone({ items, connections }), pending: unknown = JSON.parse(await f.bytes());
			expect(() => verifyProviderLocalSlotClosure(items, connections, pending)).toThrow(/ACCEPTANCE_PROVIDER_LOCAL_RESIDUE/u);
			const results = await Promise.all(claims.flatMap(claim => [f.store.finalize(claim.id, 'terminal-receipt-confirmed'), f.reopen().finalize(claim.id, 'terminal-receipt-confirmed')]));
			expect(results.filter(Boolean)).toHaveLength(2); expect(results.filter(value => value === false)).toHaveLength(2);
			const bytes = await f.bytes(), retained: unknown = JSON.parse(bytes), proof = verifyProviderLocalSlotClosure(items, connections, retained);
			expect(proof).toHaveLength(2); expect({ items, connections }).toEqual(input);
			for (const claim of claims) expect(await f.reopen().finalize(claim.id, 'terminal-receipt-confirmed')).toBe(false);
			const after: unknown = JSON.parse(await f.bytes());
			expect(verifyProviderLocalSlotClosure(items, connections, after)).toEqual(proof);
			if (!retained || typeof retained !== 'object' || !after || typeof after !== 'object') throw new Error('Original local state required');
			expect(Reflect.get(after, 'usage')).toEqual(Reflect.get(retained, 'usage'));
			expect(Reflect.get(after, 'events')).toEqual(Reflect.get(retained, 'events'));
			expect(Reflect.get(after, 'events').some((event: Row) => event.message === 'original allocated closeout failure')).toBe(true);
			expect(await f.entries()).toEqual(['capacity-state.json']);
			// Native files/lock/atomic rename and real local finalization only.
			// Supplied terminal statuses/outcome are not an API acknowledgement,
			// native model charge, live managed dispatch or physical Kata closure.
		} finally { await f.close(); }
	});
	it('independent native finish observation and finalization races retain exact shared model capability and team seconds without charging terminal replay twice', async () => {
		const f = await capacityFixture(); try {
			const claims: Array<NonNullable<Awaited<ReturnType<typeof f.store.claim>>>> = [];
			for (const connectionId of ['measured-team-a', 'measured-team-b']) {
				const claim = await f.store.claim({ connectionId, globalLimit: 2, connectionLimit: 1 });
				if (!claim) throw new Error('Original independent native team slot required');
				claims.push(claim); await f.store.attachLease(claim.id, f.lease(connectionId));
				await f.store.claimDispatch(claim.id); await f.store.beginActiveExecution(claim.id);
			}
			await delay(5);
			await Promise.all(claims.flatMap(claim => [f.child('finish', claim.id), f.child('finish', claim.id)]));
			await f.store.recordFailure(claims[0]!.id, 'original measured native failure');
			const retained = await f.reopen().claimsForRecovery(), before = structuredClone(retained);
			expect(retained).toHaveLength(2);
			const scope = JSON.stringify([f.attempt.provider.modelConfigurationId, f.attempt.provider.executionCapabilityId]);
			const observation = await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]);
			for (const claim of retained) {
				if (!claim.activeStartedAt || !claim.activeFinishedAt) throw new Error('Actual native start and finish required');
				const start = Date.parse(claim.activeStartedAt), finish = Date.parse(claim.activeFinishedAt);
				expect(finish).toBeGreaterThan(start); expect(claim.accountedThrough).toBe(claim.activeFinishedAt);
			}
			const object = (value: unknown): Record<string, unknown> => {
				if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original native observation object required');
				return Object.fromEntries(Object.entries(value));
			};
			const measured = (day: string) => {
				const start = Date.parse(`${day}T00:00:00.000Z`), end = start + 86_400_000;
				if (!Number.isFinite(start)) throw new Error('Actual UTC accounting day required');
				return Object.fromEntries(retained.map(claim => [claim.connectionId,
					Math.max(0, Math.min(Date.parse(claim.activeFinishedAt!), end) - Math.max(Date.parse(claim.activeStartedAt!), start))]));
			};
			const remaining = retained.reduce((sum, claim) => sum + Math.max(0, (claim.requestedSeconds ?? 0)
				- (Date.parse(claim.activeFinishedAt!) - Date.parse(claim.activeStartedAt!)) / 1_000), 0);
			const check = (raw: unknown, reservedSeconds: number) => {
				const value = object(raw), model = object(value.modelUsage), capabilities = object(value.capabilityUsage);
				if (typeof model.day !== 'string' || typeof value.observedAt !== 'string') throw new Error('Actual native observation clocks required');
				expect(model.day).toBe(value.observedAt.slice(0, 10));
				// Independent integer native Date milliseconds, summed before the
				// one conversion to seconds; no tolerance or measurement rounding.
				const expected = { day: model.day, activeSeconds: Object.values(measured(model.day)).reduce((sum, milliseconds) => sum + milliseconds, 0) / 1_000, reservedSeconds };
				expect(model).toEqual(expected); expect(capabilities[f.attempt.provider.executionCapabilityId]).toEqual(expected);
			};
			check(observation, remaining);
			for (const value of await Promise.all(Array.from({ length: 4 }, () => f.child('observe', scope)))) {
				check(value, remaining);
			}
			const after = await f.reopen().claimsForRecovery();
			for (const claim of before) {
				const current = after.find(value => value.id === claim.id);
				expect(current).toMatchObject({ activeStartedAt: claim.activeStartedAt, activeFinishedAt: claim.activeFinishedAt,
					accountedThrough: claim.accountedThrough, dispatchEnvelope: claim.dispatchEnvelope,
					...(claim.failureMessage ? { failureMessage: claim.failureMessage } : {}) });
			}
			const finalizations = await Promise.all(claims.flatMap(claim => [f.child('finalize', claim.id), f.child('finalize', claim.id)]));
			expect(finalizations.filter(value => value === true)).toHaveLength(2); expect(finalizations.filter(value => value === false)).toHaveLength(2);
			for (const claim of claims) expect(await f.child('finalize', claim.id)).toBe(false);
			const terminal = await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]);
			check(terminal, 0);
			const snapshot = await f.reopen().snapshot(), durable = object(JSON.parse(await f.bytes()));
			if (typeof durable.updatedAt !== 'string') throw new Error('Actual native snapshot clock required');
			expect(snapshot.claims).toEqual([]); expect(snapshot.activeSecondsByConnection).toEqual(Object.fromEntries(
				Object.entries(measured(durable.updatedAt.slice(0, 10))).map(([connection, milliseconds]) => [connection, milliseconds / 1_000])));
			for (const claim of claims) expect(snapshot.events.filter(value => value.claimId === claim.id && value.outcome === 'native-accounted-terminal-confirmed')).toHaveLength(1);
			expect(snapshot.events.some(value => value.claimId === claims[0]!.id && value.message === 'original measured native failure')).toBe(true);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('native restart and overlapping writes preserve the first closeout output and failed cause while denying every substituted recovery output', async () => {
		const f = await capacityFixture(); try {
			const claim = await f.store.claim({ connectionId: 'original-owner', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Original native claim required');
			const lease = f.lease(), output = { status: 'blocked', unfinishedWork: ['original native work'], sandboxId: 'native-original',
				teardown: { verified: true, completedAt: new Date().toISOString() }, usage: { elapsedSeconds: 1.125 } };
			await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id);
			await f.store.recordCloseoutOutput(claim.id, output); await f.store.recordFailure(claim.id, 'original native interruption');
			await Promise.all([f.store.recordCloseoutOutput(claim.id, structuredClone(output)), f.reopen().recordCloseoutOutput(claim.id, structuredClone(output))]);
			const before = await f.bytes(), inputsBefore = structuredClone({ lease, output }), denied: boolean[] = [];
			for (const replacement of [{ ...output, status: 'completed' }, { ...output, unfinishedWork: [] }, { ...output, sandboxId: 'foreign' },
				{ ...output, usage: { elapsedSeconds: 0 } }, { ...output, teardown: { verified: false, completedAt: null } }, {}]) {
				try { await f.reopen().recordCloseoutOutput(claim.id, replacement); denied.push(false); } catch { denied.push(true); }
				expect(await f.bytes() === before).toBe(true);
			}
			expect(denied).toEqual(Array(6).fill(true)); expect({ lease, output }).toEqual(inputsBefore);
			const retained = (await f.reopen().claimsForRecovery())[0]; expect(retained?.closeoutOutput).toEqual(output);
			expect(retained?.failureMessage).toBe('original native interruption'); expect(retained?.dispatchEnvelope).toEqual(lease.dispatchEnvelope);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('native retained lease replay refuses identity expiry and frozen authority substitutions without erasing original failed custody', async () => {
		const f = await capacityFixture(); try {
			const claim = await f.store.claim({ connectionId: 'original-owner', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Original native claim required');
			const lease = f.lease(); await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id);
			await f.store.recordFailure(claim.id, 'original native interruption');
			const original = { assignmentId: lease.assignmentId, leaseToken: lease.leaseToken, leaseExpiresAt: lease.leaseExpiresAt, dispatchEnvelope: lease.dispatchEnvelope };
			await f.reopen().retainLease(claim.id, structuredClone(original)); const before = await f.bytes(), inputBefore = structuredClone(original), outcomes: boolean[] = [];
			for (const replacement of [{ ...original, assignmentId: 'foreign' }, { ...original, leaseToken: 'foreign' },
				{ ...original, leaseExpiresAt: new Date(Date.parse(f.attempt.deadline) + 1).toISOString() }, { ...original, dispatchEnvelope: {} },
				{ ...original, dispatchEnvelope: { assignment: { ...lease.dispatchEnvelope.assignment, assignmentAttempt: {
					...lease.dispatchEnvelope.assignment.assignmentAttempt, grant: { ...f.attempt.grant, sourceWrite: ['**'] } } } } }]) {
				try { await f.reopen().retainLease(claim.id, replacement); outcomes.push(false); } catch { outcomes.push(true); }
				expect(await f.bytes() === before).toBe(true);
			}
			expect(outcomes).toEqual(Array(5).fill(true)); expect(original).toEqual(inputBefore); expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('native lease renewal denies malformed elapsed and widened clocks before persistence and retains the original frozen attempt on restart', async () => {
		const f = await capacityFixture(); try {
			const claim = await f.store.claim({ connectionId: 'original-owner', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Original native claim required');
			const lease = f.lease(); await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id);
			await f.reopen().renewLease(claim.id, { assignmentId: lease.assignmentId, leaseExpiresAt: lease.leaseExpiresAt });
			const before = await f.bytes(), inputBefore = structuredClone(lease), outcomes: boolean[] = [];
			for (const leaseExpiresAt of [undefined, null, '', 'invalid', Date.parse(f.attempt.deadline),
				'2000-01-01T00:00:00.000Z', new Date(Date.parse(f.attempt.deadline) + 1).toISOString()]) {
				const supplied = Object.assign({ assignmentId: lease.assignmentId, leaseExpiresAt: lease.leaseExpiresAt }, { leaseExpiresAt });
				try { await f.reopen().renewLease(claim.id, supplied); outcomes.push(false); } catch { outcomes.push(true); }
				expect(await f.bytes() === before).toBe(true);
			}
			expect(outcomes).toEqual(Array(7).fill(true)); expect(lease).toEqual(inputBefore); expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('native restart refuses malformed backward and future execution accounting clocks without repairing durable claims or resetting usage', async () => {
		const f = await capacityFixture();
		try {
			const claim = await f.store.claim({ connectionId: 'clock-team', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Original allocated slot required');
			await f.store.attachLease(claim.id, f.lease()); await f.store.claimDispatch(claim.id);
			await f.store.beginActiveExecution(claim.id); await delay(5); await f.store.finishActiveExecution(claim.id);
			const held = (await f.store.claimsForRecovery())[0];
			if (!held?.activeStartedAt || !held.activeFinishedAt || !held.accountedThrough) throw new Error('Original native recorded clocks required');
			const original = await f.bytes(), recorded = JSON.parse(original);
			const mutations = [
				{ activeStartedAt: 'not-a-clock' }, { activeFinishedAt: 'not-a-clock' }, { accountedThrough: 'not-a-clock' },
				{ activeFinishedAt: new Date(Date.parse(held.activeStartedAt) - 1).toISOString() },
				{ accountedThrough: new Date(Date.parse(held.activeStartedAt) - 1).toISOString() },
				{ accountedThrough: new Date(Date.parse(held.activeFinishedAt) + 1).toISOString() },
				{ activeFinishedAt: new Date(Date.now() + 60_000).toISOString() },
			];
			const outcomes = [];
			for (const patch of mutations) {
				const candidate = structuredClone(recorded); Object.assign(candidate.claims[0], patch);
				const bytes = JSON.stringify(candidate); await writeFile(f.path, bytes, 'utf8');
				let denied = false;
				try { await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]); }
				catch { denied = true; }
				outcomes.push({ denied, retained: await f.bytes() === bytes });
			}
			expect(outcomes).toEqual(mutations.map(() => ({ denied: true, retained: true })));
			await writeFile(f.path, original, 'utf8');
			const seconds = (Date.parse(held.activeFinishedAt) - Date.parse(held.activeStartedAt)) / 1000;
			expect(seconds).toBeGreaterThan(0);
			for (let repeat = 0; repeat < 2; repeat++) expect((await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId,
				[f.attempt.provider.executionCapabilityId])).modelUsage.activeSeconds).toBe(seconds);
			expect((await f.reopen().claimsForRecovery())[0]?.dispatchEnvelope).toEqual(held.dispatchEnvelope);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('enforces global and perconnection slot caps across independent native processes with no lock or temporary residue', async () => {
		const f = await capacityFixture();
		try {
			const results = await Promise.all(['team-a', 'team-b', 'team-a', 'team-b', 'team-a', 'team-b'].map(id => f.child('claim', id)));
			expect(results.filter(Boolean)).toHaveLength(2);
			const saved = await f.reopen().snapshot();
			expect(saved.claims.map(item => item.connectionId).sort()).toEqual(['team-a', 'team-b']);
			for (const claim of saved.claims) await f.store.finalize(claim.id, 'isolated-unleased-finished');
			expect((await f.reopen().snapshot()).claims).toEqual([]);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('dispatches the exact complete frozen lease once across native processes and retains its immutable output on restart', async () => {
		const f = await capacityFixture();
		try {
			const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 2, connectionLimit: 1 });
			if (!claim) throw new Error('Native slot required');
			const lease = f.lease(), before = structuredClone(lease);
			await f.store.attachLease(claim.id, lease);
			const outcomes = await Promise.all([f.child('dispatch', claim.id), f.child('dispatch', claim.id)]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			await f.store.recordCloseoutOutput(claim.id, { status: 'blocked', unfinishedWork: ['original task'], assignmentAttempt: f.attempt });
			const retained = (await f.reopen().claimsForRecovery())[0];
			expect(retained?.dispatchEnvelope).toEqual(lease.dispatchEnvelope);
			expect(retained?.closeoutOutput).toEqual({ status: 'blocked', unfinishedWork: ['original task'], assignmentAttempt: f.attempt });
			expect(lease).toEqual(before);
			const publicView = await f.reopen().snapshot();
			expect(JSON.stringify(publicView)).not.toContain(lease.leaseToken);
			expect(publicView.claims[0]).not.toHaveProperty('dispatchEnvelope');
			expect(publicView.claims[0]).not.toHaveProperty('closeoutOutput');
		} finally { await f.close(); }
	});
	it('accounts actual failed execution seconds once across finish restart observations and terminal replay without converting native units', async () => {
		const f = await capacityFixture();
		try {
			const claim = await f.store.claim({ connectionId: 'busy', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Native slot required');
			await f.store.attachLease(claim.id, f.lease()); await f.store.claimDispatch(claim.id);
			await f.store.beginActiveExecution(claim.id); await delay(5); await f.store.finishActiveExecution(claim.id);
			await f.store.recordFailure(claim.id, 'isolated subprocess failed');
			const held = (await f.reopen().claimsForRecovery())[0];
			if (!held?.activeStartedAt || !held.activeFinishedAt) throw new Error('Actual recorded clocks required');
			const seconds = (Date.parse(held.activeFinishedAt) - Date.parse(held.activeStartedAt)) / 1000;
			expect(seconds).toBeGreaterThan(0);
			for (let repeat = 0; repeat < 3; repeat++) {
				const observation = await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]);
				expect(observation.modelUsage.activeSeconds).toBe(seconds);
				expect(observation.capabilityUsage[f.attempt.provider.executionCapabilityId]?.activeSeconds).toBe(seconds);
			}
			expect(await f.store.finalize(claim.id, 'failed-terminal-confirmed')).toBe(true);
			expect(await f.reopen().finalize(claim.id, 'failed-terminal-confirmed')).toBe(false);
			const snapshot = await f.reopen().snapshot();
			expect(snapshot.activeSecondsByConnection.busy).toBe(seconds);
			expect(snapshot.claims).toEqual([]);
			expect(snapshot.events.filter(item => item.outcome === 'failed-terminal-confirmed')).toHaveLength(1);
			const inventory = [{ connection: { id: 'busy' }, teamId: 'busy-team' }, { connection: { id: 'idle' }, teamId: 'idle-team' }];
			expect(orderConnectionsForFairPolling(inventory, snapshot)[0]?.teamId).toBe('idle-team');
		} finally { await f.close(); }
	});
	it('retains expired leased custody for recovery instead of admitting another worker or extending the original productive deadline', async () => {
		const f = await capacityFixture();
		try {
			const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
			if (!claim) throw new Error('Native slot required');
			const lease = { ...f.lease(), leaseExpiresAt: new Date(Date.now() + 20).toISOString() };
			await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id);
			await delay(Math.max(0, Date.parse(lease.leaseExpiresAt) - Date.now()) + 1);
			const retained = (await f.reopen().claimsForRecovery())[0];
			expect(retained?.status).toBe('recovery'); expect(retained?.leaseExpiresAt).toBe(lease.leaseExpiresAt);
			expect(retained?.dispatchEnvelope).toEqual(lease.dispatchEnvelope);
			expect(await f.store.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 })).toBeNull();
			expect(await f.store.finalize(claim.id, 'expired-terminal-confirmed')).toBe(true);
			expect(await f.store.claim({ connectionId: 'team-b', globalLimit: 1, connectionLimit: 1 })).not.toBeNull();
		} finally { await f.close(); }
	});
	it('denies conflicting lease replay and malformed native bounds while preserving exact durable state and valid replay', async () => {
		const f = await capacityFixture();
		try {
			const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 2, connectionLimit: 1 });
			if (!claim) throw new Error('Native slot required');
			const lease = f.lease(); await f.store.attachLease(claim.id, lease);
			const saved = await f.bytes(); await f.store.attachLease(claim.id, structuredClone(lease));
			const stable = (await f.reopen().claimsForRecovery())[0];
			expect(stable?.dispatchEnvelope).toEqual(lease.dispatchEnvelope);
			const conflicts = [{ ...lease, assignmentId: 'foreign' }, { ...lease, leaseToken: 'foreign' },
				{ ...lease, requestedSeconds: lease.requestedSeconds + 1 },
				{ ...lease, dispatchEnvelope: { assignment: { ...lease.dispatchEnvelope.assignment, assignmentAttempt: { ...f.attempt, nodeRevision: 2 } } } }];
			const outcomes = [];
			for (const conflict of conflicts) {
				const before = await f.bytes();
				try { await f.store.attachLease(claim.id, conflict); outcomes.push({ denied: false, unchanged: before === await f.bytes() }); }
				catch { outcomes.push({ denied: true, unchanged: before === await f.bytes() }); }
			}
			expect(outcomes).toEqual(conflicts.map(() => ({ denied: true, unchanged: true })));
			expect(JSON.parse(saved).claims[0].dispatchEnvelope).toEqual(lease.dispatchEnvelope);
		} finally { await f.close(); }
	});
	it('shares model and capability native ceilings across teams and rolls back denied reservations before a restart retry', async () => {
		const f = await capacityFixture();
		try {
			const first = await f.store.claim({ connectionId: 'team-a', globalLimit: 3, connectionLimit: 1 });
			const second = await f.store.claim({ connectionId: 'team-b', globalLimit: 3, connectionLimit: 1 });
			if (!first || !second) throw new Error('Two independent team slots required');
			const ceiling = { ...f.lease().accounting, dailyActiveSecondsLimit: 30, capabilityDailyActiveSecondsLimit: 30 };
			await f.store.attachLease(first.id, { ...f.lease(), accounting: ceiling });
			const before = await f.bytes(), outcomes = [];
			for (const maximumAssignmentSeconds of [NaN, -1, 0]) {
				try { await f.store.attachLease(second.id, { ...f.lease('second'), accounting: { ...ceiling, maximumAssignmentSeconds } }); outcomes.push('admitted'); }
				catch { outcomes.push('denied'); }
			}
			try { await f.store.attachLease(second.id, { ...f.lease('second'), accounting: ceiling }); outcomes.push('admitted'); } catch { outcomes.push('denied'); }
			expect(outcomes).toEqual(['denied', 'denied', 'denied', 'denied']); expect(await f.bytes()).toBe(before);
			await f.store.finalize(first.id, 'unused-lease-authoritatively-returned');
			await f.reopen().attachLease(second.id, { ...f.lease('second'), accounting: ceiling });
			expect((await f.reopen().snapshot()).claims).toHaveLength(1);
		} finally { await f.close(); }
	});
	it('fails closed on malformed persisted financial authority without resetting history and retries only after restoring original isolated bytes', async () => {
		const f = await capacityFixture();
		try {
			await f.store.snapshot(); const original = await f.bytes();
			const mutations = ['{', JSON.stringify({ ...JSON.parse(original), usage: { '2026-10-03': { '["model"]': -1 } } }),
				JSON.stringify({ ...JSON.parse(original), claims: null })];
			const outcomes = [];
			for (const bytes of mutations) {
				await writeFile(f.path, bytes, 'utf8');
				try { await f.reopen().snapshot(); outcomes.push({ denied: false, retained: await readFile(f.path, 'utf8') === bytes }); }
				catch { outcomes.push({ denied: true, retained: await readFile(f.path, 'utf8') === bytes }); }
			}
			expect(outcomes).toEqual(mutations.map(() => ({ denied: true, retained: true })));
			await writeFile(f.path, original, 'utf8'); expect((await f.reopen().snapshot()).claims).toEqual([]);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
});
