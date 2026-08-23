import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { CapacityProviderManifestV3 } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { AgentExecutor, AgentExecutorModule } from './contracts.ts';
import { createProcessIsolatedExecutor } from './process-executor.ts';

const cache = new Map<string, Promise<AgentExecutorModule>>();

async function loadModule(specifier: string) {
  const key = isAbsolute(specifier) || specifier.startsWith('.') ? pathToFileURL(resolve(specifier)).href : specifier;
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = import(key).then((value) => value as AgentExecutorModule);
    cache.set(key, loaded);
  }
  const module = await loaded;
  if (typeof module.createAgentExecutor !== 'function') throw new Error('Agent executor module must export createAgentExecutor().');
  return module;
}

export async function resolveAgentExecutor(config: ProviderHostRuntimeConfig, adapter: CapacityProviderManifestV3['adapters'][number], manifest: CapacityProviderManifestV3): Promise<AgentExecutor | null> {
  const module = adapter.module ?? config.executorModule;
  if (!module) return null;
  if (adapter.isolation === 'process') return createProcessIsolatedExecutor(config, manifest, adapter, module);
  if ((adapter.credentialProfiles?.length ?? 0) > 0) throw new Error(`Worker-isolated adapter ${adapter.id} may not receive credential profiles.`);
  const executor = await (await loadModule(module)).createAgentExecutor({ executionProviderId: adapter.id, environment: config.environment });
  if (!executor || typeof executor.execute !== 'function' || typeof executor.observe !== 'function') {
    throw new Error('Agent executor module returned an invalid executor.');
  }
  return executor;
}
