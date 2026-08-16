import type { ProviderConnectionConfig } from '@treeseed/sdk/capacity-provider/contracts';
import type { MinimumAssignmentDuration } from '@treeseed/sdk/capacity-provider/contracts';

interface ExecutionProviderAvailability {
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
	lanes?: Array<{
		id: string;
		purpose: 'communication' | 'operation';
		maxConcurrentRunners: number;
		minimumAssignmentDuration?: MinimumAssignmentDuration;
		capabilities?: string[];
		nativeLimits?: Record<string, unknown>;
	}>;
}

function intersection(values: string[] | undefined, allowed: Set<string>) {
	return values?.filter((value) => allowed.has(value));
}

function narrowedNativeLimits(limits: Record<string, unknown>, maxConcurrentRunners: number) {
	const declared = Number(limits.maxConcurrentRunners);
	return {
		...limits,
		...(Number.isFinite(declared) ? { maxConcurrentRunners: Math.min(declared, maxConcurrentRunners) } : {}),
	};
}

/** Projects provider-global facts into the strict capability scope offered to one team. */
export function compileConnectionAvailability(input: {
	connection: ProviderConnectionConfig;
	executionProviders: ExecutionProviderAvailability[];
	hostMaxConcurrentRunners: number;
	defaultExecutionProviderId?: string;
}) {
	const allowed = new Set(input.connection.offer.capabilities);
	const maxConcurrentRunners = Math.max(0, Math.min(
		input.hostMaxConcurrentRunners,
		input.connection.offer.maxConcurrentRunners ?? input.hostMaxConcurrentRunners,
	));
	return {
		capabilities: [...allowed].sort(),
		maxConcurrentRunners,
		executionProviders: input.executionProviders.map((provider) => ({
			...provider,
			preferred: provider.id === input.defaultExecutionProviderId,
			nativeLimits: narrowedNativeLimits(provider.nativeLimits, maxConcurrentRunners),
			...(provider.capabilities ? { capabilities: intersection(provider.capabilities, allowed) } : {}),
			...(provider.lanes ? {
				lanes: provider.lanes.map((lane) => ({
					...lane,
					maxConcurrentRunners: Math.min(lane.maxConcurrentRunners, maxConcurrentRunners),
					...(lane.nativeLimits ? { nativeLimits: narrowedNativeLimits(lane.nativeLimits, maxConcurrentRunners) } : {}),
					...(lane.capabilities ? { capabilities: intersection(lane.capabilities, allowed) } : {}),
				})),
			} : {}),
		})),
	};
}
