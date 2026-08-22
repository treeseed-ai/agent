import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ProviderSupplyOffer } from '@treeseed/sdk/capacity-provider/contracts';
import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { discoverProviderBudgets } from '../configuration/budgets.ts';
import { discoverProviderCapabilities } from '../configuration/capabilities.ts';
import { createProviderControlPlaneClient } from '../coordination/client.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { observeProviderDiskCapacity } from '../runtime/disk-capacity.ts';

export function okPayload(role: string, payload: Record<string, unknown> = {}) {
	return { ok: true, role, ...payload };
}

export async function checkProviderHealth(config: ProviderHostRuntimeConfig) {
	await mkdir(config.dataDir, { recursive: true });
	const writable = await access(config.dataDir, constants.W_OK).then(() => true, () => false);
	const disk = writable ? await observeProviderDiskCapacity({ path: config.dataDir, env: config.env }) : null;
	return okPayload('healthcheck', {
		status: writable && disk?.ok ? 'ok' : 'degraded',
		environment: config.environment,
		dataDirWritable: writable,
		disk,
		manifestConfigured: Boolean(config.manifestPath),
		executorConfigured: Boolean(config.executorModule),
	});
}

export async function buildProviderPlan(config: ProviderHostRuntimeConfig) {
	return okPayload('plan', {
		mode: 'plan',
		dataDir: config.dataDir,
		capabilities: discoverProviderCapabilities(config).map((capability) => capability.id),
		budgets: discoverProviderBudgets(config),
		executorConfigured: Boolean(config.executorModule),
		redactedEnv: config.redactedEnv,
	});
}

export interface ProviderAvailabilityProjection {
	offer?: ProviderSupplyOffer;
	executionProviders: Array<Record<string, unknown>>;
	activeRunners?: number;
	constraints?: Record<string, unknown>;
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
		executionProviders: availability.executionProviders,
		capabilities: discoverProviderCapabilities(config),
		nativeLimits: discoverProviderBudgets(config),
		runnerPressure: { activeRunners: availability.activeRunners ?? 0, maxConcurrentRunners: config.maxConcurrentRunners },
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
		executorConfigured: Boolean(config.executorModule),
		flow: [
			'read API-issued assignment lease',
			'execute through trusted Agent executor',
			'report usage and exact terminal receipt',
		],
	});
}
