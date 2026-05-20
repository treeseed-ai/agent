import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { CapacityProviderBudgetCapacity } from '@treeseed/sdk/capacity-provider';
import type { ProviderRuntimeConfig } from './config.ts';

function budgetFromFile(path: string): CapacityProviderBudgetCapacity | null {
	if (!existsSync(path)) return null;
	const parsed = YAML.parse(readFileSync(path, 'utf8')) as unknown;
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as CapacityProviderBudgetCapacity;
	return null;
}

export function discoverProviderBudgets(config: ProviderRuntimeConfig): CapacityProviderBudgetCapacity {
	if (config.budgetFile) {
		const loaded = budgetFromFile(config.budgetFile);
		if (loaded) return loaded;
	}
	return {
		dailyCreditBudget: config.dailyCreditBudget,
		monthlyCreditBudget: config.monthlyCreditBudget,
		maxConcurrentWorkdays: config.maxConcurrentWorkdays,
		maxConcurrentRunners: config.maxConcurrentRunners,
	};
}
