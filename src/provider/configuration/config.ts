import { existsSync, readFileSync } from 'node:fs';
import type { CapacityProviderManifest } from '@treeseed/sdk/capacity-provider';

export type ProviderRole = 'manager' | 'runner' | 'enroll' | 'doctor' | 'healthcheck' | 'plan' | 'version';

const packageVersion = String(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version);

export interface ProviderHostRuntimeConfig {
  dataDir: string;
  environment: string;
  maxConcurrentRunners: number;
  maxConcurrentWorkdays: number;
  capabilitiesFile: string | null;
  budgetFile: string | null;
  dailyAgentSecondsLimit: number | null;
  monthlyAgentSecondsLimit: number | null;
  executorModule: string | null;
  env: Record<string, string>;
  redactedEnv: Record<string, string>;
  manifestPath: string | null;
}

export interface ProviderConnectionRuntimeContext extends ProviderHostRuntimeConfig {
  connectionId: string;
  controlPlaneUrl: string;
  controlPlaneAudience: string;
  teamId: string;
  providerId: string;
  membershipId: string;
  accessToken: string;
  accessTokenProvider?: (minimumValidityMs?: number) => Promise<string>;
  adapters: CapacityProviderManifest['adapters'];
  lanes: CapacityProviderManifest['lanes'];
  providerCapacity: CapacityProviderManifest['capacity'];
}

function value(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim() || '';
}

function positiveInteger(raw: string, fallback: number) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalInteger(raw: string) {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveProviderConfig(options: { env?: NodeJS.ProcessEnv; requireConnection?: boolean } = {}): ProviderHostRuntimeConfig {
  const source = options.env ?? process.env;
  const configuredManifest = value(source, 'TREESEED_CAPACITY_PROVIDER_MANIFEST');
  const manifestPath = configuredManifest || (existsSync('treeseed.capacity-provider.yaml') ? 'treeseed.capacity-provider.yaml' : null);
  if (options.requireConnection && !manifestPath) {
    throw new Error('Capacity provider runtime requires TREESEED_CAPACITY_PROVIDER_MANIFEST or treeseed.capacity-provider.yaml.');
  }
  const env = {
    TREESEED_PROVIDER_DATA_DIR: value(source, 'TREESEED_PROVIDER_DATA_DIR') || '/data',
    TREESEED_PROVIDER_ENVIRONMENT: value(source, 'TREESEED_PROVIDER_ENVIRONMENT') || value(source, 'TREESEED_ENVIRONMENT') || 'local',
    ...(value(source, 'TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST') ? { TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST: value(source, 'TREESEED_PROVIDER_SOURCE_CLOSURE_DIGEST') } : {}),
    ...(value(source, 'TREESEED_MIN_FREE_DISK_BYTES') ? { TREESEED_MIN_FREE_DISK_BYTES: value(source, 'TREESEED_MIN_FREE_DISK_BYTES') } : {}),
  };
  return {
    dataDir: env.TREESEED_PROVIDER_DATA_DIR,
    environment: env.TREESEED_PROVIDER_ENVIRONMENT,
    maxConcurrentRunners: positiveInteger(value(source, 'TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS'), 1),
    maxConcurrentWorkdays: positiveInteger(value(source, 'TREESEED_PROVIDER_MAX_CONCURRENT_WORKDAYS'), 1),
    capabilitiesFile: value(source, 'TREESEED_PROVIDER_CAPABILITIES_FILE') || null,
    budgetFile: value(source, 'TREESEED_PROVIDER_BUDGET_FILE') || null,
    dailyAgentSecondsLimit: optionalInteger(value(source, 'TREESEED_PROVIDER_DAILY_AGENT_SECONDS_LIMIT')),
    monthlyAgentSecondsLimit: optionalInteger(value(source, 'TREESEED_PROVIDER_MONTHLY_AGENT_SECONDS_LIMIT')),
    executorModule: value(source, 'TREESEED_AGENT_EXECUTOR_MODULE') || null,
    env,
    redactedEnv: { ...env, ...(value(source, 'TREESEED_AGENT_EXECUTOR_MODULE') ? { TREESEED_AGENT_EXECUTOR_MODULE: '<configured>' } : {}) },
    manifestPath,
  };
}

export function providerRuntimeVersion() {
  return packageVersion;
}
