import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { AgentExecutor, AgentExecutorModule } from './contracts.ts';

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

export async function resolveAgentExecutor(config: ProviderHostRuntimeConfig, executionProviderId: string): Promise<AgentExecutor | null> {
  if (!config.executorModule) return null;
  const executor = await (await loadModule(config.executorModule)).createAgentExecutor({ executionProviderId, environment: config.environment });
  if (!executor || typeof executor.execute !== 'function' || typeof executor.observe !== 'function') {
    throw new Error('Agent executor module returned an invalid executor.');
  }
  return executor;
}
