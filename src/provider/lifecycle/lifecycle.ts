import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ProviderSupplyOffer } from '@treeseed/sdk/capacity-provider/contracts';
import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { discoverProviderBudgets } from '../configuration/budgets.ts';
import { loadProviderManifest } from '../configuration/manifest.ts';
import { createProviderControlPlaneClient } from '../coordination/client.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { observeProviderDiskCapacity } from '../runtime/disk-capacity.ts';
import { SandboxBrokerClient } from '../execution/sandbox-broker-client.ts';

export function okPayload<T extends Record<string, unknown>>(role: string, payload: T) {
	return { ok: true as const, role, ...payload };
}

export async function checkProviderHealth(config: ProviderHostRuntimeConfig) {
	await mkdir(config.dataDir, { recursive: true });
	const writable = await access(config.dataDir, constants.W_OK).then(() => true, () => false);
	const disk = writable ? await observeProviderDiskCapacity({ path: config.dataDir, env: config.env }) : null;
	const manifest = config.manifestPath ? (await loadProviderManifest(config.manifestPath, config.dataDir)).manifest : null;
	const brokerSocket = manifest?.sandbox.required ? manifest.sandbox.brokerSocket : null;
	const broker = brokerSocket
		? await new SandboxBrokerClient(brokerSocket).status(AbortSignal.timeout(3_000))
			.then(() => ({ required: true, ready: true, socket: brokerSocket, reason: null }))
			.catch((error: unknown) => ({ required: true, ready: false, socket: brokerSocket, reason: error instanceof Error ? error.message : String(error) }))
		: { required: false, ready: true, socket: null, reason: null };
	return okPayload('healthcheck', {
		status: writable && disk?.ok && broker.ready ? 'ok' : 'degraded',
		environment: config.environment,
		dataDirWritable: writable,
		disk,
		manifestConfigured: Boolean(config.manifestPath),
		manifestVersion: manifest?.schemaVersion ?? null,
		executorConfigured: Boolean(manifest?.adapters.length),
		broker,
	});
}

export async function buildProviderPlan(config: ProviderHostRuntimeConfig) {
	const manifest = config.manifestPath
		? (await loadProviderManifest(config.manifestPath, config.dataDir)).manifest
		: null;
	const adapterCapabilities = manifest?.adapters.flatMap((adapter) => adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id))) ?? [];
	const capabilities = manifest
		? [...new Set([
			...adapterCapabilities,
			...manifest.lanes.flatMap((lane) => lane.capabilities ?? []),
		])].sort()
		: [];
	return okPayload('plan', {
		mode: 'plan',
		dataDir: config.dataDir,
		capabilities,
		capacity: manifest?.capacity ?? discoverProviderBudgets(config),
		lanes: manifest?.lanes ?? [],
		adapters: manifest?.adapters ?? [],
		executorConfigured: Boolean(manifest?.adapters.length),
		redactedEnv: config.redactedEnv,
	});
}

export interface ProviderAvailabilityProjection {
	manifestVersion?: number;
	offer?: ProviderSupplyOffer;
	adapters: Array<Record<string, unknown>>;
	lanes: Array<Record<string, unknown>>;
	capacity: Record<string, unknown>;
	activeWorkers?: number;
	constraints?: Record<string, unknown>;
}

export function providerAvailabilityCapabilities(availability: ProviderAvailabilityProjection) {
	return [...new Set([
		...availability.adapters.flatMap((adapter) => Array.isArray(adapter.capabilities) ? adapter.capabilities.filter((value): value is string => typeof value === 'string') : []),
		...availability.lanes.flatMap((lane) => Array.isArray(lane.capabilities) ? lane.capabilities.filter((value): value is string => typeof value === 'string') : []),
	])].sort();
}

export async function publishProviderAvailability(
	config: ProviderConnectionRuntimeContext,
	availability: ProviderAvailabilityProjection,
	localState = new ProviderLocalCapacityStore(config.dataDir),
) {
	const client = createProviderControlPlaneClient(config);
	const key = `${config.connectionId}|${config.teamId}|${config.providerId}`;
	const snapshot = {
		ttlSeconds: 90,
		environment: config.environment,
		status: 'open',
		offers: availability.adapters.flatMap((route) => Array.isArray(route.offers) ? route.offers.map((offer) => ({ offer, laneIds: route.laneIds, maxConcurrentWorkers: route.maxConcurrentWorkers, status: route.status, observations: route.observations })) : []),
		lanes: availability.lanes,
		capacity: availability.capacity,
		capabilities: providerAvailabilityCapabilities(availability),
		runnerPressure: { activeWorkers: availability.activeWorkers ?? 0,
			maxConcurrentWorkers: Number(availability.capacity.maxConcurrentWorkers ?? config.maxConcurrentRunners),
			activeAssignmentIds: [] },
		constraints: { outboundOnly: true, ...availability.constraints },
		metadata: {
			source: '@treeseed/agent/provider-manager',
			sourceClosureDigest: config.env.TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST ?? null,
		},
	};
	const prior = await localState.session(key);
	const session = prior
		? await client.refreshAvailabilitySession(prior.id, { ...snapshot, expectedSequence: prior.sequence }).catch(async () => {
			await localState.removeSession(key);
			return client.createAvailabilitySession(snapshot);
		})
		: await client.createAvailabilitySession(snapshot);
	await localState.saveSession(key, { id: session.id, sequence: session.sequence });
	return okPayload('manager', {
		action: 'availability-session-published',
		session: { id: session.id, sequence: session.sequence, status: session.status },
	});
}

export function buildProviderRunnerPlan(config: ProviderHostRuntimeConfig) {
	return okPayload('runner', {
		mode: 'plan',
		executorConfigured: true,
		flow: [
			'read API-issued assignment lease',
			'execute through trusted Agent executor',
			'report usage and exact terminal receipt',
		],
	});
}
