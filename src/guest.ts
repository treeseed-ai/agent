import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  CanonicalJson,
  CapacityChannelBinding,
  CapacityChannelSchemas,
  CapacitySchemas,
  CapacityProtocolSchemas,
  CapacityContractError,
  type CapacityDispatch,
  type CapacityLease,
  type CapacityProcessGeneration,
  type CapacityRunnerOutcome,
  type CapacityChannelResponse,
  type CapacityChannelRequest,
  type CapabilityToken,
} from '@treeseed-cordis/sdk';
import {
  CordisScope,
  type ProviderLease,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import {
  AgentCapacityAssignmentFilePlugin,
  CapacityAssignmentToken,
  type CapacityAssignmentSource,
} from './authority.js';
import { AgentPackageIdentity } from './package-identity.js';
import { GuestPackages } from './guest-packages.js';
import {
  GuestTokens,
  GuestProfilePlugin,
  GuestContextPlugin,
  GuestHandlerPlugin,
  GuestToolPlugin,
  GuestReportingPlugin,
  GuestExecutionPlugin,
  type GuestExecutionSession,
  type GuestProfile,
  type GuestContext,
  type GuestHandler,
  type GuestTool,
  type GuestReporting,
} from './guest-providers.js';
export * from './guest-providers.js';
export class GuestConfiguration {
  static readonly schema = AgentCapacityAssignmentFilePlugin.Config.omit({ file: true }).extend({
    schemaVersion: z.literal('treeseed.guest-configuration/v1'),
    assignmentFile: AgentCapacityAssignmentFilePlugin.Config.shape.file,
    providers: GuestPackages.references.default([]),
  });
  static parse(input: unknown): z.infer<typeof this.schema> {
    const parsed = this.schema.safeParse(input);
    if (!parsed.success || resolve(parsed.data.assignmentFile) !== parsed.data.assignmentFile)
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    return parsed.data;
  }
}
class GuestRun implements GuestExecutionSession {
  private readonly leases: ProviderLease<object>[] = [];
  private source!: CapacityAssignmentSource;
  profile!: GuestProfile;
  context!: GuestContext;
  handler!: GuestHandler;
  tool!: GuestTool;
  reporting!: GuestReporting;
  constructor(
    readonly request: CapacityDispatch,
    readonly signal: AbortSignal,
    private readonly scope: CordisScope,
    private readonly generation: CapacityProcessGeneration,
    private readonly selectedHandler: object,
  ) {}
  private async acquire<T extends object>(token: CapabilityToken<T>): Promise<T> {
    const lease = await this.scope.acquire(token);
    this.leases.push(lease);
    return lease.value;
  }
  private async acquireProviders(): Promise<void> {
    this.source = await this.acquire(CapacityAssignmentToken);
    this.profile = await this.acquire(GuestTokens.profile);
    this.context = await this.acquire(GuestTokens.context);
    this.handler = await this.acquire(GuestTokens.handler);
    this.tool = await this.acquire(GuestTokens.tool);
    this.reporting = await this.acquire(GuestTokens.reporting);
  }
  async checkpoint(): Promise<void> {
    if (this.signal.aborted) throw new CapacityContractError('CAPACITY_CANCELLED');
    const record = await this.source.observe(this.signal);
    if (CanonicalJson.stringify(record) !== CanonicalJson.stringify(this.request))
      throw new CapacityContractError('STALE_CAPACITY_LEASE');
    if (
      CanonicalJson.stringify(record.lease.generations.runner) !==
      CanonicalJson.stringify(this.generation)
    )
      throw new CapacityContractError('STALE_CAPACITY_GENERATION');
  }
  private async admit(): Promise<void> {
    await this.checkpoint();
    const profile = await this.profile.resolve(structuredClone(this.request));
    const original = this.request.definition.profiles.find(this.matches.bind(this));
    if (
      CanonicalJson.stringify(profile) !== CanonicalJson.stringify(original) ||
      CanonicalJson.stringify(profile.handler) !== CanonicalJson.stringify(this.selectedHandler)
    )
      throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
    await this.checkpoint();
  }
  private matches(profile: { id: string }): boolean {
    return profile.id === this.request.profileId;
  }
  async execute(): Promise<CapacityRunnerOutcome> {
    let outcome: CapacityRunnerOutcome;
    try {
      await this.acquireProviders();
      await this.admit();
      const engine = await this.acquire(GuestTokens.execution);
      const output = await engine.execute(this);
      await this.checkpoint();
      outcome = this.outcome('completed', z.string().max(1024).parse(output), []);
    } catch (error) {
      outcome = this.failure(error);
    }
    try {
      await this.release();
    } catch {
      outcome = this.failure(new CapacityContractError('CAPACITY_CLEANUP_FAILED'));
    }
    return outcome;
  }
  private outcome(
    state: CapacityRunnerOutcome['state'],
    output: string | null,
    blockers: CapacityRunnerOutcome['blockers'],
  ): CapacityRunnerOutcome {
    return CapacityProtocolSchemas.runnerOutcome.parse({
      schemaVersion: 'treeseed.capacity-runner-outcome/v1',
      lease: this.request.lease,
      state,
      output,
      blockers,
    });
  }
  private failure(error: unknown): CapacityRunnerOutcome {
    const code = error instanceof CapacityContractError ? error.code : 'CAPACITY_HANDLER_FAILED';
    return this.outcome(code === 'CAPACITY_CANCELLED' ? 'cancelled' : 'blocked', null, [
      new CapacityContractError(code).blocker(),
    ]);
  }
  private async release(): Promise<void> {
    const results = [];
    for (const lease of this.leases.reverse())
      results.push(await Promise.allSettled([lease.release()]));
    for (const [result] of results)
      if (result?.status === 'rejected') throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
  }
}
export class CapacityGuest {
  private static readonly defaults = [
    { token: GuestTokens.profile, plugin: GuestProfilePlugin },
    { token: GuestTokens.context, plugin: GuestContextPlugin },
    { token: GuestTokens.handler, plugin: GuestHandlerPlugin },
    { token: GuestTokens.tool, plugin: GuestToolPlugin },
    { token: GuestTokens.reporting, plugin: GuestReportingPlugin },
    { token: GuestTokens.execution, plugin: GuestExecutionPlugin },
  ];
  private readonly nonce = randomBytes(32).toString('hex');
  private used = false;
  private closing: Promise<void> | null = null;
  private active: {
    request: CapacityDispatch;
    controller: AbortController;
    result: Promise<CapacityRunnerOutcome>;
  } | null = null;
  private constructor(
    private readonly configuration: z.infer<typeof GuestConfiguration.schema>,
    private readonly scope: CordisScope,
    private readonly selectedHandler: object,
  ) {}
  get generation(): CapacityProcessGeneration {
    return { compositionGeneration: this.scope.generation, processGeneration: this.nonce };
  }
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<CapacityGuest> {
    const configuration = GuestConfiguration.parse(input);
    const prepared = await GuestPackages.load(configuration.scope, configuration.providers);
    const registrations = this.registrations(configuration, [...prepared, ...overrides]);
    const scope = await this.compose(configuration, registrations);
    return new CapacityGuest(configuration, scope, this.handler(registrations));
  }
  private static async compose(
    configuration: z.infer<typeof GuestConfiguration.schema>,
    registrations: ProviderRegistration[],
  ): Promise<CordisScope> {
    const scopeId = GuestPackages.scopeId(configuration.scope);
    const selections = [];
    for (const registration of registrations)
      selections.push({
        scopeId,
        capability: registration.token.id,
        providerId: (registration.declaration as { id: string }).id,
      });
    return CordisScope.start(
      { registrations, selections },
      {
        scopeId,
        target: 'agent',
        principalId: configuration.scope.capacityProviderId,
        resourceScope: configuration.scope.installationId,
      },
    );
  }
  private static registrations(
    configuration: z.infer<typeof GuestConfiguration.schema>,
    overrides: readonly ProviderRegistration[],
  ): ProviderRegistration[] {
    const registrations: ProviderRegistration[] = [];
    for (const { token, plugin } of this.defaults)
      registrations.push({
        token,
        plugin,
        declaration: plugin.declaration,
        configuration: {},
        artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
      });
    this.override(registrations, overrides);
    registrations.push({
      token: CapacityAssignmentToken,
      plugin: AgentCapacityAssignmentFilePlugin,
      declaration: AgentCapacityAssignmentFilePlugin.declaration,
      configuration: { file: configuration.assignmentFile, scope: configuration.scope },
      artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
    });
    return registrations;
  }
  private static override(
    registrations: ProviderRegistration[],
    overrides: readonly ProviderRegistration[],
  ): void {
    const selected = new Set<string>();
    for (const override of overrides) {
      if (selected.has(override.token.id))
        throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
      selected.add(override.token.id);
      const index = registrations.findIndex(this.capability.bind(this, override.token.id));
      if (index < 0) throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
      registrations[index] = override;
    }
  }
  private static capability(id: string, registration: ProviderRegistration): boolean {
    return id === registration.token.id;
  }
  private static handler(registrations: ProviderRegistration[]): object {
    for (const registration of registrations)
      if (registration.token.id === GuestTokens.handler.id) {
        const declaration = registration.declaration as { id: string; contractVersion: string };
        return {
          providerId: declaration.id,
          capability: registration.token.id,
          contractVersion: declaration.contractVersion,
        };
      }
    throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
  }
  async handle(input: unknown): Promise<CapacityChannelResponse> {
    const request = CapacityChannelSchemas.request.safeParse(input);
    if (!request.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    try {
      const accepted = CapacityChannelBinding.assertRequest(request.data, {
        role: 'runner',
        scope: this.configuration.scope,
        generation: this.generation,
      });
      if (this.closing) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
      return this.response(accepted, true, await this.perform(accepted), null);
    } catch (error) {
      const safe =
        error instanceof CapacityContractError
          ? error
          : new CapacityContractError('CAPACITY_HANDLER_FAILED');
      return this.response(request.data, false, null, safe.blocker());
    }
  }
  private response(
    request: CapacityChannelRequest,
    success: boolean,
    result: unknown,
    problem: unknown,
  ): CapacityChannelResponse {
    return CapacityChannelSchemas.response.parse({
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope: request.scope,
      role: request.role,
      operation: request.operation,
      generation: this.generation,
      success,
      result,
      problem,
    });
  }
  private async perform(request: CapacityChannelRequest): Promise<unknown> {
    if (request.operation === 'ready') return this.readiness();
    if (request.operation === 'run') return this.run(request.parameters.request);
    if (request.operation === 'cancel') return this.cancel(request.parameters.lease);
    throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
  }
  private readiness(): unknown {
    const blockers = this.used
      ? [new CapacityContractError('CAPACITY_TARGET_UNREADY').blocker()]
      : [];
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      role: 'runner',
      scope: this.configuration.scope,
      generation: this.generation,
      ready: !this.used,
      blockers,
    });
  }
  private async run(request: CapacityDispatch): Promise<CapacityRunnerOutcome> {
    if (this.used || this.active) throw new CapacityContractError('STALE_CAPACITY_LEASE');
    this.used = true;
    const controller = new AbortController();
    const result = this.execute(request, controller.signal);
    this.active = { request, controller, result };
    try {
      return await result;
    } finally {
      this.active = null;
    }
  }
  private async execute(
    request: CapacityDispatch,
    signal: AbortSignal,
  ): Promise<CapacityRunnerOutcome> {
    await this.trusted(request, signal);
    if (signal.aborted || this.closing) throw new CapacityContractError('CAPACITY_CANCELLED');
    return new GuestRun(
      request,
      signal,
      this.scope,
      this.generation,
      this.selectedHandler,
    ).execute();
  }
  private async trusted(request: CapacityDispatch, signal: AbortSignal): Promise<void> {
    const lease = await this.scope.acquire(CapacityAssignmentToken);
    try {
      const record = await lease.value.observe(signal);
      if (CanonicalJson.stringify(record) !== CanonicalJson.stringify(request))
        throw new CapacityContractError('STALE_CAPACITY_LEASE');
    } finally {
      await lease.release();
    }
  }
  private async cancel(lease: CapacityLease): Promise<CapacityRunnerOutcome> {
    if (
      !this.active ||
      CanonicalJson.stringify(lease) !== CanonicalJson.stringify(this.active.request.lease)
    )
      throw new CapacityContractError('STALE_CAPACITY_LEASE');
    this.active.controller.abort();
    return this.active.result;
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    this.active?.controller.abort();
    if (this.active) await Promise.allSettled([this.active.result]);
    try {
      await this.scope.dispose();
    } catch {
      throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
    }
  }
}
