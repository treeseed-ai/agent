import type { ProviderConnectionConfig } from '@treeseed/sdk/capacity-provider/contracts';

export interface ProviderSchedulableConnection {
	connection: ProviderConnectionConfig;
}

export interface ProviderSlotLease<T extends ProviderSchedulableConnection> {
	id: string;
	connection: T;
	release(): void;
}

function schedulingWeight(connection: ProviderConnectionConfig) {
	return connection.offer.sharePercent ?? connection.offer.weight ?? 1;
}

/**
 * Provider-local weighted-deficit scheduler. Slot accounting is global to one
 * provider process while connection caps remain independently enforceable.
 */
export class ProviderGlobalSlotScheduler<T extends ProviderSchedulableConnection> {
	private connections: T[] = [];
	private readonly deficits = new Map<string, number>();
	private readonly activeByConnection = new Map<string, number>();
	private activeTotal = 0;
	private sequence = 0;

	constructor(readonly maxConcurrentSlots: number) {
		if (!Number.isInteger(maxConcurrentSlots) || maxConcurrentSlots < 1) {
			throw new Error('Provider-global maxConcurrentSlots must be a positive integer.');
		}
	}

	updateConnections(connections: T[]) {
		this.connections = connections.filter((entry) => entry.connection.enabled !== false);
		const ids = new Set(this.connections.map((entry) => entry.connection.id));
		for (const id of this.deficits.keys()) if (!ids.has(id)) this.deficits.delete(id);
	}

	snapshot() {
		return {
			maxConcurrentSlots: this.maxConcurrentSlots,
			activeTotal: this.activeTotal,
			availableSlots: Math.max(0, this.maxConcurrentSlots - this.activeTotal),
			connections: this.connections.map(({ connection }) => ({
				id: connection.id,
				weight: schedulingWeight(connection),
				active: this.activeByConnection.get(connection.id) ?? 0,
				maxConcurrentRunners: connection.offer.maxConcurrentRunners ?? this.maxConcurrentSlots,
				deficit: this.deficits.get(connection.id) ?? 0,
			})),
		};
	}

	acquire(): ProviderSlotLease<T> | null {
		if (this.activeTotal >= this.maxConcurrentSlots) return null;
		const eligible = this.connections.filter(({ connection }) =>
			(this.activeByConnection.get(connection.id) ?? 0) < (connection.offer.maxConcurrentRunners ?? this.maxConcurrentSlots));
		if (eligible.length === 0) return null;
		const totalWeight = eligible.reduce((total, { connection }) => total + schedulingWeight(connection), 0);
		for (const { connection } of eligible) {
			this.deficits.set(connection.id, (this.deficits.get(connection.id) ?? 0) + schedulingWeight(connection));
		}
		eligible.sort((left, right) =>
			(this.deficits.get(right.connection.id) ?? 0) - (this.deficits.get(left.connection.id) ?? 0)
			|| left.connection.id.localeCompare(right.connection.id));
		const selected = eligible[0];
		const connectionId = selected.connection.id;
		this.deficits.set(connectionId, (this.deficits.get(connectionId) ?? 0) - totalWeight);
		this.activeTotal += 1;
		this.activeByConnection.set(connectionId, (this.activeByConnection.get(connectionId) ?? 0) + 1);
		let released = false;
		return {
			id: `provider-slot-${++this.sequence}`,
			connection: selected,
			release: () => {
				if (released) return;
				released = true;
				this.activeTotal = Math.max(0, this.activeTotal - 1);
				this.activeByConnection.set(connectionId, Math.max(0, (this.activeByConnection.get(connectionId) ?? 1) - 1));
			},
		};
	}
}

export function providerManifestConcurrency(input: {
	executionProviders: Array<{ nativeLimits: Record<string, unknown> }>;
	hostLimit: number;
}) {
	const explicit = input.executionProviders
		.map((provider) => Number(provider.nativeLimits.maxConcurrentRunners))
		.filter((value) => Number.isInteger(value) && value > 0);
	const hostLimit = Math.max(1, Math.floor(input.hostLimit));
	const providerLimit = explicit.length > 0 ? explicit.reduce((total, value) => total + value, 0) : hostLimit;
	return Math.min(hostLimit, providerLimit);
}
