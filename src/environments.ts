import { z } from 'zod';
import {
  CanonicalJson, CapabilityToken, EnvironmentSchemas, EnvironmentNetwork,
  PlatformSchemas, ProviderV4Schemas, SeedSchemas,
  type EnvironmentDefinition, type EnvironmentNetworkPolicy,
} from '@treeseed-cordis/sdk';
import { Context, CordisServiceLocator, type ProviderLease } from '@treeseed-cordis/sdk/runtime';
import { AgentDeclaration } from './providers.js';

export interface EnvironmentTarget { sandboxId: string; runnerGeneration: string }
export interface EnvironmentAdmission {
  target: EnvironmentTarget;
  authorityDigest: string;
  host: EnvironmentNetworkPolicy;
  assignment: EnvironmentNetworkPolicy;
}
export interface EnvironmentAuthority {
  admit(target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentAdmission>;
}
export interface EnvironmentExecutionRequest {
  environment: EnvironmentDefinition;
  phase: 'setup' | 'verification';
  target: EnvironmentTarget;
  network: EnvironmentNetworkPolicy;
}
export interface EnvironmentExecutionReceipt {
  target: EnvironmentTarget;
  environmentRevision: string;
  entryDigest: string;
  networkDigest: string;
  exitCode: number;
  outputBytes: number;
}
export interface EnvironmentExecutor {
  execute(request: EnvironmentExecutionRequest, signal: AbortSignal): Promise<EnvironmentExecutionReceipt>;
}
export interface EnvironmentPreparationReceipt {
  id: string;
  revision: string;
  target: EnvironmentTarget;
  networkDigest: string;
}
export interface EnvironmentPreparer {
  prepare(input: unknown, target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentPreparationReceipt>;
}
type PreparationCode = 'ENVIRONMENT_CONTRACT_INVALID' | 'ENVIRONMENT_AUTHORITY_INVALID'
  | 'ENVIRONMENT_AUTHORITY_CHANGED' | 'ENVIRONMENT_POLICY_DENIED' | 'ENVIRONMENT_EXECUTION_FAILED'
  | 'ENVIRONMENT_CANCELLED' | 'ENVIRONMENT_DEADLINE_EXCEEDED' | 'ENVIRONMENT_PROVIDER_UNAVAILABLE'
  | 'ENVIRONMENT_DISPOSAL_FAILED';
export class EnvironmentPreparationError extends Error {
  constructor(readonly code: PreparationCode) {
    super(code);
    this.name = 'EnvironmentPreparationError';
  }
}
class PreparationSchemas {
  static readonly target = z.strictObject({ sandboxId: SeedSchemas.key, runnerGeneration: PlatformSchemas.digest });
  static readonly admission = z.strictObject({
    target: this.target, authorityDigest: PlatformSchemas.digest,
    host: EnvironmentSchemas.network, assignment: EnvironmentSchemas.network,
  });
  static readonly execution = z.strictObject({
    target: this.target, environmentRevision: PlatformSchemas.digest,
    entryDigest: PlatformSchemas.digest, networkDigest: PlatformSchemas.digest,
    exitCode: z.number().int().min(0).max(255),
    outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  });
  static parse<T>(schema: z.ZodType<T>, input: unknown, code: PreparationCode): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new EnvironmentPreparationError(code);
    return parsed.data;
  }
}
class EnvironmentAdapter<T extends object> {
  constructor(private readonly method: string) {}
  parse(input: unknown): T {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, this.method) !== 'function')
      throw new EnvironmentPreparationError('ENVIRONMENT_PROVIDER_UNAVAILABLE');
    return input as T;
  }
}
export class EnvironmentTokens {
  static readonly preparation = new CapabilityToken<EnvironmentPreparer>(
    'agent.environment', ProviderV4Schemas.version, new EnvironmentAdapter('prepare'),
  );
  static readonly authority = new CapabilityToken<EnvironmentAuthority>(
    'agent.environment.authority', ProviderV4Schemas.version, new EnvironmentAdapter('admit'),
  );
  static readonly execution = new CapabilityToken<EnvironmentExecutor>(
    'agent.environment.execution', ProviderV4Schemas.version, new EnvironmentAdapter('execute'),
  );
}

/** One guest operation: accepted provider leases remain held until all execution actually ends. */
class EnvironmentPreparationRun {
  constructor(
    private readonly environment: EnvironmentDefinition,
    private readonly target: EnvironmentTarget,
    private readonly authority: EnvironmentAuthority,
    private readonly executor: EnvironmentExecutor,
    private readonly signal: AbortSignal,
  ) {}
  async run(): Promise<EnvironmentPreparationReceipt> {
    const admitted = await this.admission();
    const network = this.network(admitted);
    await this.execute('setup', network);
    await this.unchanged(admitted);
    await this.execute('verification', network);
    await this.unchanged(admitted);
    return {
      id: this.environment.id, revision: this.environment.revision,
      target: structuredClone(this.target), networkDigest: CanonicalJson.digest(network),
    };
  }
  private checkpoint(): void {
    if (this.signal.aborted) throw new EnvironmentPreparationError('ENVIRONMENT_CANCELLED');
  }
  private async admission(): Promise<EnvironmentAdmission> {
    this.checkpoint();
    let input: unknown;
    try {
      input = await this.authority.admit(structuredClone(this.target), this.signal);
    } catch {
      this.checkpoint();
      throw new EnvironmentPreparationError('ENVIRONMENT_AUTHORITY_INVALID');
    }
    this.checkpoint();
    const admitted = PreparationSchemas.parse(PreparationSchemas.admission, input, 'ENVIRONMENT_AUTHORITY_INVALID');
    if (CanonicalJson.stringify(admitted.target) !== CanonicalJson.stringify(this.target))
      throw new EnvironmentPreparationError('ENVIRONMENT_AUTHORITY_CHANGED');
    return admitted;
  }
  private network(admission: EnvironmentAdmission): EnvironmentNetworkPolicy {
    try {
      return EnvironmentNetwork.intersect(this.environment.network, admission.host, admission.assignment);
    } catch {
      throw new EnvironmentPreparationError('ENVIRONMENT_POLICY_DENIED');
    }
  }
  private async unchanged(expected: EnvironmentAdmission): Promise<void> {
    const current = await this.admission();
    if (CanonicalJson.stringify(current) !== CanonicalJson.stringify(expected))
      throw new EnvironmentPreparationError('ENVIRONMENT_AUTHORITY_CHANGED');
  }
  private async execute(phase: 'setup' | 'verification', network: EnvironmentNetworkPolicy): Promise<void> {
    this.checkpoint();
    const entry = this.environment[phase];
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(entry.deadlineMs)]);
    try {
      const request = structuredClone({ environment: this.environment, phase, target: this.target, network });
      const result = await this.executor.execute(request, signal);
      this.checkpoint();
      if (signal.aborted) throw new EnvironmentPreparationError('ENVIRONMENT_DEADLINE_EXCEEDED');
      this.receipt(result, entry, network);
    } catch {
      this.checkpoint();
      if (signal.aborted) throw new EnvironmentPreparationError('ENVIRONMENT_DEADLINE_EXCEEDED');
      throw new EnvironmentPreparationError('ENVIRONMENT_EXECUTION_FAILED');
    }
  }
  private receipt(input: unknown, entry: EnvironmentDefinition['setup'], network: EnvironmentNetworkPolicy): void {
    const result = PreparationSchemas.parse(PreparationSchemas.execution, input, 'ENVIRONMENT_EXECUTION_FAILED');
    if (result.exitCode !== 0 || result.outputBytes > entry.outputLimitBytes
      || result.environmentRevision !== this.environment.revision || result.entryDigest !== entry.file.sha256
      || result.networkDigest !== CanonicalJson.digest(network)
      || CanonicalJson.stringify(result.target) !== CanonicalJson.stringify(this.target))
      throw new EnvironmentPreparationError('ENVIRONMENT_EXECUTION_FAILED');
  }
}

/** No process spawning here. The selected executor owns qualified guest-only execution. */
export class EnvironmentPreparationPlugin implements EnvironmentPreparer {
  static readonly provide = ['agent.environment'];
  static readonly inject = ['cordis.composition', 'agent.environment.authority', 'agent.environment.execution'];
  static readonly Config = z.strictObject({});
  static readonly declaration = AgentDeclaration.create('agent.environment.preparation', this.provide, this.inject);
  static readonly replacement = AgentDeclaration.replacement;
  private readonly locator: CordisServiceLocator;
  private failed = false;
  constructor(context: Context) {
    this.locator = CordisServiceLocator.from(context);
    context.provide('agent.environment', this);
  }
  async prepare(input: unknown, target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentPreparationReceipt> {
    if (this.failed) throw new EnvironmentPreparationError('ENVIRONMENT_DISPOSAL_FAILED');
    if (signal.aborted) throw new EnvironmentPreparationError('ENVIRONMENT_CANCELLED');
    const environment = PreparationSchemas.parse(EnvironmentSchemas.definition, input, 'ENVIRONMENT_CONTRACT_INVALID');
    const admitted = PreparationSchemas.parse(PreparationSchemas.target, target, 'ENVIRONMENT_CONTRACT_INVALID');
    return this.prepared(environment, admitted, signal);
  }
  private async prepared(environment: EnvironmentDefinition, target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentPreparationReceipt> {
    const leases: ProviderLease<object>[] = [];
    try {
      const authority = await this.acquire(EnvironmentTokens.authority, leases);
      const executor = await this.acquire(EnvironmentTokens.execution, leases);
      return await new EnvironmentPreparationRun(environment, target, authority, executor, signal).run();
    } finally {
      await this.release(leases);
    }
  }
  private async acquire<T extends object>(token: CapabilityToken<T>, leases: ProviderLease<object>[]): Promise<T> {
    try {
      const lease = await this.locator.acquire(token);
      leases.push(lease);
      return lease.value;
    } catch {
      throw new EnvironmentPreparationError('ENVIRONMENT_PROVIDER_UNAVAILABLE');
    }
  }
  private async release(leases: ProviderLease<object>[]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const lease of leases.reverse()) pending.push(lease.release());
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      this.failed = true;
      throw new EnvironmentPreparationError('ENVIRONMENT_DISPOSAL_FAILED');
    }
  }
}
