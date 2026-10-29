import { z } from 'zod';
import { resolve } from 'node:path';
import {
  CanonicalJson,
  CapabilityToken,
  CapacitySchemas,
  CapacityChannelSchemas,
  PlatformSchemas,
  ProviderV4Schemas,
  SandboxControlSchemas,
  SandboxRunnerSchemas,
  SandboxRunnerBinding,
  SandboxControlError,
  type SandboxControlCode,
  type SandboxAvailability,
  type SandboxEvidence,
  type SandboxDestructionReceipt,
  type CapacityReadiness,
  type CapacityProcessGeneration,
} from '@treeseed-cordis/sdk';
import {
  Context,
  CordisScope,
  type ProviderRegistration,
  type ProviderLease,
} from '@treeseed-cordis/sdk/runtime';
import {
  SandboxSocketClient,
  SandboxRunnerSocketClient,
} from '@treeseed-cordis/deployment/sandbox-control';
import { randomUUID } from 'node:crypto';
import { AgentPackageIdentity } from './package-identity.js';
export interface WorkerSandboxEvidence {
  sandbox: SandboxEvidence;
  runner: CapacityReadiness;
  hostConfigurationDigest: string;
}
export interface WorkerSandboxHost {
  ready(signal: AbortSignal): Promise<SandboxAvailability>;
  create(id: string, signal: AbortSignal): Promise<WorkerSandboxEvidence>;
  inspect(
    id: string,
    expectedGeneration: CapacityProcessGeneration | null,
    signal: AbortSignal,
  ): Promise<WorkerSandboxEvidence>;
  destroy(id: string, signal: AbortSignal): Promise<SandboxDestructionReceipt>;
}
class WorkerConfiguration {
  static readonly schema = z.strictObject({
    scope: CapacitySchemas.scope,
    hostScope: SandboxControlSchemas.scope,
    hostConfigurationDigest: PlatformSchemas.digest,
    endpointDirectory: PlatformSchemas.absolute,
    authorityFile: PlatformSchemas.absolute,
    timeoutMs: z.number().int().min(50).max(120000).default(120000),
  });
  static binding(input: z.infer<typeof WorkerConfiguration.schema>): boolean {
    return (
      input.scope.installationId === input.hostScope.installationId &&
      resolve(input.scope.installationDirectory) === input.scope.installationDirectory
    );
  }
}
class WorkerFailure {
  static require(value: unknown, code: SandboxControlCode): asserts value {
    if (!value) throw new SandboxControlError(code);
  }
  static safe(error: unknown): SandboxControlError {
    try {
      if (error instanceof SandboxControlError) {
        const parsed = SandboxControlSchemas.code.safeParse(
          Object.getOwnPropertyDescriptor(error, 'code')?.value,
        );
        if (parsed.success) return new SandboxControlError(parsed.data);
      }
    } catch {
      /* Provider inspection cannot expose private details. */
    }
    return new SandboxControlError('SANDBOX_OPERATION_FAILED');
  }
  static same(actual: unknown, expected: unknown, code: SandboxControlCode): void {
    this.require(CanonicalJson.stringify(actual) === CanonicalJson.stringify(expected), code);
  }
}
class WorkerSandboxMethods {
  parse(input: unknown): WorkerSandboxHost {
    WorkerFailure.require(input && typeof input === 'object', 'SANDBOX_PROVIDER_UNAVAILABLE');
    for (const name of ['ready', 'create', 'inspect', 'destroy'])
      WorkerFailure.require(
        typeof Reflect.get(input, name) === 'function',
        'SANDBOX_PROVIDER_UNAVAILABLE',
      );
    return input as WorkerSandboxHost;
  }
}
export const WorkerSandboxToken = new CapabilityToken<WorkerSandboxHost>(
  'agent.worker.sandbox',
  ProviderV4Schemas.version,
  new WorkerSandboxMethods(),
);
export class WorkerSandboxPlugin implements WorkerSandboxHost {
  static readonly provide = ['agent.worker.sandbox'];
  static readonly inject = ['cordis.composition'];
  static readonly Config = WorkerConfiguration.schema;
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.worker.sandbox.private',
    pluginId: 'agent',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  private readonly control: SandboxSocketClient;
  private readonly runner: SandboxRunnerSocketClient;
  private closed = false;
  constructor(
    context: Context,
    private readonly configuration: z.infer<typeof WorkerSandboxPlugin.Config>,
  ) {
    WorkerFailure.require(
      WorkerConfiguration.binding(configuration),
      'INVALID_SANDBOX_CONTROL_CONTRACT',
    );
    const connection = {
      scope: configuration.hostScope,
      endpointDirectory: configuration.endpointDirectory,
      authorityFile: configuration.authorityFile,
      timeoutMs: configuration.timeoutMs,
    };
    this.control = new SandboxSocketClient(connection);
    this.runner = new SandboxRunnerSocketClient(connection);
    context.provide(WorkerSandboxToken.id, this);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => void {
    return this.dispose.bind(this);
  }
  private dispose(): void {
    this.closed = true;
  }
  private admission(signal: AbortSignal): void {
    WorkerFailure.require(!this.closed, 'SANDBOX_PROVIDER_UNAVAILABLE');
    WorkerFailure.require(!signal.aborted, 'SANDBOX_CANCELLED');
  }
  async ready(signal: AbortSignal): Promise<SandboxAvailability> {
    try {
      return await this.available(signal);
    } catch (error) {
      throw WorkerFailure.safe(error);
    }
  }
  private async available(signal: AbortSignal): Promise<SandboxAvailability> {
    this.admission(signal);
    const response = SandboxControlSchemas.availability.parse(await this.control.ready(signal));
    WorkerFailure.same(
      response.configurationDigest,
      this.configuration.hostConfigurationDigest,
      'SANDBOX_RESOURCE_CHANGED',
    );
    this.admission(signal);
    return response;
  }
  async create(id: string, signal: AbortSignal): Promise<WorkerSandboxEvidence> {
    try {
      await this.available(signal);
      const physical = SandboxControlSchemas.evidence.parse(await this.control.create(id, signal));
      WorkerFailure.require(physical.assignment === null, 'SANDBOX_RESOURCE_CHANGED');
      return await this.collect(id, physical, null, signal);
    } catch (error) {
      throw WorkerFailure.safe(error);
    }
  }
  async inspect(
    id: string,
    expectedGeneration: CapacityProcessGeneration | null,
    signal: AbortSignal,
  ): Promise<WorkerSandboxEvidence> {
    try {
      await this.available(signal);
      const physical = SandboxControlSchemas.evidence.parse(await this.control.inspect(id, signal));
      return await this.collect(id, physical, expectedGeneration, signal);
    } catch (error) {
      throw WorkerFailure.safe(error);
    }
  }
  private async collect(
    id: string,
    sandbox: SandboxEvidence,
    expected: CapacityProcessGeneration | null,
    signal: AbortSignal,
  ): Promise<WorkerSandboxEvidence> {
    WorkerFailure.same(sandbox.sandboxId, id, 'SANDBOX_RESPONSE_MISMATCH');
    const request = this.frame(id, expected);
    const response = SandboxRunnerBinding.assertResponse(
      await this.runner.exchange(request, signal),
      request,
    );
    if (!response.success) throw new SandboxControlError(response.problem.code);
    WorkerFailure.require(
      response.result.success && response.result.operation === 'ready',
      'SANDBOX_RESPONSE_MISMATCH',
    );
    const ready = this.readiness(response.result.result);
    await this.available(signal);
    this.admission(signal);
    return {
      sandbox,
      runner: ready,
      hostConfigurationDigest: this.configuration.hostConfigurationDigest,
    };
  }
  private readiness(input: unknown): CapacityReadiness {
    const ready = CapacitySchemas.readiness.parse(input);
    WorkerFailure.same(ready.scope, this.configuration.scope, 'SANDBOX_SCOPE_MISMATCH');
    WorkerFailure.require(
      ready.role === 'runner' && ready.ready && ready.blockers.length === 0,
      'SANDBOX_PROVIDER_UNAVAILABLE',
    );
    return ready;
  }
  private frame(id: string, expectedGeneration: CapacityProcessGeneration | null) {
    const requestId = 'ready.' + randomUUID();
    const frame = CapacityChannelSchemas.request.parse({
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId,
      scope: this.configuration.scope,
      role: 'runner',
      operation: 'ready',
      expectedGeneration,
      parameters: {},
    });
    return SandboxRunnerSchemas.request.parse({
      schemaVersion: 'treeseed.sandbox-runner/v1',
      requestId,
      scope: this.configuration.hostScope,
      sandboxId: id,
      frame,
    });
  }
  async destroy(id: string, signal: AbortSignal): Promise<SandboxDestructionReceipt> {
    try {
      await this.available(signal);
      const receipt = SandboxControlSchemas.destruction.parse(
        await this.control.destroy(id, signal),
      );
      WorkerFailure.same(receipt.sandboxId, id, 'SANDBOX_RESPONSE_MISMATCH');
      await this.available(signal);
      this.admission(signal);
      return receipt;
    } catch (error) {
      throw WorkerFailure.safe(error);
    }
  }
}
/** One worker native root; acquisition exposes native leases rather than cached service instances. */
export class WorkerApplication {
  static readonly Config = WorkerSandboxPlugin.Config;
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(private readonly scope: CordisScope) {}
  get generation(): string {
    return this.scope.generation;
  }
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<WorkerApplication> {
    try {
      const configuration = this.Config.parse(input);
      WorkerFailure.require(
        WorkerConfiguration.binding(configuration),
        'INVALID_SANDBOX_CONTROL_CONTRACT',
      );
      const registration = this.registration(configuration, overrides);
      const scope = await this.mount(configuration, registration);
      return new WorkerApplication(scope);
    } catch {
      throw new SandboxControlError('INVALID_SANDBOX_CONTROL_CONTRACT');
    }
  }
  private static descriptor(scopeId: string, registration: ProviderRegistration) {
    return {
      registrations: [registration],
      selections: [
        {
          scopeId,
          capability: WorkerSandboxToken.id,
          providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id,
        },
      ],
    };
  }
  private static mount(
    configuration: z.infer<typeof this.Config>,
    registration: ProviderRegistration,
  ): Promise<CordisScope> {
    const scopeId = 'capacity-worker:' + CanonicalJson.digest(configuration.scope);
    return CordisScope.start(this.descriptor(scopeId, registration), {
      scopeId,
      target: 'agent',
      principalId: configuration.scope.capacityProviderId,
      resourceScope: configuration.scope.installationDirectory,
    });
  }
  private static registration(
    configuration: z.infer<typeof this.Config>,
    overrides: readonly ProviderRegistration[],
  ): ProviderRegistration {
    WorkerFailure.require(overrides.length <= 1, 'INVALID_SANDBOX_CONTROL_CONTRACT');
    if (overrides[0]) {
      WorkerFailure.require(
        overrides[0].token.id === WorkerSandboxToken.id,
        'INVALID_SANDBOX_CONTROL_CONTRACT',
      );
      return overrides[0];
    }
    return {
      token: WorkerSandboxToken,
      plugin: WorkerSandboxPlugin,
      declaration: WorkerSandboxPlugin.declaration,
      configuration,
      artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
    };
  }
  async acquireSandbox(): Promise<ProviderLease<WorkerSandboxHost>> {
    try {
      WorkerFailure.require(!this.closed, 'SANDBOX_PROVIDER_UNAVAILABLE');
      const lease = await this.scope.acquire(WorkerSandboxToken);
      if (this.closed) {
        await lease.release();
        throw new SandboxControlError('SANDBOX_PROVIDER_UNAVAILABLE');
      }
      return lease;
    } catch (error) {
      throw WorkerFailure.safe(error);
    }
  }
  close(): Promise<void> {
    this.closed = true;
    if (!this.disposal) this.disposal = this.dispose();
    return this.disposal;
  }
  private async dispose(): Promise<void> {
    try {
      await this.scope.dispose();
    } catch {
      throw new SandboxControlError('SANDBOX_REPAIR_REQUIRED');
    }
  }
}
