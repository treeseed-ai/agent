import type { CapacityProviderBudgetCapacity } from '@treeseed/sdk/capacity-provider';

export interface ProviderLocalNativeLimit {
	maxConcurrentRunners?: number;
	availableAgentSeconds?: number;
	nativeAllowances?: Record<string, number>;
}

function positive(value: unknown) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function allowancesFromRecord(limits: Record<string, unknown>) {
	const allowances: Record<string, number> = {};
	for (const [unit, value] of Object.entries(record(limits.nativeAllowances))) {
		const amount = positive(value);
		if (amount !== undefined) allowances[unit] = amount;
	}
	const unit = typeof limits.nativeUnit === 'string' ? limits.nativeUnit.trim() : '';
	const amount = positive(limits.availableNativeAmount);
	if (unit && amount !== undefined) allowances[unit] = Math.min(allowances[unit] ?? amount, amount);
	return allowances;
}

function budgetAllowances(budgets: CapacityProviderBudgetCapacity, executionProviderId: string) {
	const provider = budgets.nativeCapacity?.executionProviders.find((entry) => entry.id === executionProviderId);
	const allowances: Record<string, number> = {};
	for (const limit of provider?.nativeLimits ?? []) {
		const unit = limit.nativeUnit ?? provider?.nativeUnit;
		const amount = positive(limit.limitAmount);
		if (!unit || amount === undefined) continue;
		const available = amount * (1 - Math.min(100, Math.max(0, Number(limit.reserveBufferPercent ?? 0))) / 100);
		allowances[unit] = Math.min(allowances[unit] ?? available, available);
	}
	return allowances;
}

function mergeStrictest(...sets: Array<Record<string, number>>) {
	const merged: Record<string, number> = {};
	for (const set of sets) for (const [unit, amount] of Object.entries(set)) merged[unit] = Math.min(merged[unit] ?? amount, amount);
	return merged;
}

export function compileProviderLocalNativeLimit(input: {
	executionProviderId?: string;
	nativeLimits?: Record<string, unknown>;
	budgets?: CapacityProviderBudgetCapacity;
}): ProviderLocalNativeLimit {
	const limits = input.nativeLimits ?? {};
	const nativeAllowances = mergeStrictest(
		allowancesFromRecord(limits),
		input.executionProviderId && input.budgets ? budgetAllowances(input.budgets, input.executionProviderId) : {},
	);
	return {
		...(positive(limits.maxConcurrentRunners) !== undefined ? { maxConcurrentRunners: positive(limits.maxConcurrentRunners) } : {}),
		...(positive(limits.availableAgentSeconds) !== undefined ? { availableAgentSeconds: positive(limits.availableAgentSeconds) } : {}),
		...(Object.keys(nativeAllowances).length ? { nativeAllowances } : {}),
	};
}
