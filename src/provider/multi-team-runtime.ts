import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from './config.ts';
import { CapacityProviderCoordinator, type ProviderConnectionResult } from './coordinator.ts';
import { ProviderGlobalSlotScheduler, providerManifestConcurrency } from './connection-scheduler.ts';
import { loadProviderManifest } from './manifest.ts';
import { ProviderLocalCapacityStore, type ProviderLocalSlotClaim } from './local-capacity-store.ts';
import { recoverProviderLocalLeases } from './lease-recovery.ts';
import { discoverProviderBudgets } from './budgets.ts';
import { compileProviderLocalNativeLimit } from './native-capacity-limits.ts';
import { createAssignmentExecutionProviderAdapter } from './execution-provider-selection.ts';
import { createProviderMarketClient } from './client.ts';

const managerSchedulers = new Map<string, ProviderGlobalSlotScheduler<NonNullable<ProviderConnectionResult['runtime']>>>();

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return undefined;
}

function numberValue(...values: unknown[]) {
	for (const value of values) {
		const parsed = typeof value === 'number' ? value : Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function observeExecutionProviders(
	config: ProviderConnectionRuntimeContext,
	executionProviders: NonNullable<ProviderConnectionRuntimeContext['executionProviders']>,
) {
	const client = createProviderMarketClient(config);
	return Promise.all(executionProviders.map(async (provider) => {
		try {
			const adapter = createAssignmentExecutionProviderAdapter({
				selection: provider.adapter,
				repoRoot: process.cwd(),
				jira: config.jira,
				githubIssues: config.githubIssues,
				discord: config.discord,
				accessToken: config.accessToken,
				apiBaseUrl: config.marketUrl,
				researchSourcePolicy: provider.researchSourcePolicy,
				workflow: {
					dispatchWorkflowOperation: async (assignmentId, operationId, body) => {
						const response = await client.dispatchAssignmentWorkflowOperation(assignmentId, operationId, body);
						const value = record(response);
						return { ok: value.ok === undefined ? true : value.ok === true, payload: record(value.payload ?? value) };
					},
				},
			});
			const observation = await adapter.observe({
				capacityProviderId: config.providerId,
				executionProviderId: provider.id,
				activeAssignmentIds: [],
			});
			const descriptor = observation.descriptor ?? await adapter.describe();
			return {
				...provider,
				status: observation.available === true ? 'available' as const : 'unavailable' as const,
				capabilities: provider.capabilities ?? descriptor.capabilities,
				nativeUnit: descriptor.nativeUnit,
				quotaVisibility: descriptor.quotaVisibility,
				maxConcurrentRunners: Math.min(
					Number(provider.nativeLimits.maxConcurrentRunners ?? descriptor.maxConcurrentAssignments),
					descriptor.maxConcurrentAssignments,
				),
				activeRunners: observation.activeAssignmentCount ?? 0,
				observations: {
					available: observation.available === true,
					pressure: observation.pressure ?? 'exhausted',
					activeAssignmentCount: observation.activeAssignmentCount ?? 0,
				},
			};
		} catch {
			return {
				...provider,
				status: 'unavailable' as const,
				activeRunners: 0,
				observations: { available: false, pressure: 'exhausted', activeAssignmentCount: 0 },
			};
		}
	}));
}

export async function createCapacityProviderCoordinator(config: ProviderHostRuntimeConfig) {
	if (!config.manifestPath) throw new Error('TREESEED_CAPACITY_PROVIDER_MANIFEST is required for multi-team provider runtime.');
	return new CapacityProviderCoordinator(await loadProviderManifest(config.manifestPath), config.dataDir);
}

function connectionRuntimeContext(
	config: ProviderHostRuntimeConfig,
	connection: NonNullable<ProviderConnectionResult['runtime']>,
	executionProviders?: ProviderConnectionRuntimeContext['executionProviders'],
): ProviderConnectionRuntimeContext {
	return {
		...config,
		connectionId: connection.connection.id,
		marketUrl: connection.marketUrl,
		marketAudience: connection.marketAudience,
		teamId: connection.teamId,
		providerId: connection.providerId,
		membershipId: connection.membershipId,
		accessToken: connection.accessToken.accessToken,
		executionProviders,
		env: {
			...config.env,
			TREESEED_MARKET_URL: connection.marketUrl,
			TREESEED_MARKET_ID: connection.teamId,
		},
	};
}

export async function reconcileProviderConnections(config: ProviderHostRuntimeConfig) {
	return (await createCapacityProviderCoordinator(config)).reconcileAll();
}

export async function recoverMultiTeamProviderRunners(config: ProviderHostRuntimeConfig) {
	const connections = (await reconcileProviderConnections(config)).flatMap((connection) => connection.runtime ? [connection.runtime] : []);
	return recoverProviderLocalLeases({ config, connections });
}

export async function runMultiTeamProviderManager(config: ProviderHostRuntimeConfig, options: { mode?: 'plan' | 'live' } = {}) {
	if (options.mode === 'plan') {
		const loaded = await loadProviderManifest(config.manifestPath ?? '');
		return { ok: true, role: 'manager', mode: 'plan', connections: loaded.manifest.connections.map((connection) => ({ id: connection.id, teamId: connection.teamId ?? null, marketProfile: connection.marketProfile ?? null, marketUrl: connection.marketUrl ?? null, enabled: connection.enabled !== false, offer: connection.offer })) };
	}
	const loaded = await loadProviderManifest(config.manifestPath ?? '');
	const connections = await reconcileProviderConnections(config);
	const localState = new ProviderLocalCapacityStore(config.dataDir);
	const localCapacity = await localState.snapshot();
	const { runManagerSkeleton } = await import('./lifecycle.ts');
	const results = await Promise.all(connections.map(async (connection) => {
		if (!connection.runtime) return { ok: connection.status !== 'error', role: 'manager', connectionId: connection.connectionId, status: connection.status, ...(connection.error ? { error: connection.error } : {}) };
		try {
			const runtimeConfig = connectionRuntimeContext(config, connection.runtime, loaded.manifest.executionProviders);
			const observedExecutionProviders = await observeExecutionProviders(runtimeConfig, loaded.manifest.executionProviders);
			return await runManagerSkeleton(runtimeConfig, {
				availability: {
					offer: connection.runtime.connection.offer,
					executionProviders: observedExecutionProviders,
					activeRunners: localCapacity.claims.filter((claim) => claim.connectionId === connection.runtime?.connection.id).length,
				},
				localState,
			});
		} catch (error) {
			return { ok: false, role: 'manager', connectionId: connection.connectionId, status: 'error', error: error instanceof Error ? error.message : String(error) };
		}
	}));
	await Promise.all(connections.map((connection, index) => localState.setConnectionStatus(
		connection.connectionId,
		Boolean(connection.runtime && results[index]?.ok),
		results[index]?.ok ? undefined : String(record(results[index]).error ?? connection.error ?? connection.status),
	)));
	const connected = connections.flatMap((connection, index) => connection.runtime && results[index]?.ok ? [connection.runtime] : []);
	const concurrency = providerManifestConcurrency({ executionProviders: loaded.manifest.executionProviders, hostLimit: config.maxConcurrentRunners });
	let scheduler = managerSchedulers.get(loaded.path);
	if (!scheduler || scheduler.maxConcurrentSlots !== concurrency) {
		scheduler = new ProviderGlobalSlotScheduler(concurrency);
		managerSchedulers.set(loaded.path, scheduler);
	}
	scheduler.updateConnections(connected);
	const budgets = discoverProviderBudgets(config);
	const providerLimits = new Map(loaded.manifest.executionProviders.map((provider) => [provider.id, compileProviderLocalNativeLimit({ executionProviderId: provider.id, nativeLimits: provider.nativeLimits, budgets })]));
	const laneLimits = new Map(loaded.manifest.executionProviders.flatMap((provider) => (provider.lanes ?? []).map((lane) => [lane.id, { ...compileProviderLocalNativeLimit({ nativeLimits: lane.nativeLimits }), maxConcurrentRunners: lane.maxConcurrentRunners }] as const)));
	const { providerAssignmentLeaseSeconds, providerRunnerCapabilities } = await import('./runner.ts');
	const dispatches: Array<Record<string, unknown>> = [];
	for (let index = 0; index < concurrency; index += 1) {
		const schedulerLease = scheduler.acquire();
		if (!schedulerLease) break;
		const runtime = schedulerLease.connection;
		const connectionLimit = runtime.connection.offer.maxConcurrentRunners ?? concurrency;
		const claim = await localState.claim({ connectionId: runtime.connection.id, globalLimit: concurrency, connectionLimit });
		if (!claim) { schedulerLease.release(); break; }
		const connectionConfig = connectionRuntimeContext(config, runtime, loaded.manifest.executionProviders);
		const client = (await import('./client.ts')).createProviderMarketClient(connectionConfig);
		let leasedRecovery: { assignmentId: string; leaseToken: string; leaseExpiresAt: string; dispatchEnvelope: unknown } | null = null;
		try {
			const leased = await client.nextAssignment({ runnerId: claim.runnerId, capabilities: providerRunnerCapabilities(connectionConfig), leaseSeconds: providerAssignmentLeaseSeconds(connectionConfig) });
			const leasedRecord = record(leased);
			const assignment = record(leasedRecord.payload ?? leasedRecord.assignment);
			if (!Object.keys(assignment).length) {
				await localState.release(claim.id);
				dispatches.push({ connectionId: runtime.connection.id, assigned: 0 });
				continue;
			}
			const leaseToken = stringValue(leasedRecord.leaseToken, assignment.leaseToken);
			const assignmentId = stringValue(assignment.id);
			if (!leaseToken || !assignmentId) throw new Error('Assignment lease response omitted its assignment id or lease token.');
			const leaseSeconds = numberValue(leasedRecord.leaseSeconds) ?? 300;
			const leaseExpiresAt = stringValue(assignment.leaseExpiresAt) ?? new Date(Date.now() + leaseSeconds * 1000).toISOString();
			leasedRecovery = { assignmentId, leaseToken, leaseExpiresAt, dispatchEnvelope: leased };
			const executionProviderId = stringValue(assignment.executionProviderId);
			const laneId = stringValue(assignment.laneId);
			const capacityEnvelope = record(assignment.capacityEnvelope);
			const nativeUnit = stringValue(capacityEnvelope.nativeUnit);
			const requestedNativeAmount = numberValue(capacityEnvelope.reservedNativeAmount);
			await localState.attachLease(claim.id, {
				assignmentId, leaseToken, dispatchEnvelope: leased,
				leaseExpiresAt,
				...(executionProviderId ? { executionProviderId, executionProviderLimit: providerLimits.get(executionProviderId) } : {}),
				...(laneId ? { laneId, laneLimit: laneLimits.get(laneId) } : {}),
				...(numberValue(capacityEnvelope.reservedCredits, assignment.requestedCredits) !== undefined ? { requestedCredits: numberValue(capacityEnvelope.reservedCredits, assignment.requestedCredits) } : {}),
				...(nativeUnit ? { nativeUnit } : {}),
				...(requestedNativeAmount !== undefined ? { requestedNativeAmount } : {}),
			});
			dispatches.push({ connectionId: runtime.connection.id, assignmentId, status: 'ready' });
		} catch (error) {
			if (leasedRecovery) {
				await localState.retainLease(claim.id, leasedRecovery);
				try {
					await client.returnAssignment(leasedRecovery.assignmentId, { leaseToken: leasedRecovery.leaseToken, runnerId: claim.runnerId, reason: error instanceof Error ? error.message : String(error), code: 'provider_local_capacity_exhausted' });
					await localState.finalize(claim.id, 'capacity-rejected-return-confirmed');
				} catch (returnError) {
					await localState.recordFailure(claim.id, returnError instanceof Error ? returnError.message : String(returnError));
				}
			} else await localState.release(claim.id);
			dispatches.push({ connectionId: runtime.connection.id, status: 'error', error: error instanceof Error ? error.message : String(error) });
		} finally {
			schedulerLease.release();
		}
	}
	return { ok: true, role: 'manager', mode: 'multi-team', connections: results, scheduler: scheduler.snapshot(), dispatches };
}

export async function runMultiTeamProviderRunners(config: ProviderHostRuntimeConfig, options: {
	mode?: 'plan' | 'live';
	background?: boolean;
} = {}) {
	if (options.mode === 'plan') {
		const loaded = await loadProviderManifest(config.manifestPath ?? '');
		return { ok: true, role: 'runner', mode: 'plan', connections: loaded.manifest.connections.map((connection) => ({ id: connection.id, teamId: connection.teamId ?? null, enabled: connection.enabled !== false, maxConcurrentRunners: connection.offer.maxConcurrentRunners ?? null, capabilities: connection.offer.capabilities })) };
	}
	const loaded = await loadProviderManifest(config.manifestPath ?? '');
	const connections = await reconcileProviderConnections(config);
	const runtimeIds = new Set(connections.flatMap((connection) => connection.runtime ? [connection.runtime.connection.id] : []));
	const connectedIds = (await new ProviderLocalCapacityStore(config.dataDir).schedulableConnections()).filter((connectionId) => runtimeIds.has(connectionId));
	const concurrency = providerManifestConcurrency({ executionProviders: loaded.manifest.executionProviders, hostLimit: config.maxConcurrentRunners });
	const localCapacity = new ProviderLocalCapacityStore(config.dataDir);
	const leases: ProviderLocalSlotClaim[] = [];
	for (let index = 0; index < concurrency; index += 1) {
		const localClaim = await localCapacity.claimDispatch(connectedIds);
		if (!localClaim) break;
		leases.push(localClaim);
	}
	const { runProviderRunnerOnce } = await import('./runner-lifecycle.ts');
	const execute = async (localClaim: ProviderLocalSlotClaim) => {
		const runtime = connections.find((entry) => entry.runtime?.connection.id === localClaim.connectionId)?.runtime;
		if (!runtime) {
			await localCapacity.recordFailure(localClaim.id, 'Manager-created dispatch references an unavailable connection.');
			return { ok: false, role: 'runner', connectionId: localClaim.connectionId, error: 'Manager-created dispatch references an unavailable connection.' };
		}
		const connectionConfig = connectionRuntimeContext(config, runtime, loaded.manifest.executionProviders);
		const client = (await import('./client.ts')).createProviderMarketClient(connectionConfig);
		try {
			const result = await runProviderRunnerOnce({
				config: connectionConfig,
				client,
				runnerId: localClaim.runnerId,
				leasedAssignment: localClaim.dispatchEnvelope,
				...(connectionConfig.treeDx ? { treeDx: connectionConfig.treeDx } : {}),
			});
			await localCapacity.finalize(localClaim.id, 'assignment-lifecycle-confirmed');
			return result;
		} catch (error) {
			await localCapacity.recordFailure(localClaim.id, error instanceof Error ? error.message : String(error));
			return { ok: false, role: 'runner', connectionId: localClaim.connectionId, error: error instanceof Error ? error.message : String(error) };
		}
	};
	if (options.background) {
		for (const lease of leases) void execute(lease);
		return { ok: true, role: 'runner', mode: 'multi-team', background: true, dispatched: leases.length, pendingConnections: connections.filter((entry) => !entry.runtime) };
	}
	const results = await Promise.all(leases.map(execute));
	return { ok: true, role: 'runner', mode: 'multi-team', dispatched: leases.length, results, pendingConnections: connections.filter((entry) => !entry.runtime) };
}
