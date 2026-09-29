import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMultiTeamProviderManager, runMultiTeamProviderRunners } from '../../../src/provider/teams/multi-team-runtime.ts';
import { loadProviderManifest } from '../../../src/provider/configuration/manifest.ts';
import { CapacityProviderCoordinator } from '../../../src/provider/coordination/coordinator.ts';
import { createProviderControlPlaneClient } from '../../../src/provider/coordination/client.ts';
import { observeProviderDiskCapacity, evaluateProviderDiskCapacity } from '../../../src/provider/runtime/disk-capacity.ts';
import type { ProviderHostRuntimeConfig } from '../../../src/provider/configuration/config.ts';
import { materializeCapabilityOffers } from '../../../src/provider/capabilities/materialize-offers.ts';
import { resolveAgentExecutor } from '../../../src/provider/execution/executor-loader.ts';
import { publishProviderAvailability } from '../../../src/provider/lifecycle/lifecycle.ts';
import { runProviderAssignment } from '../../../src/provider/operations/runner.ts';
import { createAssignmentTreeDxFacade } from '../../../src/provider/coordination/assignment-treedx.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { request } from '../kernel/provider-kernel-fixture.ts';

vi.mock('../../../src/provider/configuration/manifest.ts', async importOriginal => ({ ...await importOriginal<object>(), loadProviderManifest: vi.fn() }));
vi.mock('../../../src/provider/coordination/client.ts', () => ({ createProviderControlPlaneClient: vi.fn() }));
vi.mock('../../../src/provider/runtime/disk-capacity.ts', async importOriginal => ({ ...await importOriginal<object>(), observeProviderDiskCapacity: vi.fn() }));
vi.mock('../../../src/provider/capabilities/materialize-offers.ts', () => ({ materializeCapabilityOffers: vi.fn() }));
vi.mock('../../../src/provider/execution/executor-loader.ts', () => ({ resolveAgentExecutor: vi.fn() }));
vi.mock('../../../src/provider/lifecycle/lifecycle.ts', async importOriginal => ({ ...await importOriginal<object>(), publishProviderAvailability: vi.fn() }));
vi.mock('../../../src/provider/operations/runner.ts', () => ({ runProviderAssignment: vi.fn() }));
vi.mock('../../../src/provider/coordination/assignment-treedx.ts', () => ({ createAssignmentTreeDxFacade: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(workers = 1, connectionLimit = workers) {
	const dataDir = await mkdtemp(join(tmpdir(), 'treeseed-admission-')); roots.push(dataDir);
	const config: ProviderHostRuntimeConfig = { dataDir, manifestPath: 'fixture.yaml', environment: 'local', maxConcurrentRunners: connectionLimit,
		maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
		env: { TREESEED_PROVIDER_RUNTIME_BUILD: `sha256:${'a'.repeat(64)}` }, redactedEnv: {} };
	vi.mocked(loadProviderManifest).mockResolvedValue({ manifest: { connections: [], adapters: [{ id: 'codex', laneIds: [], maxConcurrentWorkers: workers,
		nativeLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 3600, capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 3600 } } },
		offers: [{ offer: { offerId: 'codex', capabilities: [{ id: 'code-change' }] } }] }], capacity: { maxConcurrentWorkers: workers }, lanes: [] } } as never);
	vi.spyOn(CapacityProviderCoordinator.prototype, 'reconcileAll').mockResolvedValue([{ connectionId: 'team-a', status: 'connected', runtime: {
		connection: { id: 'team-a', offer: { maxConcurrentRunners: connectionLimit } }, teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a',
		controlPlaneUrl: 'https://api.example.test', controlPlaneAudience: 'https://api.example.test', accessToken: { accessToken: 'fixture-token' },
	} }] as never);
	const client = { nextAssignment: vi.fn().mockResolvedValue({ assignment: null }), returnAssignment: vi.fn().mockResolvedValue({}) };
	vi.mocked(createProviderControlPlaneClient).mockReturnValue(client as never);
	vi.mocked(observeProviderDiskCapacity).mockResolvedValue(evaluateProviderDiskCapacity({ path: dataDir, totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }));
	return { config, client };
}

describe('real provider polling admission', () => {
	it('rechecks a transient broker status failure before returning a leased assignment', async () => {
		const { config, client } = await fixture();
		const source = request().assignment;
		client.nextAssignment.mockResolvedValue({ assignment: source, leaseToken: 'test-only' } as never);
		const observe = vi.fn().mockResolvedValueOnce({ available: false, reason: 'broker status timed out' }).mockResolvedValue({ available: true });
		vi.mocked(resolveAgentExecutor).mockResolvedValue({ id: 'codex', observe, execute: vi.fn() });
		vi.mocked(createAssignmentTreeDxFacade).mockResolvedValue(request().treeDx!);
		vi.mocked(runProviderAssignment).mockResolvedValue({ status: 'completed' } as never);
		await runMultiTeamProviderRunners(config);
		expect(observe).toHaveBeenCalledTimes(2);
		expect(runProviderAssignment).toHaveBeenCalledOnce();
	});
	it('returns a persistently unavailable executor with its observed cause', async () => {
		vi.mocked(runProviderAssignment).mockClear();
		const { config, client } = await fixture();
		client.nextAssignment.mockResolvedValue({ assignment: request().assignment, leaseToken: 'test-only' } as never);
		client.returnAssignment = vi.fn().mockResolvedValue({});
		const observe = vi.fn().mockResolvedValue({ available: false, reason: 'containerd_unavailable' });
		vi.mocked(resolveAgentExecutor).mockResolvedValue({ id: 'codex', observe, execute: vi.fn() });
		await runMultiTeamProviderRunners(config);
		expect(observe).toHaveBeenCalledTimes(2);
		expect(client.returnAssignment).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
			code: 'executor_unavailable', retryable: true, reason: expect.stringContaining('containerd_unavailable'),
		}));
		expect(runProviderAssignment).not.toHaveBeenCalled();
	});
	it('runs five overlapping assignments and refills a freed slot without waiting for the slowest', async () => {
		const { config, client } = await fixture(5);
		let sequence = 0;
		client.nextAssignment.mockImplementation(async () => {
			const source = request().assignment;
			const id = `assignment-${++sequence}`;
			const attempt = { ...source.assignmentAttempt as Record<string, unknown>, id };
			return { assignment: { ...source, id, assignmentAttempt: attempt }, leaseToken: 'test-only' } as never;
		});
		vi.mocked(resolveAgentExecutor).mockResolvedValue({ id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() });
		vi.mocked(createAssignmentTreeDxFacade).mockResolvedValue(request().treeDx!);
		const release = new Map<string, () => void>();
		vi.mocked(runProviderAssignment).mockImplementation(async input => {
			await input.onActiveExecutionStarted?.();
			await new Promise<void>(resolve => release.set(String(input.assignment.id), resolve));
			await input.onActiveExecutionFinished?.();
			return { status: 'completed' } as never;
		});
		const store = new ProviderLocalCapacityStore(config.dataDir);
		await runMultiTeamProviderRunners(config, { background: true });
		await vi.waitFor(() => expect(release.size).toBe(5));
		const simultaneous = (await store.snapshot()).claims;
		expect(simultaneous).toHaveLength(5);
		expect(simultaneous.every(claim => claim.status === 'running')).toBe(true);
		expect(new Set(simultaneous.map(claim => claim.runnerId)).size).toBe(5);
		await runMultiTeamProviderRunners(config, { background: true });
		expect(client.nextAssignment).toHaveBeenCalledTimes(5);
		release.get('assignment-1')!();
		await vi.waitFor(async () => expect((await store.snapshot()).claims).toHaveLength(4));
		await runMultiTeamProviderRunners(config, { background: true });
		await vi.waitFor(() => expect(release.size).toBe(6));
		expect((await store.snapshot()).claims).toHaveLength(5);
		for (const resolve of release.values()) resolve();
		await vi.waitFor(async () => expect((await store.snapshot()).claims).toHaveLength(0));
		const events = (await store.snapshot()).events.filter(event => event.outcome === 'terminal-receipt-confirmed');
		expect(events).toHaveLength(6);
		expect(new Set(events.map(event => event.assignmentId)).size).toBe(6);
	});
	it('enforces adapter concurrency and retains every rejected lease for recovery', async () => {
		const { config, client } = await fixture(5);
		const loaded = await loadProviderManifest('fixture.yaml', config.dataDir);
		loaded.manifest.adapters[0]!.maxConcurrentWorkers = 1;
		let sequence = 0;
		client.nextAssignment.mockImplementation(async () => {
			const source = request().assignment;
			const id = `assignment-${++sequence}`;
			return { assignment: { ...source, id, assignmentAttempt: { ...source.assignmentAttempt as object, id } }, leaseToken: 'test-only' } as never;
		});
		vi.mocked(resolveAgentExecutor).mockResolvedValue({ id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() });
		vi.mocked(createAssignmentTreeDxFacade).mockResolvedValue(request().treeDx!);
		let release!: () => void;
		vi.mocked(runProviderAssignment).mockReset().mockImplementation(async () => {
			await new Promise<void>(resolve => { release = resolve; }); return { status: 'completed' } as never;
		});
		const store = new ProviderLocalCapacityStore(config.dataDir);
		await runMultiTeamProviderRunners(config, { background: true });
		await vi.waitFor(async () => expect((await store.snapshot()).claims.filter(claim => claim.status === 'recovery')).toHaveLength(4));
		expect(runProviderAssignment).toHaveBeenCalledOnce();
		const rejected = (await store.snapshot()).claims.filter(claim => claim.status === 'recovery');
		expect(rejected.every(claim => claim.assignmentId && claim.leaseToken && claim.runnerId)).toBe(true);
		expect(new Set(rejected.map(claim => claim.assignmentId)).size).toBe(4);
		release();
		await vi.waitFor(async () => expect((await store.snapshot()).claims).toHaveLength(4));
	});
	it('bounds concurrent polling by the connection limit within five host slots', async () => {
		const { config, client } = await fixture(5, 2);
		let release!: () => void;
		const barrier = new Promise<void>(resolve => { release = resolve; });
		client.nextAssignment.mockImplementation(async () => { await barrier; return { assignment: null }; });
		const run = runMultiTeamProviderRunners(config);
		await vi.waitFor(() => expect(client.nextAssignment).toHaveBeenCalledTimes(2));
		expect((await new ProviderLocalCapacityStore(config.dataDir).snapshot()).claims).toHaveLength(2);
		release(); await run;
		expect((await new ProviderLocalCapacityStore(config.dataDir).snapshot()).claims).toHaveLength(0);
	});
	it('reports unavailable supply when disk is insufficient even if the executor is ready', async () => {
		const { config } = await fixture();
		vi.mocked(observeProviderDiskCapacity).mockResolvedValueOnce(evaluateProviderDiskCapacity({ path: config.dataDir, totalBytes: 100 * 1024 ** 3, availableBytes: 1024 }));
		vi.mocked(materializeCapabilityOffers).mockResolvedValue([{ id: 'codex', offers: [{ offer: { capabilities: [{ id: 'code-change' }] } }],
			nativeLimits: { modelConfigurationId: 'model', dailyActiveSecondsLimit: 3600, capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 3600 } } } }] as never);
		vi.mocked(resolveAgentExecutor).mockResolvedValue({ id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() });
		vi.mocked(publishProviderAvailability).mockResolvedValue({ ok: true } as never);
		await runMultiTeamProviderManager(config);
		expect(publishProviderAvailability).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			adapters: [expect.objectContaining({ status: 'unavailable', observations: expect.objectContaining({ available: false, diskCapacity: expect.objectContaining({ ok: false }) }) })],
		}), expect.anything());
	});
	it('polls only with a pinned runtime and releases an empty local claim', async () => {
		const { config, client } = await fixture();
		const result = await runMultiTeamProviderRunners(config);
		if (!('results' in result)) throw new Error('Expected live runner results.');
		expect(client.nextAssignment).toHaveBeenCalledOnce();
		expect(client.nextAssignment).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ['code-change'], leaseSeconds: 300 }));
		expect(result.results).toEqual([expect.objectContaining({ status: 'idle', reason: 'no_assignment' })]);
		await runMultiTeamProviderRunners(config);
		expect(client.nextAssignment).toHaveBeenCalledTimes(2);
	});
	it('does not lease work below the host disk reserve and resumes only after recovery', async () => {
		const { config, client } = await fixture();
		vi.mocked(observeProviderDiskCapacity).mockResolvedValueOnce(evaluateProviderDiskCapacity({ path: config.dataDir, totalBytes: 100 * 1024 ** 3, availableBytes: 1024 }));
		const result = await runMultiTeamProviderRunners(config);
		if (!('results' in result)) throw new Error('Expected live runner results.');
		expect(client.nextAssignment).not.toHaveBeenCalled();
		expect(result.results).toEqual([expect.objectContaining({ reason: 'provider_disk_capacity_insufficient' })]);
		await runMultiTeamProviderRunners(config);
		expect(client.nextAssignment).toHaveBeenCalledOnce();
	});
	it('fails closed on an unavailable disk observation before polling', async () => {
		const { config, client } = await fixture();
		vi.mocked(observeProviderDiskCapacity).mockRejectedValueOnce(new Error('disk unavailable'));
		await expect(runMultiTeamProviderRunners(config)).rejects.toThrow('disk unavailable');
		expect(client.nextAssignment).not.toHaveBeenCalled();
	});
	it('rejects malformed disk observations instead of admitting infinite supply', () => {
		for (const availableBytes of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
			expect(() => evaluateProviderDiskCapacity({ path: '/fixture', totalBytes: 1000, availableBytes })).toThrow('provider_disk_capacity_invalid');
	});
});
