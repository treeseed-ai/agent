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
import type { CapacityProviderManifestV5 } from '@treeseed/sdk/capacity-provider';
import { materializeCapabilityOffers } from '../capabilities/materialize-offers.ts';
import { assignmentOfferId } from '../execution/assignment-selection.ts';
import { assignmentAttemptSchema, capabilityAccountingLimitsSchema } from '@treeseed/sdk/agent-capacity';
import { projectHandlers } from '../../kernel/project-handlers.ts';
import { observeProviderDiskCapacity } from '../runtime/disk-capacity.ts';

// In-process task ownership only; durable capacity/lease authority stays in localState.
const pendingRunners = new Map<string, Set<Promise<void>>>();

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
	return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;
}

export function orderConnectionsForFairPolling<T extends { connection: { id: string }; teamId: string }>(
	connections: T[], snapshot: { claims: Array<{ connectionId: string }>;
		events: Array<{ connectionId: string; outcome: string }>;
		activeSecondsByConnection?: Record<string, number> },
): T[] {
	const active = new Map<string, number>();
	for (const claim of snapshot.claims) active.set(claim.connectionId, (active.get(claim.connectionId) ?? 0) + 1);
	const lastLease = new Map<string, number>();
	snapshot.events.forEach((event, index) => {
		if (event.outcome === 'leased') lastLease.set(event.connectionId, index);
	});
	const teamForConnection = new Map(connections.map((entry) => [entry.connection.id, entry.teamId]));
	const teamActive = new Map<string, number>();
	for (const [connectionId, count] of active) {
		const teamId = teamForConnection.get(connectionId);
		if (teamId) teamActive.set(teamId, (teamActive.get(teamId) ?? 0) + count);
	}
	const teamLastLease = new Map<string, number>();
	for (const [connectionId, index] of lastLease) {
		const teamId = teamForConnection.get(connectionId);
		if (teamId) teamLastLease.set(teamId, Math.max(teamLastLease.get(teamId) ?? -1, index));
	}
	const teamUsage = new Map<string, number>();
	for (const [connectionId, seconds] of Object.entries(snapshot.activeSecondsByConnection ?? {})) {
		const teamId = teamForConnection.get(connectionId);
		if (teamId) teamUsage.set(teamId, (teamUsage.get(teamId) ?? 0) + seconds);
	}
	return [...connections].sort((left, right) => (teamUsage.get(left.teamId) ?? 0) - (teamUsage.get(right.teamId) ?? 0)
		|| (teamActive.get(left.teamId) ?? 0) - (teamActive.get(right.teamId) ?? 0)
		|| (teamLastLease.get(left.teamId) ?? -1) - (teamLastLease.get(right.teamId) ?? -1)
		|| (active.get(left.connection.id) ?? 0) - (active.get(right.connection.id) ?? 0)
		|| (lastLease.get(left.connection.id) ?? -1) - (lastLease.get(right.connection.id) ?? -1)
		|| left.connection.id.localeCompare(right.connection.id));
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
		accessTokenProvider: runtime.accessTokenProvider,
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
	if (!/^sha256:[a-f0-9]{64}$/u.test(config.env.TREESEED_PROVIDER_RUNTIME_BUILD ?? ''))
		throw new Error('provider_runtime_build_unpinned');
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	const connections = await reconcileProviderConnections(config);
	await localState.snapshot();
	const disk = await observeProviderDiskCapacity({ path: config.dataDir, env: config.env });
	const results = await Promise.all(connections.map(async (connection) => {
		if (!connection.runtime) {
			return { ok: connection.status !== 'error', connectionId: connection.connectionId, status: connection.status,
				...('error' in connection ? { error: connection.error } : {}) };
		}
		const runtime = context(config, connection.runtime, loaded.manifest);
		const configuredAdapters = await materializeCapabilityOffers({ config, loaded: loaded as typeof loaded & { manifest: CapacityProviderManifestV5 }, providerId: connection.runtime.providerId });
		const capacitySnapshot = await localState.snapshot();
		const adapters = await Promise.all(configuredAdapters.map(async (adapter) => {
			const executor = await resolveAgentExecutor(config, adapter, loaded.manifest).catch(() => null);
			const executorObservation = executor
				? await executor.observe()
					.catch((error) => ({ available: false, reason: error instanceof Error ? error.message : String(error) }))
					.finally(() => executor.shutdown?.())
				: { available: false, reason: 'executor_not_configured' };
			const observation = { ...executorObservation, available: executorObservation.available && disk.ok, diskCapacity: disk };
			const capabilities = [...new Set(adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id)))];
			const limits = capabilityAccountingLimitsSchema.safeParse(adapter.nativeLimits);
			const accounting = limits.success ? await localState.activeTimeObservation(limits.data.modelConfigurationId, capabilities) : null;
			const scopedObservation = (value: { day: string; activeSeconds: number; reservedSeconds: number }) => ({ ...value,
				observedAt: accounting!.observedAt, healthy: observation.available });
			return {
				id: adapter.id,
				adapter: adapter.adapter,
				isolation: adapter.isolation,
				runtimeBuild: config.env.TREESEED_PROVIDER_RUNTIME_BUILD,
				offers: adapter.offers.map(({ offer }) => offer),
				laneIds: adapter.laneIds,
				maxConcurrentWorkers: adapter.maxConcurrentWorkers,
				activeWorkers: capacitySnapshot.claims.filter((claim) => claim.executionProviderId === adapter.id).length,
				capabilities,
				nativeLimits: adapter.nativeLimits,
				...(accounting ? { accountingObservation: { modelUsage: scopedObservation(accounting.modelUsage),
					capabilityUsage: Object.fromEntries(Object.entries(accounting.capabilityUsage).map(([id, value]) => [id, scopedObservation(value)])) } } : {}),
				status: observation.available && limits.success ? 'available' : 'unavailable',
				observations: observation,
			};
		}));
		return publishProviderAvailability(runtime, {
			manifestVersion: loaded.manifest.schemaVersion,
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
	if (!/^sha256:[a-f0-9]{64}$/u.test(config.env.TREESEED_PROVIDER_RUNTIME_BUILD ?? ''))
		throw new Error('provider_runtime_build_unpinned');
	const loaded = await loadProviderManifest(config.manifestPath ?? '', config.dataDir);
	const connections = (await reconcileProviderConnections(config)).flatMap((entry) => entry.runtime ? [entry.runtime] : []);
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	await recoverProviderLocalLeases({ config, connections, store: localState, includeRunning: false });
	const results: Record<string, unknown>[] = [];
	const ordered = orderConnectionsForFairPolling(connections, await localState.snapshot());
	const runConnection = async (connection: ProviderConnectionRuntime) => {
		const disk = await observeProviderDiskCapacity({ path: config.dataDir, env: config.env });
		if (!disk.ok) {
			results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'provider_disk_capacity_insufficient', diagnostics: disk });
			return;
		}
		const runtime = context(config, connection, loaded.manifest);
		const claim = await localState.claim({
			connectionId: connection.connection.id,
			globalLimit: loaded.manifest.capacity.maxConcurrentWorkers,
			connectionLimit: connection.connection.offer.maxConcurrentRunners ?? config.maxConcurrentRunners,
		});
		if (!claim) {
			results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'local_capacity_exhausted' });
			return;
		}
		const client = createProviderControlPlaneClient(runtime);
		let leasedAssignmentId: string | undefined;
		let leasedToken: string | undefined;
		let leasedEnvelope: Record<string, unknown> | undefined;
		try {
			const advertisedCapabilities = [...new Set(loaded.manifest.adapters.flatMap((adapter) => adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))))];
			const leased = record(await client.nextAssignment({
				runnerId: claim.runnerId,
				capabilities: advertisedCapabilities,
				leaseSeconds: 300,
			}));
			const assignment = record(leased.assignment ?? leased.data ?? leased.payload);
			const assignmentId = text(assignment.id);
			const leaseToken = text(leased.leaseToken, assignment.leaseToken);
			leasedAssignmentId = assignmentId;
			leasedToken = leaseToken;
			leasedEnvelope = leased;
			if (!assignmentId || !leaseToken) {
				const diagnostics = record(leased.diagnostics ?? leased.leaseDiagnostics);
				const synthesis = record(diagnostics.synthesis);
				if (text(synthesis.status) === 'failed') {
					const details = record(synthesis.details);
					throw new Error(`Assignment synthesis failed (${text(synthesis.code) ?? 'unknown'}): ${text(synthesis.message) ?? 'No diagnostic message was returned.'}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
				}
				await localState.release(claim.id);
				results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'no_assignment', diagnostics: Object.keys(diagnostics).length ? diagnostics : null });
				return;
			}
			if (text(assignment.executionKind) === 'conversation') await client.acknowledgeCommunicationNotification(assignmentId, {
				providerId: connection.providerId, runnerId: claim.runnerId, observedAt: new Date().toISOString(),
			});
			const canonicalAttempt = assignmentAttemptSchema.parse(assignment.assignmentAttempt ?? record(assignment.workspaceContext).assignmentAttempt);
			const executionProviderId = canonicalAttempt.provider.executionProviderId;
			const offerId = assignmentOfferId(assignment);
			const laneId = text(assignment.laneId, record(assignment.capacityEnvelope).laneId);
			const providerLaneId = executionProviderId && laneId?.startsWith(`${executionProviderId}:`)
				? laneId.slice(executionProviderId.length + 1)
				: laneId;
			const adapter = loaded.manifest.adapters.find((candidate) => candidate.id === canonicalAttempt.provider.executionProviderId
				&& candidate.offers.some(({ offer }) => offer.offerId === offerId)
				&& (!providerLaneId || candidate.laneIds.includes(providerLaneId)));
			if (!adapter) {
				const installed = loaded.manifest.adapters.map(candidate => ({ id: candidate.id,
					offerIds: candidate.offers.map(({ offer }) => offer.offerId), laneIds: candidate.laneIds }));
				await client.returnAssignment(assignmentId, { leaseToken, runnerId: claim.runnerId, code: 'assignment_adapter_unavailable',
					reason: `Assignment adapter binding is unavailable: ${JSON.stringify({ executionProviderId: canonicalAttempt.provider.executionProviderId, offerId, laneId: providerLaneId, installed })}`,
					retryable: true });
				await localState.release(claim.id); results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'assignment_adapter_unavailable' }); return;
			}
			const executor = await resolveAgentExecutor(config, adapter, loaded.manifest);
			let executorObservation = executor ? await executor.observe() : null;
			if (executor && executorObservation?.available === false) executorObservation = await executor.observe();
			if (!executorObservation?.available) {
				await client.returnAssignment(assignmentId, { leaseToken, runnerId: claim.runnerId, code: 'executor_unavailable', reason: `The Kata sandbox host is not ready for this assignment: ${executorObservation?.reason ?? 'executor_not_configured'}.`, retryable: true });
				await localState.release(claim.id); results.push({ connectionId: connection.connection.id, status: 'idle', reason: 'executor_unavailable' }); return;
			}
			const leaseExpiresAt = text(assignment.leaseExpiresAt) ?? new Date(Date.now() + 300_000).toISOString();
			const attempt = canonicalAttempt;
			const limits = capabilityAccountingLimitsSchema.parse(adapter.nativeLimits);
			const capabilityLimit = limits.capabilityLimits[attempt.provider.executionCapabilityId];
			if (attempt.provider.modelConfigurationId !== limits.modelConfigurationId || !capabilityLimit) throw new Error('Assignment execution accounting scope does not match the installed adapter.');
			await localState.attachLease(claim.id, {
				assignmentId,
				leaseToken,
				leaseExpiresAt,
				executionProviderId,
				laneId,
				requestedSeconds: attempt.limits.maximumSeconds,
				accounting: { modelConfigurationId: limits.modelConfigurationId, capabilityId: attempt.provider.executionCapabilityId,
					dailyActiveSecondsLimit: limits.dailyActiveSecondsLimit, capabilityDailyActiveSecondsLimit: capabilityLimit.dailyActiveSecondsLimit,
					minimumAssignmentSeconds: capabilityLimit.minimumAssignmentSeconds, maximumAssignmentSeconds: capabilityLimit.maximumAssignmentSeconds },
				dispatchEnvelope: leased,
				executionProviderLimit: { maxConcurrentRunners: adapter.maxConcurrentWorkers },
				laneLimit: { maxConcurrentRunners: loaded.manifest.lanes.find(lane => lane.id === providerLaneId)?.maxConcurrentWorkers },
			});
			if (!await localState.claimDispatch(claim.id)) throw new Error('Exact provider-local dispatch claim is unavailable.');
			const treeDx = await createAssignmentTreeDxFacade(runtime, assignment);
			const terminal = await runProviderAssignment({
				client,
				executor,
				handlers: [...projectHandlers],
				assignment,
				treeDx,
				runtimeBuild: config.env.TREESEED_PROVIDER_RUNTIME_BUILD,
				leaseToken,
				runnerId: claim.runnerId,
				leaseSeconds: 300,
				onActiveExecutionStarted: () => localState.beginActiveExecution(claim.id),
				onActiveExecutionFinished: () => localState.finishActiveExecution(claim.id),
				renewalIntervalMs: text(assignment.executionKind) === 'conversation' ? 5_000 : undefined,
				onLeaseRenewed: async (renewedLeaseExpiresAt) => {
					await executor.renewLease?.(assignmentId, renewedLeaseExpiresAt);
					await localState.renewLease(claim.id, { assignmentId, leaseExpiresAt: renewedLeaseExpiresAt });
				},
			});
			await localState.finalize(claim.id, 'terminal-receipt-confirmed');
			results.push({ connectionId: connection.connection.id, assignmentId, status: 'settled', terminal });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (leasedAssignmentId && leasedToken) {
				await localState.retainLease(claim.id, { assignmentId: leasedAssignmentId, leaseToken: leasedToken,
					leaseExpiresAt: text(record(leasedEnvelope?.assignment).leaseExpiresAt) ?? new Date(Date.now() + 300_000).toISOString(),
					dispatchEnvelope: leasedEnvelope });
				await localState.recordFailure(claim.id, message);
			}
			else await localState.finalize(claim.id, 'unleased-runner-failure-released');
			results.push({
				connectionId: connection.connection.id,
				status: leasedAssignmentId || leasedToken ? 'recovery' : 'idle',
				reason: leasedAssignmentId || leasedToken ? 'lease_recovery_required' : 'unleased_runner_failure',
				error: message,
			});
		}
	};
	// Each worker claims its own durable slot. The same connection may fill all
	// permitted slots; connection/model/lane limits remain enforced by the store.
	const pending = pendingRunners.get(config.dataDir) ?? new Set<Promise<void>>();
	if (options.background) pendingRunners.set(config.dataDir, pending);
	const occupied = Math.max(pending.size, (await localState.snapshot()).claims.length);
	const slots = Math.max(0, loaded.manifest.capacity.maxConcurrentWorkers - occupied);
	const tasks = ordered.length ? Array.from({ length: slots }, (_, index) => {
		const connection = ordered[index % ordered.length]!;
		const task = runConnection(connection);
		if (!options.background) return task;
		let owned: Promise<void>;
		owned = task.catch(error => { results.push({ connectionId: connection.connection.id, status: 'error',
			 reason: 'unleased_runner_failure', error: error instanceof Error ? error.message : String(error) }); })
			.finally(() => { pending.delete(owned); if (!pending.size) pendingRunners.delete(config.dataDir); });
		pending.add(owned);
		results.push({ connectionId: connection.connection.id, status: 'running' });
		return owned;
	}) : [];
	if (!options.background) await Promise.all(tasks);
	return {
		ok: results.every((entry) => entry.status !== 'recovery'),
		role: 'runner',
		background: options.background === true,
		results,
	};
}
