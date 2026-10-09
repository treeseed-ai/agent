import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverProviderLocalLeases } from '../../src/provider/coordination/lease-recovery.ts';
import { createProviderControlPlaneClient } from '../../src/provider/coordination/client.ts';
import { ProviderLocalCapacityStore } from '../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from './kernel/provider-kernel-fixture.ts';

const frozen = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), id: 'assignment', idempotencyKey: 'assignment' });
const dispatchEnvelope = { assignment: { id: frozen.id, assignmentAttempt: frozen } };
const observed = { id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId, status: 'leased', assignmentAttempt: frozen };
const connections = [{ connection: { id: 'connection' }, teamId: frozen.teamId, providerId: frozen.provider.providerId,
	accessToken: { accessToken: 'test-only' }, controlPlaneUrl: 'https://api.example.test' }];

vi.mock('../../src/provider/coordination/client.ts', () => ({ createProviderControlPlaneClient: vi.fn() }));

describe('provider local lease recovery', () => {
	it('requires an exact returned assignment receipt before finalizing recovery and retains every malformed successful transport reply', async () => {
		for (const reply of [undefined, null, {}, { assignment: {} }, { assignment: { id: 'foreign', status: 'returned' } },
			{ assignment: { id: frozen.id, status: 'running' } }, { assignment: { id: frozen.id, status: null } }]) {
			const input = structuredClone(reply), api = { assignment: vi.fn().mockResolvedValue(observed), returnAssignment: vi.fn().mockResolvedValue(reply) };
			vi.mocked(createProviderControlPlaneClient).mockReturnValue(api as never);
			const claim = { id: 'claim', connectionId: 'connection', assignmentId: frozen.id, leaseToken: 'lease', runnerId: 'runner',
				failureMessage: 'original failure', dispatchEnvelope }, before = structuredClone(claim);
			const store = { claimsForRecovery: vi.fn().mockResolvedValue([claim]), finalize: vi.fn(), recordFailure: vi.fn() };
			const recover = () => recoverProviderLocalLeases({ config: {} as never, store: store as never, connections: connections as never });
			expect((await recover())[0]?.status).toBe('retained');
			expect(store.finalize).not.toHaveBeenCalled(); expect(store.recordFailure).toHaveBeenCalledOnce();
			expect(reply).toEqual(input); expect(claim).toEqual(before);
			api.returnAssignment.mockResolvedValue({ assignment: { id: frozen.id, status: 'returned' } });
			expect((await recover())[0]?.status).toBe('released');
			expect(store.finalize).toHaveBeenCalledOnce(); expect(api.returnAssignment.mock.calls[1]).toEqual(api.returnAssignment.mock.calls[0]);
			const terminal = { ...observed, status: 'completed', assignmentAttempt: { ...frozen, status: 'completed', finishedAt: frozen.deadline } };
			const terminalBefore = structuredClone(terminal); api.assignment.mockResolvedValue(terminal);
			expect((await recover())[0]).toMatchObject({ status: 'released', observedStatus: 'completed' });
			expect(store.finalize).toHaveBeenCalledTimes(2); expect(api.returnAssignment).toHaveBeenCalledTimes(2);
			expect(terminal).toEqual(terminalBefore); expect(claim).toEqual(before);
			api.assignment.mockResolvedValue({ ...observed, assignmentAttempt: { ...frozen, finishedAt: frozen.deadline } });
			expect((await recover())[0]?.status).toBe('retained');
			expect(store.finalize).toHaveBeenCalledTimes(2); expect(api.returnAssignment).toHaveBeenCalledTimes(2);
			api.assignment.mockResolvedValue({ ...terminal, assignmentAttempt: { ...terminal.assignmentAttempt, status: 'running' } });
			expect((await recover())[0]?.status).toBe('retained');
			expect(store.finalize).toHaveBeenCalledTimes(2); expect(api.returnAssignment).toHaveBeenCalledTimes(2);
		}
	});
	it('retains actual closeout custody across restart without promoting absent or failed receipts', async () => {
		for (const output of [{ sandboxId: 'sandbox-1', teardown: { verified: true, completedAt: '2026-10-01T09:01:00Z' }, summary: 'Private executor output' },
			{ sandboxId: 'sandbox-1', teardown: { verified: false, completedAt: '2026-10-01T09:01:00Z' }, summary: 'Private executor output' },
			{ summary: 'Private executor output' }]) {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-closeout-recovery-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'connection', globalLimit: 1, connectionLimit: 1 });
			await store.attachLease(claim!.id, { assignmentId: 'assignment', leaseToken: 'lease',
				leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), dispatchEnvelope });
			await store.recordCloseoutOutput(claim!.id, output);
			await store.recordFailure(claim!.id, 'deadlock detected');
			const restarted = new ProviderLocalCapacityStore(root);
			expect(JSON.stringify(await restarted.snapshot())).not.toContain('Private executor output');
			const api = { assignment: vi.fn().mockResolvedValue(observed), returnAssignment: vi.fn().mockResolvedValue({ assignment: { id: frozen.id, status: 'returned' } }) };
			vi.mocked(createProviderControlPlaneClient).mockReturnValue(api as never);
			await recoverProviderLocalLeases({ config: {} as never, store: restarted,
				connections: connections as never });
			expect(api.returnAssignment).toHaveBeenCalledWith('assignment', expect.objectContaining({ output, code: 'provider_runtime_recovery' }));
			expect((await restarted.snapshot()).claims).toHaveLength(0);
		} finally { await rm(root, { recursive: true, force: true }); }
		}
	});
	it('recovers a prepared lease on startup but not during an active runner cycle', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-ready-lease-'));
		try {
			const store = new ProviderLocalCapacityStore(root);
			const claim = await store.claim({ connectionId: 'connection', globalLimit: 1, connectionLimit: 1 });
			expect(claim).not.toBeNull();
			await store.attachLease(claim!.id, {
				assignmentId: 'assignment', leaseToken: 'lease', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
				dispatchEnvelope,
			});
			await expect(store.claimsForRecovery(false)).resolves.toEqual([]);
			await expect(store.claimsForRecovery(true)).resolves.toEqual([
				expect.objectContaining({ id: claim!.id, status: 'ready', assignmentId: 'assignment' }),
			]);
			const api = { assignment: vi.fn(), returnAssignment: vi.fn() };
			vi.mocked(createProviderControlPlaneClient).mockReturnValue(api as never);
			await expect(recoverProviderLocalLeases({ config: {} as never, store, includeRunning: false,
				connections: connections as never,
			})).resolves.toEqual([]);
			expect(api.returnAssignment).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([undefined, 'Original execution failure'])('preserves the runtime cause rather than claiming every failure is a restart: %s', async failureMessage => {
		const api = { assignment: vi.fn().mockResolvedValue(observed), returnAssignment: vi.fn().mockResolvedValue({ assignment: { id: frozen.id, status: 'returned' } }) };
		vi.mocked(createProviderControlPlaneClient).mockReturnValue(api as never);
		const store = { claimsForRecovery: vi.fn().mockResolvedValue([{ id: 'claim', connectionId: 'connection',
			assignmentId: 'assignment', leaseToken: 'lease', runnerId: 'runner', failureMessage, dispatchEnvelope }]), finalize: vi.fn(), recordFailure: vi.fn() };
		await recoverProviderLocalLeases({ config: {} as never, store: store as never,
			connections: connections as never });
		expect(api.returnAssignment).toHaveBeenCalledWith('assignment', expect.objectContaining({
			code: failureMessage ? 'provider_runtime_recovery' : 'provider_restart_recovery',
			reason: failureMessage ? `Provider runtime failed before durable completion: ${failureMessage}` : 'Provider restarted before durable completion.',
		}));
		expect(store.finalize).toHaveBeenCalledOnce();
		expect(api.returnAssignment.mock.calls[0]?.[1]).not.toHaveProperty('output');
	});
	it('releases a recovery claim that never acquired lease authority', async () => {
		const store = {
			claimsForRecovery: vi.fn(async () => [{ id: 'claim-unleased', connectionId: 'retired-team', status: 'recovery' }]),
			finalize: vi.fn(async () => true),
			recordFailure: vi.fn(),
		};
		const result = await recoverProviderLocalLeases({ config: {} as never, connections: [], store: store as never });
		expect(store.finalize).toHaveBeenCalledWith('claim-unleased', 'unleased-claim-released');
		expect(store.recordFailure).not.toHaveBeenCalled();
		expect(result).toEqual([{ claimId: 'claim-unleased', status: 'released', reason: 'no_lease_acquired' }]);
	});

	it('retains a partially recorded lease when authority cannot be proven', async () => {
		const store = {
			claimsForRecovery: vi.fn(async () => [{ id: 'claim-partial', connectionId: 'retired-team', status: 'recovery', assignmentId: 'assignment-1' }]),
			finalize: vi.fn(),
			recordFailure: vi.fn(async () => true),
		};
		const result = await recoverProviderLocalLeases({ config: {} as never, connections: [], store: store as never });
		expect(store.finalize).not.toHaveBeenCalled();
		expect(store.recordFailure).toHaveBeenCalledOnce();
		expect(result).toEqual([{ claimId: 'claim-partial', status: 'retained', reason: 'lease_authority_unavailable' }]);
	});
});
