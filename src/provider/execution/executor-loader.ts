import type { CapacityProviderManifestV5 } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { AgentExecutor } from './contracts.ts';
import { createMicrovmExecutor } from './microvm-executor.ts';

export async function resolveAgentExecutor(config: ProviderHostRuntimeConfig, adapter: CapacityProviderManifestV5['adapters'][number], manifest: CapacityProviderManifestV5): Promise<AgentExecutor> {
	if (adapter.isolation !== 'microvm') throw new Error(`Capacity offer adapter ${adapter.id} must use microVM isolation.`);
	return createMicrovmExecutor(config, manifest, adapter);
}
