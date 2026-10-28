import {
  ActivityContractBinding,
  ActivitySchemas,
  CanonicalJson,
  CapabilityToken,
  ProviderV4Schemas,
  type ActivityCapability,
  type ActivityProfile,
  type ResolvedActivityDefinition,
} from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type CompositionDescriptor,
  type TrustedCompositionContext,
  type ProviderLease,
} from '@treeseed-cordis/sdk/runtime';

export interface ActivityParameterProvider {
  validate(profile: ActivityProfile, signal: AbortSignal): Promise<void>;
}
export interface ActivityHandlerProvider {
  execute(profile: ActivityProfile, signal: AbortSignal): Promise<string>;
}
export interface PreparedActivityDefinition extends ResolvedActivityDefinition {
  readonly generation: string;
}
export interface ActivityResolverConfiguration {
  capabilities: unknown;
  descriptor: CompositionDescriptor;
  scope: TrustedCompositionContext;
}
type PreparationCode =
  | 'ACTIVITY_CONTRACT_INVALID'
  | 'ACTIVITY_PROVIDER_MISMATCH'
  | 'ACTIVITY_PROVIDER_UNAVAILABLE'
  | 'ACTIVITY_PARAMETERS_INVALID'
  | 'ACTIVITY_PARAMETERS_CHANGED'
  | 'ACTIVITY_CANCELLED'
  | 'ACTIVITY_CLOSED'
  | 'ACTIVITY_RELEASE_FAILED'
  | 'ACTIVITY_DISPOSAL_FAILED';

export class ActivityPreparationError extends Error {
  constructor(readonly code: PreparationCode) {
    super(code);
    this.name = 'ActivityPreparationError';
  }
}

class ActivityAdapter<T extends object> {
  constructor(private readonly method: string) {}
  parse(value: unknown): T {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof Reflect.get(value, this.method) !== 'function'
    )
      throw new ActivityPreparationError('ACTIVITY_PROVIDER_UNAVAILABLE');
    return value as T;
  }
}

interface ActivitySelection {
  capability: string;
  providerId: string;
  contractVersion: string;
  scopeId: string;
}
/** Immutable declaration metadata only. Native Cordis retains every service instance. */
class ActivitySelections {
  private readonly selected: ActivitySelection[] = [];
  constructor(
    descriptor: CompositionDescriptor,
    readonly scopeId: string,
  ) {
    for (const selection of descriptor.selections) {
      for (const registration of descriptor.registrations) {
        const declaration = ProviderV4Schemas.declaration.parse(registration.declaration);
        if (
          selection.capability !== declaration.capability ||
          selection.providerId !== declaration.id
        )
          continue;
        this.selected.push({ ...selection, contractVersion: declaration.contractVersion });
      }
    }
  }
  require(
    capability: string,
    providerId: string,
    contractVersion: string,
    scopeId = this.scopeId,
  ): void {
    if (scopeId !== this.scopeId) throw new ActivityPreparationError('ACTIVITY_PROVIDER_MISMATCH');
    for (const selection of this.selected) {
      if (
        selection.capability === capability &&
        selection.providerId === providerId &&
        selection.contractVersion === contractVersion &&
        selection.scopeId === scopeId
      )
        return;
    }
    throw new ActivityPreparationError('ACTIVITY_PROVIDER_MISMATCH');
  }
  validate(resolved: ResolvedActivityDefinition[]): void {
    for (const value of resolved) {
      const profile = value.capability.provider;
      const handler = value.instance.handler;
      this.require(profile.capability, profile.id, profile.contractVersion, profile.scopeId);
      this.require(handler.capability, handler.providerId, handler.contractVersion);
    }
  }
}

class ActivityValidationRun {
  private readonly leases: ProviderLease<object>[] = [];
  result: Promise<PreparedActivityDefinition[]> | null = null;
  constructor(
    private readonly scope: CordisScope,
    private readonly profiles: ResolvedActivityDefinition[],
    private readonly signal: AbortSignal,
  ) {}
  run(): Promise<PreparedActivityDefinition[]> {
    if (!this.result) this.result = this.prepare();
    return this.result;
  }
  private checkpoint(): void {
    if (this.signal.aborted) throw new ActivityPreparationError('ACTIVITY_CANCELLED');
  }
  private async prepare(): Promise<PreparedActivityDefinition[]> {
    try {
      const result: PreparedActivityDefinition[] = [];
      for (const profile of this.profiles) {
        this.checkpoint();
        await this.validate(profile);
        this.checkpoint();
        result.push({ ...structuredClone(profile), generation: this.scope.generation });
      }
      return result;
    } finally {
      await this.release();
    }
  }
  private async acquire<T extends object>(
    capability: string,
    version: string,
    method: string,
  ): Promise<T> {
    try {
      const token = new CapabilityToken<T>(capability, version, new ActivityAdapter<T>(method));
      const lease = await this.scope.acquire(token);
      this.leases.push(lease);
      return lease.value;
    } catch {
      throw new ActivityPreparationError('ACTIVITY_PROVIDER_UNAVAILABLE');
    }
  }
  private async validate(value: ResolvedActivityDefinition): Promise<void> {
    const profile = value.capability.provider;
    const handler = value.instance.handler;
    const validator = await this.acquire<ActivityParameterProvider>(
      profile.capability,
      profile.contractVersion,
      'validate',
    );
    await this.acquire<ActivityHandlerProvider>(
      handler.capability,
      handler.contractVersion,
      'execute',
    );
    this.checkpoint();
    const copy = structuredClone(value.instance);
    await this.invoke(validator, copy);
    this.checkpoint();
    if (CanonicalJson.stringify(copy) !== CanonicalJson.stringify(value.instance))
      throw new ActivityPreparationError('ACTIVITY_PARAMETERS_CHANGED');
  }
  private async invoke(
    provider: ActivityParameterProvider,
    profile: ActivityProfile,
  ): Promise<void> {
    try {
      await provider.validate(profile, this.signal);
    } catch {
      this.checkpoint();
      throw new ActivityPreparationError('ACTIVITY_PARAMETERS_INVALID');
    }
  }
  private async release(): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const lease of this.leases.reverse()) releases.push(lease.release());
    const results = await Promise.allSettled(releases);
    for (const result of results)
      if (result.status === 'rejected')
        throw new ActivityPreparationError('ACTIVITY_RELEASE_FAILED');
  }
}

/** Preparation only. Admission, executable isolation and dispatch belong to the kernel/host. */
export class ActivityDefinitionResolver {
  private readonly controller = new AbortController();
  private readonly running = new Set<ActivityValidationRun>();
  private closing: Promise<void> | null = null;
  private constructor(
    private readonly scope: CordisScope,
    private readonly catalogue: ActivityCapability[],
    private readonly selections: ActivitySelections,
  ) {}
  static async start(
    configuration: ActivityResolverConfiguration,
  ): Promise<ActivityDefinitionResolver> {
    const catalogue = ActivitySchemas.catalogue.safeParse(configuration.capabilities);
    if (!catalogue.success) throw new ActivityPreparationError('ACTIVITY_CONTRACT_INVALID');
    const selections = new ActivitySelections(
      configuration.descriptor,
      configuration.scope.scopeId,
    );
    const scope = await CordisScope.start(configuration.descriptor, configuration.scope);
    return new ActivityDefinitionResolver(scope, catalogue.data, selections);
  }
  async resolve(input: unknown, signal: AbortSignal): Promise<PreparedActivityDefinition[]> {
    if (this.closing) throw new ActivityPreparationError('ACTIVITY_CLOSED');
    if (signal.aborted) throw new ActivityPreparationError('ACTIVITY_CANCELLED');
    const profiles = ActivityContractBinding.resolve(input, this.catalogue);
    this.selections.validate(profiles);
    const effective = AbortSignal.any([signal, this.controller.signal]);
    const job = new ActivityValidationRun(this.scope, profiles, effective);
    this.running.add(job);
    try {
      return await job.run();
    } finally {
      this.running.delete(job);
    }
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    this.controller.abort();
    const jobs: Promise<unknown>[] = [];
    for (const job of this.running) if (job.result) jobs.push(job.result);
    await Promise.allSettled(jobs);
    try {
      await this.scope.dispose();
    } catch {
      throw new ActivityPreparationError('ACTIVITY_DISPOSAL_FAILED');
    }
  }
}
