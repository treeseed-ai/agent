import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { CapacityProviderManifest, CapacityProviderManifestV3, CapacityProviderManifestV4, CapacityProviderManifestV5 } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { AgentExecutor, AgentExecutorModule } from './contracts.ts';
import { createProcessIsolatedExecutor } from './process-executor.ts';
import { createMicrovmExecutor } from './microvm-executor.ts';

const cache = new Map<string, Promise<AgentExecutorModule>>();

const EXECUTOR_MODULES: Readonly<Record<string, string>> = {
  'module:codex-chat': '@treeseed/agent/executors/codex-chat',
};

export function executorModuleSpecifier(identifier: string) {
  const specifier = EXECUTOR_MODULES[identifier] ?? (identifier.startsWith('builtin:') || identifier.startsWith('module:') ? null : identifier);
  if (!specifier) throw new Error(`Unknown capacity provider executor module identifier ${identifier}.`);
  return specifier;
}

async function loadModule(specifier: string) {
  specifier = executorModuleSpecifier(specifier);
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

export async function resolveAgentExecutor(config: ProviderHostRuntimeConfig, adapter: CapacityProviderManifest['adapters'][number], manifest: CapacityProviderManifest): Promise<AgentExecutor | null> {
  const module = adapter.module ?? config.executorModule;
  if (!module) return null;
  const specifier = executorModuleSpecifier(module);
  if (adapter.isolation === 'microvm') return createMicrovmExecutor(config, manifest as CapacityProviderManifestV4 | CapacityProviderManifestV5, adapter as CapacityProviderManifestV4['adapters'][number] | CapacityProviderManifestV5['adapters'][number]);
  if (adapter.isolation === 'process') return createProcessIsolatedExecutor(config, manifest as CapacityProviderManifestV3, adapter as CapacityProviderManifestV3['adapters'][number], specifier);
  if ((adapter.credentialProfiles?.length ?? 0) > 0) throw new Error(`Worker-isolated adapter ${adapter.id} may not receive credential profiles.`);
  const executor = await (await loadModule(specifier)).createAgentExecutor({ executionProviderId: adapter.id, environment: config.environment });
  if (!executor || typeof executor.execute !== 'function' || typeof executor.observe !== 'function') {
    throw new Error('Agent executor module returned an invalid executor.');
  }
  return executor;
}
