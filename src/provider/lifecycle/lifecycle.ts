import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ProviderSupplyOffer } from '@treeseed/sdk/capacity-provider/contracts';
import type { MinimumAssignmentDuration } from '@treeseed/sdk/capacity-provider/contracts';
import type { ProviderConnectionRuntimeContext, ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { discoverProviderBudgets } from '../configuration/budgets.ts';
import { discoverProviderCapabilities } from '../configuration/capabilities.ts';
import { createProviderMarketClient } from '../coordination/client.ts';
import { compileConnectionAvailability } from '../projects/projects-core/availability-projection.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';
import { observeProviderDiskCapacity } from '../runtime/disk-capacity.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function okPayload(role: string, payload: Record<string, unknown> = {}) {
	return {
		ok: true,
		role,
		...payload,
	};
}

export async function checkProviderHealth(config: ProviderHostRuntimeConfig) {
	let dataDirWritable = false;
	try {
		await mkdir(config.dataDir, { recursive: true });
		await access(config.dataDir, constants.W_OK);
		dataDirWritable = true;
	} catch {
		dataDirWritable = false;
	}
	const diskCapacity = dataDirWritable
		? await observeProviderDiskCapacity({ path: config.dataDir, env: config.env })
		: null;
	return okPayload('healthcheck', {
		status: dataDirWritable && diskCapacity?.ok ? 'ok' : 'degraded',
		environment: config.environment,
		dataDir: config.dataDir,
		dataDirWritable,
		diskCapacity,
		manifestConfigured: Boolean(config.manifestPath),
		codexReady: Boolean(config.codexAuthFile || config.codexAuthJsonB64),
	});
}

export async function buildProviderPlan(config: ProviderHostRuntimeConfig) {
	const base = {
		environment: config.environment,
		dataDir: config.dataDir,
		capabilities: discoverProviderCapabilities(config),
		budgets: discoverProviderBudgets(config),
		redactedEnv: config.redactedEnv,
	};
	return okPayload('plan', {
		...base,
		mode: 'plan',
	});
}

interface ProviderManagerAvailability {
	offer?: ProviderSupplyOffer;
	executionProviders?: Array<{
		id: string;
		adapter: string;
		nativeLimits: Record<string, unknown>;
		minimumAssignmentDuration?: MinimumAssignmentDuration;
		capabilities?: string[];
		status?: 'available' | 'unavailable';
		nativeUnit?: string;
		quotaVisibility?: string;
		maxConcurrentRunners?: number;
		activeRunners?: number;
		observations?: Record<string, unknown>;
	}>;
	activeRunners?: number;
	constraints?: Record<string, unknown>;
}

function positiveFinite(values: Array<number | null | undefined>) {
	return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function availableAgentSeconds(config: ProviderHostRuntimeConfig, availability?: ProviderManagerAvailability) {
	const declared = positiveFinite(availability?.executionProviders?.map((provider) => Number(provider.nativeLimits.availableAgentSeconds)) ?? []);
	return declared.length > 0 ? Math.min(...declared) : Math.max(1, config.maxConcurrentRunners) * 86_400;
}

function availabilitySessionKey(config: ProviderConnectionRuntimeContext) {
	return `${config.connectionId}|${config.teamId}|${config.providerId}`;
}

async function publishAvailabilitySession(
	config: ProviderConnectionRuntimeContext,
	client: ReturnType<typeof createProviderMarketClient>,
	availability: ProviderManagerAvailability | undefined,
	capabilities: string[],
	localState: ProviderLocalCapacityStore,
) {
	const budgets = discoverProviderBudgets(config);
	const scopedProjection = availability?.offer
		? compileConnectionAvailability({ connection: { id: config.connectionId, marketUrl: config.marketUrl, teamId: config.teamId, providerId: config.providerId, membershipId: config.membershipId, membershipCredentialRef: 'runtime://redacted', membershipCredentialId: 'runtime-redacted', offer: availability.offer }, executionProviders: availability.executionProviders ?? [], hostMaxConcurrentRunners: config.maxConcurrentRunners, defaultExecutionProviderId: config.defaultExecutionProviderId })
		: { capabilities, executionProviders: availability?.executionProviders ?? [], maxConcurrentRunners: config.maxConcurrentRunners };
	const projection = {
		...scopedProjection,
		executionProviders: scopedProjection.executionProviders.map((provider) => ({
			...provider,
			preferred: provider.id === config.defaultExecutionProviderId,
		})),
	};
	const maxConcurrentRunners = projection.maxConcurrentRunners;
	const nativeLimits = {
		...budgets,
		availableAgentSeconds: availableAgentSeconds(config, availability),
		maxConcurrentRunners,
	};
	const snapshot = {
		ttlSeconds: 90,
		environment: config.environment,
		status: 'open',
		availableFrom: availability?.offer?.availability?.availableFrom ?? new Date().toISOString(),
		availableUntil: availability?.offer?.availability?.availableUntil ?? null,
		executionProviders: projection.executionProviders,
		capabilities: projection.capabilities,
		nativeLimits,
		runnerPressure: {
			activeRunners: availability?.activeRunners ?? 0,
			maxConcurrentRunners,
			maxConcurrentWorkdays: config.maxConcurrentWorkdays,
		},
		constraints: {
			outboundOnly: true,
			dataDir: config.dataDir,
			availableAgentSeconds: nativeLimits.availableAgentSeconds,
			maxConcurrentRunners,
			...(availability?.constraints ?? {}),
		},
		metadata: {
			source: '@treeseed/agent/provider-manager',
			sourceClosureDigest: config.env.TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST ?? null,
		},
	};
	const key = availabilitySessionKey(config);
	const existing = await localState.session(key);
	if (existing) {
		try {
			const refreshed = await client.refreshAvailabilitySession(existing.id, { ...snapshot, expectedSequence: existing.sequence });
			const payload = record(refreshed.payload);
			await localState.saveSession(key, { id: existing.id, sequence: Number(payload.sequence ?? existing.sequence + 1) });
			return refreshed;
		} catch {
			await localState.removeSession(key);
		}
	}
	const created = await client.createAvailabilitySession(snapshot);
	const payload = record(created.payload);
	const id = String(payload.id ?? '');
	if (!id) throw new Error('Capacity provider availability session response did not include a session id.');
	await localState.saveSession(key, { id, sequence: Number(payload.sequence ?? 1) });
	return created;
}

export async function runManagerSkeleton(config: ProviderConnectionRuntimeContext, options: { mode?: 'plan' | 'live'; availability?: ProviderManagerAvailability; localState?: ProviderLocalCapacityStore } = {}) {
	if (options.mode !== 'plan') {
		const client = createProviderMarketClient(config);
		const capabilities = [...new Set(discoverProviderCapabilities(config).flatMap((capability) => [
			capability.id,
			...(Array.isArray(capability.metadata?.capabilityAliases)
				? capability.metadata.capabilityAliases.map((entry) => String(entry ?? '').trim()).filter(Boolean)
				: []),
		]).filter(Boolean))];
		const availabilitySession = await publishAvailabilitySession(config, client, options.availability, capabilities, options.localState ?? new ProviderLocalCapacityStore(config.dataDir));
		return okPayload('manager', {
			action: 'availability-session-published',
			mode: 'live',
			availabilitySession: availabilitySession.payload,
		});
	}
	const plan = await buildProviderPlan(config);
	return okPayload('manager', {
		action: 'availability-plan',
		mode: 'plan',
		plan,
	});
}

export function buildProviderRunnerPlan(config: ProviderHostRuntimeConfig) {
	return okPayload('runner', {
		mode: 'plan',
		flow: [
			'claim a manager-created durable leased-assignment dispatch',
		'record provider-local mode-run telemetry',
		'complete or fail assignment without widening scope',
		],
		assignmentRequest: { capabilities: discoverProviderCapabilities(config).map((capability) => capability.id) },
	});
}
