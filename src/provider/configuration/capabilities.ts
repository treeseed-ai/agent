import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { CapacityProviderCapability } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from './config.ts';

function capabilitiesFromFile(path: string): CapacityProviderCapability[] | null {
	if (!existsSync(path)) return null;
	const parsed = YAML.parse(readFileSync(path, 'utf8')) as unknown;
	if (Array.isArray(parsed)) return parsed as CapacityProviderCapability[];
	if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { capabilities?: unknown }).capabilities)) {
		return (parsed as { capabilities: CapacityProviderCapability[] }).capabilities;
	}
	return null;
}

export function discoverProviderCapabilities(config: ProviderHostRuntimeConfig): CapacityProviderCapability[] {
	if (config.capabilitiesFile) {
		const loaded = capabilitiesFromFile(config.capabilitiesFile);
		if (loaded) return loaded;
	}
	const models = config.executorModule ? ['external-executor'] : [];
	return [{
		id: 'agent-execution',
		agents: ['*'],
		operations: ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat', 'release'],
		models,
		repositoryAccess: 'git_worktree',
		verification: ['local_command'],
		metadata: {
			capabilityAliases: ['agent_mode_run', 'repo_read', 'repo_write', 'repository_work'],
			source: 'provider_default_capability_discovery',
		},
	}];
}
