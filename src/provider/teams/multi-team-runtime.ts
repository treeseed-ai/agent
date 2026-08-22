import { loadProviderManifest } from '../configuration/manifest.ts';
import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { CapacityProviderCoordinator, type ProviderConnectionRuntime } from '../coordination/coordinator.ts';
import { createProviderControlPlaneClient } from '../coordination/client.ts';
import { recoverProviderLocalLeases } from '../coordination/lease-recovery.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { publishProviderAvailability, buildProviderRunnerPlan } from '../lifecycle/lifecycle.ts';
import { resolveAgentExecutor } from '../execution/executor-loader.ts';
import { runProviderAssignment } from '../operations/runner.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
	return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
}

function context(
	config: ProviderHostRuntimeConfig,
	runtime: ProviderConnectionRuntime,
	executionProviders: ProviderConnectionRuntimeContext['executionProviders'],
	defaultExecutionProviderId?: string,
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
		executionProviders,
		defaultExecutionProviderId,
		env: { ...config.env, TREESEED_API_BASE_URL: runtime.controlPlaneUrl },
	};
}

export async function createCapacityProviderCoordinator(config: ProviderHostRuntimeConfig) {
	if (!config.manifestPath) throw new Error('A capacity provider manifest is required.');
	return new CapacityProviderCoordinator(await loadProviderManifest(config.manifestPath), config.dataDir);
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
	const loaded = await loadProviderManifest(config.manifestPath ?? '');
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
		const runtime = context(config, connection.runtime, loaded.manifest.executionProviders, loaded.manifest.defaultExecutionProviderId);
		const providers = await Promise.all(loaded.manifest.executionProviders.map(async (provider) => {
			const executor = await resolveAgentExecutor(config, provider.id).catch(() => null);
			const observation = executor
				? await executor.observe().catch((error) => ({ available: false, reason: error instanceof Error ? error.message : String(error) }))
				: { available: false, reason: 'executor_not_configured' };
			return {
				id: provider.id,
				adapter: provider.adapter,
				nativeLimits: provider.nativeLimits,
				capabilities: provider.capabilities ?? [],
				status: observation.available ? 'available' : 'unavailable',
				observations: observation,
			};
		}));
		return publishProviderAvailability(runtime, {
			offer: connection.runtime.connection.offer,
			executionProviders: providers,
			activeRunners: (await localState.snapshot()).claims.length,
		}, localState);
	}));
	return { ok: results.every((entry) => entry.ok !== false), role: 'manager', connections: results };
}

export async function runMultiTeamProviderRunners(
	config: ProviderHostRuntimeConfig,
	options: { mode?: 'plan' | 'live'; background?: boolean } = {},
) {
	if (options.mode === 'plan') return buildProviderRunnerPlan(config);
	const loaded = await loadProviderManifest(config.manifestPath ?? '');
	const connections = (await reconcileProviderConnections(config)).flatMap((entry) => entry.runtime ? [entry.runtime] : []);
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	const results: Record<string, unknown>[] = [];
	for (const connection of connections) {
		const runtime = context(config, connection, loaded.manifest.executionProviders, loaded.manifest.defaultExecutionProviderId);
		const executionProviderId = loaded.manifest.defaultExecutionProviderId ?? loaded.manifest.executionProviders[0]?.id;
		if (!executionProviderId) {
			results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'no_execution_provider' });
			continue;
		}
		const executor = await resolveAgentExecutor(config, executionProviderId);
		if (!executor || !(await executor.observe()).available) {
			results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'executor_unavailable' });
			continue;
		}
		const claim = await localState.claim({
			connectionId: connection.connection.id,
			globalLimit: config.maxConcurrentRunners,
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
			const leaseExpiresAt = text(assignment.leaseExpiresAt) ?? new Date(Date.now() + 300_000).toISOString();
			await localState.attachLease(claim.id, {
				assignmentId,
				leaseToken,
				leaseExpiresAt,
				executionProviderId,
				dispatchEnvelope: leased,
			});
			await localState.claimDispatch([connection.connection.id]);
			const terminal = await runProviderAssignment({
				client,
				executor,
				assignment,
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
