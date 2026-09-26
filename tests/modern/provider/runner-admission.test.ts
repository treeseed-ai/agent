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

vi.mock('../../../src/provider/configuration/manifest.ts', async importOriginal => ({ ...await importOriginal<object>(), loadProviderManifest: vi.fn() }));
vi.mock('../../../src/provider/coordination/client.ts', () => ({ createProviderControlPlaneClient: vi.fn() }));
vi.mock('../../../src/provider/runtime/disk-capacity.ts', async importOriginal => ({ ...await importOriginal<object>(), observeProviderDiskCapacity: vi.fn() }));
vi.mock('../../../src/provider/capabilities/materialize-offers.ts', () => ({ materializeCapabilityOffers: vi.fn() }));
vi.mock('../../../src/provider/execution/executor-loader.ts', () => ({ resolveAgentExecutor: vi.fn() }));
vi.mock('../../../src/provider/lifecycle/lifecycle.ts', async importOriginal => ({ ...await importOriginal<object>(), publishProviderAvailability: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), 'treeseed-admission-')); roots.push(dataDir);
	const config: ProviderHostRuntimeConfig = { dataDir, manifestPath: 'fixture.yaml', environment: 'local', maxConcurrentRunners: 1,
		maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null,
		env: { TREESEED_PROVIDER_RUNTIME_BUILD: `sha256:${'a'.repeat(64)}` }, redactedEnv: {} };
	vi.mocked(loadProviderManifest).mockResolvedValue({ manifest: { connections: [], adapters: [{ offers: [{ offer: { capabilities: [{ id: 'code-change' }] } }] }], capacity: { maxConcurrentWorkers: 1 }, lanes: [] } } as never);
	vi.spyOn(CapacityProviderCoordinator.prototype, 'reconcileAll').mockResolvedValue([{ connectionId: 'team-a', status: 'connected', runtime: {
		connection: { id: 'team-a', offer: { maxConcurrentRunners: 1 } }, teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a',
		controlPlaneUrl: 'https://api.example.test', controlPlaneAudience: 'https://api.example.test', accessToken: { accessToken: 'fixture-token' },
	} }] as never);
	const client = { nextAssignment: vi.fn().mockResolvedValue({ assignment: null }) };
	vi.mocked(createProviderControlPlaneClient).mockReturnValue(client as never);
	vi.mocked(observeProviderDiskCapacity).mockResolvedValue(evaluateProviderDiskCapacity({ path: dataDir, totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }));
	return { config, client };
}

describe('real provider polling admission', () => {
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
