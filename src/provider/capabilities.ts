import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { CapacityProviderCapability } from '@treeseed/sdk/capacity-provider';
import type { ProviderRuntimeConfig } from './config.ts';

function capabilitiesFromFile(path: string): CapacityProviderCapability[] | null {
	if (!existsSync(path)) return null;
	const parsed = YAML.parse(readFileSync(path, 'utf8')) as unknown;
	if (Array.isArray(parsed)) return parsed as CapacityProviderCapability[];
	if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { capabilities?: unknown }).capabilities)) {
		return (parsed as { capabilities: CapacityProviderCapability[] }).capabilities;
	}
	return null;
}

export function discoverProviderCapabilities(config: ProviderRuntimeConfig): CapacityProviderCapability[] {
	if (config.capabilitiesFile) {
		const loaded = capabilitiesFromFile(config.capabilitiesFile);
		if (loaded) return loaded;
	}
	return [{
		id: 'codex-docs-work',
		agents: ['treeseed-docs-planner', 'treeseed-docs-engineer', 'treeseed-docs-reviewer'],
		operations: ['plan', 'research', 'mutate', 'verify', 'report'],
		models: ['codex'],
		repositoryAccess: 'git_worktree',
		verification: ['local_command'],
	}];
}
