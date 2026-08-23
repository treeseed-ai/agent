import { loadProviderManifest } from '../configuration/manifest.ts';
import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { CapacityProviderCoordinator, type ProviderConnectionRuntime } from '../coordination/coordinator.ts';
import { createProviderControlPlaneClient } from '../coordination/client.ts';
import { recoverProviderLocalLeases } from '../coordination/lease-recovery.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { publishProviderAvailability, buildProviderRunnerPlan } from '../lifecycle/lifecycle.ts';
import { resolveAgentExecutor } from '../execution/executor-loader.ts';
import { runProviderAssignment } from '../operations/runner.ts';
import { createAssignmentTreeDxFacade } from '../coordination/assignment-treedx.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
	return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
}

function context(
	config: ProviderHostRuntimeConfig,
	runtime: ProviderConnectionRuntime,
	manifest: Pick<Awaited<ReturnType<typeof loadProviderManifest>>['manifest'], 'adapters' | 'lanes' | 'capacity'>,
): ProviderConnectionRuntimeContext {
	return {
		...config,
		connectionId: runtime.connection.id,
		controlPlaneUrl: runtime.controlPlaneUrl,
		controlPlaneAudience: runtime.controlPlaneAudience,
		teamId: runtime.teamId,
		providerId: runtime.providerId,
		membershipId: runtime.membershipId,
		accessToken: runtime.accessToken.accessToken,
		adapters: manifest.adapters,
		lanes: manifest.lanes,
		providerCapacity: manifest.capacity,
		env: { ...config.env, TREESEED_API_BASE_URL: runtime.controlPlaneUrl },
	};
}

export async function createCapacityProviderCoordinator(config: ProviderHostRuntimeConfig) {
	if (!config.manifestPath) throw new Error('A capacity provider manifest is required.');
	return new CapacityProviderCoordinator(await loadProviderManifest(config.manifestPath, config.dataDir), config.dataDir);
}

export async function reconcileProviderConnections(config: ProviderHostRuntimeConfig) {
	return (await createCapacityProviderCoordinator(config)).reconcileAll();
}

export async function recoverMultiTeamProviderRunners(config: ProviderHostRuntimeConfig) {
	const connections = (await reconcileProviderConnections(config)).flatMap((entry) => entry.runtime ? [entry.runtime] : []);
	return recoverProviderLocalLeases({ config, connections });
}

export async function runMultiTeamProviderManager(
	config: ProviderHostRuntimeConfig,
	options: { mode?: 'plan' | 'live' } = {},
) {
	const loaded = await loadProviderManifest(config.manifestPath ?? '', config.dataDir);
	if (options.mode === 'plan') {
		return {
			ok: true,
			role: 'manager',
			mode: 'plan',
			connections: loaded.manifest.connections.map(({ id, serverProfile, controlPlaneUrl, enabled }) => ({
				id,
				serverProfile: serverProfile ?? null,
				controlPlaneUrl: controlPlaneUrl ?? null,
				enabled: enabled !== false,
			})),
		};
	}
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	const connections = await reconcileProviderConnections(config);
	const results = await Promise.all(connections.map(async (connection) => {
		if (!connection.runtime) {
			return { ok: connection.status !== 'error', connectionId: connection.connectionId, status: connection.status };
		}
		const runtime = context(config, connection.runtime, loaded.manifest);
		const adapters = await Promise.all(loaded.manifest.adapters.map(async (adapter) => {
			const executor = await resolveAgentExecutor(config, adapter, loaded.manifest).catch(() => null);
			const observation = executor
				? await executor.observe()
					.catch((error) => ({ available: false, reason: error instanceof Error ? error.message : String(error) }))
					.finally(() => executor.shutdown?.())
				: { available: false, reason: 'executor_not_configured' };
			return {
				id: adapter.id,
				adapter: adapter.adapter,
				isolation: adapter.isolation,
				laneIds: adapter.laneIds,
				maxConcurrentWorkers: adapter.maxConcurrentWorkers,
				nativeLimits: adapter.nativeLimits,
				capabilities: adapter.capabilities ?? [],
				status: observation.available ? 'available' : 'unavailable',
				observations: observation,
			};
		}));
		return publishProviderAvailability(runtime, {
			offer: connection.runtime.connection.offer,
			adapters,
			lanes: loaded.manifest.lanes,
			capacity: loaded.manifest.capacity,
			activeWorkers: (await localState.snapshot()).claims.length,
		}, localState);
	}));
	return { ok: results.every((entry) => entry.ok !== false), role: 'manager', connections: results };
}

export async function runMultiTeamProviderRunners(
	config: ProviderHostRuntimeConfig,
	options: { mode?: 'plan' | 'live'; background?: boolean } = {},
) {
	if (options.mode === 'plan') return buildProviderRunnerPlan(config);
	const loaded = await loadProviderManifest(config.manifestPath ?? '', config.dataDir);
	const connections = (await reconcileProviderConnections(config)).flatMap((entry) => entry.runtime ? [entry.runtime] : []);
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	const results: Record<string, unknown>[] = [];
	for (const connection of connections) {
		const runtime = context(config, connection, loaded.manifest);
		const claim = await localState.claim({
			connectionId: connection.connection.id,
			globalLimit: loaded.manifest.capacity.maxConcurrentWorkers,
			connectionLimit: connection.connection.offer.maxConcurrentRunners ?? config.maxConcurrentRunners,
		});
		if (!claim) {
			results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'local_capacity_exhausted' });
			continue;
		}
		const client = createProviderControlPlaneClient(runtime);
		try {
			const leased = record(await client.nextAssignment({
				runnerId: claim.runnerId,
				capabilities: connection.connection.offer.capabilities,
				leaseSeconds: 300,
			}));
			const assignment = record(leased.assignment ?? leased.data ?? leased.payload);
			const assignmentId = text(assignment.id);
			const leaseToken = text(leased.leaseToken, assignment.leaseToken);
			if (!assignmentId || !leaseToken) {
				await localState.release(claim.id);
				results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'no_assignment' });
				continue;
			}
			const executionProviderId = text(assignment.executionProviderId, record(assignment.capacityEnvelope).executionProviderId);
			const laneId = text(assignment.laneId, record(assignment.capacityEnvelope).laneId);
			const adapter = loaded.manifest.adapters.find((candidate) => candidate.id === executionProviderId && (!laneId || candidate.laneIds.includes(laneId)));
			if (!adapter) { await localState.release(claim.id); results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'assignment_adapter_unavailable' }); continue; }
			const executor = await resolveAgentExecutor(config, adapter, loaded.manifest);
			if (!executor || !(await executor.observe()).available) { await localState.release(claim.id); results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'executor_unavailable' }); continue; }
			const leaseExpiresAt = text(assignment.leaseExpiresAt) ?? new Date(Date.now() + 300_000).toISOString();
			await localState.attachLease(claim.id, {
				assignmentId,
				leaseToken,
				leaseExpiresAt,
				executionProviderId,
				dispatchEnvelope: leased,
			});
			await localState.claimDispatch([connection.connection.id]);
			const treeDx = await createAssignmentTreeDxFacade(runtime, assignment);
			const terminal = await runProviderAssignment({
				client,
				executor,
				assignment,
				treeDx,
				leaseToken,
				runnerId: claim.runnerId,
				leaseSeconds: 300,
				onLeaseRenewed: (renewedLeaseExpiresAt) => localState.renewLease(claim.id, {
					assignmentId,
					leaseExpiresAt: renewedLeaseExpiresAt,
				}).then(() => undefined),
			});
			await localState.finalize(claim.id, 'terminal-receipt-confirmed');
			results.push({ connectionId: connection.connection.id, assignmentId, status: 'settled', terminal });
		} catch (error) {
			await localState.recordFailure(claim.id, error instanceof Error ? error.message : String(error));
			results.push({
				connectionId: connection.connection.id,
				status: 'recovery',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return {
		ok: results.every((entry) => entry.status !== 'recovery'),
		role: 'runner',
		background: options.background === true,
		results,
	};
}
