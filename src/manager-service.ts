import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CapacityChannelBinding,
  CapacityContractError,
  CanonicalJson,
  ProviderV4Schemas,
  type CapacityScope,
  type CapacityProcessGeneration,
  type CapacityChannelRequest,
  type CapacityChannelResponse,
} from '@treeseed-cordis/sdk';
import {
  ProviderControlSchemas,
  ProviderControlError,
} from '@treeseed-cordis/sdk/provider-control';
import {
  CordisScope,
  type ProviderRegistration,
  type CompositionDescriptor,
} from '@treeseed-cordis/sdk/runtime';
import {
  ProviderConnectionApplication,
  ProviderConnectionToken,
  ProviderRegistrationPlugin,
} from './provider-connection.js';
import { ProviderProofToken, ProviderFileProofPlugin } from './provider-proof.js';
import { AgentPackageIdentity } from './package-identity.js';

class ManagerConfiguration {
  static version(value: string): boolean {
    return value === 'treeseed.manager-configuration/v1';
  }
  static binding(value: {
    controlPlaneUrl: string;
    providerId: string;
    proof: { audience: string };
    scope: CapacityScope;
  }): boolean {
    try {
      const origin = new URL(value.controlPlaneUrl);
      return (
        origin.protocol === 'https:' &&
        origin.origin === value.controlPlaneUrl &&
        value.proof.audience === value.controlPlaneUrl &&
        value.scope.capacityProviderId === value.providerId &&
        resolve(value.scope.installationDirectory) === value.scope.installationDirectory
      );
    } catch {
      return false;
    }
  }
}
/** Coherent manager admission; registration observation alone cannot enable execution. */
export class CapacityManagerService {
  static readonly Config = ProviderConnectionApplication.Config.extend({
    schemaVersion: ProviderControlSchemas.text.refine(
      ManagerConfiguration.version.bind(ManagerConfiguration),
    ),
    scope: CapacitySchemas.scope,
    registrationId: ProviderControlSchemas.key,
  }).refine(ManagerConfiguration.binding.bind(ManagerConfiguration));
  private readonly nonce = randomBytes(32).toString('hex');
  private readonly controller = new AbortController();
  private closing: Promise<void> | null = null;
  private constructor(
    private readonly configuration: ReturnType<typeof CapacityManagerService.Config.parse>,
    private readonly root: CordisScope,
  ) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<CapacityManagerService> {
    try {
      const configuration = this.Config.parse(input);
      const registrations = this.select(this.defaults(configuration), overrides);
      const root = await this.mount(configuration, registrations);
      return new CapacityManagerService(configuration, root);
    } catch {
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    }
  }
  private static readonly providers = [
    { token: ProviderProofToken, plugin: ProviderFileProofPlugin },
    { token: ProviderConnectionToken, plugin: ProviderRegistrationPlugin },
  ];
  private static connection(
    configuration: ReturnType<typeof this.Config.parse>,
  ): ReturnType<typeof ProviderRegistrationPlugin.Config.parse> {
    const { scope, schemaVersion, registrationId, proof, ...binding } = configuration;
    return { ...binding, fingerprint: proof.fingerprint };
  }
  private static defaults(
    configuration: ReturnType<typeof this.Config.parse>,
  ): ProviderRegistration[] {
    const artifact = { kind: 'bundled' as const, identity: AgentPackageIdentity.artifact };
    const registrations: ProviderRegistration[] = [];
    for (const { token, plugin } of this.providers)
      registrations.push({
        token,
        plugin,
        declaration: plugin.declaration,
        artifact,
        configuration:
          token.id === ProviderProofToken.id ? configuration.proof : this.connection(configuration),
      });
    return registrations;
  }
  private static select(
    defaults: ProviderRegistration[],
    overrides: readonly ProviderRegistration[],
  ): ProviderRegistration[] {
    const selected = new Map<string, ProviderRegistration>();
    const replaced = new Set<string>();
    for (const registration of defaults) selected.set(registration.token.id, registration);
    for (const registration of overrides) {
      const id = registration.token.id;
      if (!selected.has(id) || replaced.has(id))
        throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
      replaced.add(id);
      selected.set(id, registration);
    }
    return [...selected.values()];
  }
  private static descriptor(
    scopeId: string,
    registrations: ProviderRegistration[],
  ): CompositionDescriptor {
    const selections = [];
    for (const registration of registrations)
      selections.push({
        scopeId,
        capability: registration.token.id,
        providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id,
      });
    return { registrations, selections };
  }
  private static mount(
    configuration: ReturnType<typeof this.Config.parse>,
    registrations: ProviderRegistration[],
  ): Promise<CordisScope> {
    const scopeId = 'capacity-manager:' + CanonicalJson.digest(configuration);
    return CordisScope.start(this.descriptor(scopeId, registrations), {
      scopeId,
      target: 'agent',
      principalId: configuration.proof.fingerprint,
      resourceScope: configuration.teamId,
    });
  }
  get generation(): CapacityProcessGeneration {
    return { compositionGeneration: this.root.generation, processGeneration: this.nonce };
  }
  private get context() {
    return {
      role: 'manager' as const,
      scope: this.configuration.scope,
      generation: this.generation,
    };
  }
  async handle(input: unknown): Promise<CapacityChannelResponse> {
    const parsed = CapacityChannelSchemas.request.safeParse(input);
    if (!parsed.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    try {
      const request = CapacityChannelBinding.assertRequest(parsed.data, this.context);
      this.admission();
      if (request.operation !== 'ready')
        throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
      const readiness = await this.readiness();
      this.admission();
      return this.response(request, true, readiness, null);
    } catch (error) {
      return this.response(parsed.data, false, null, this.failure(error).blocker());
    }
  }
  private admission(): void {
    if (this.controller.signal.aborted) throw new CapacityContractError('CAPACITY_CANCELLED');
  }
  private async readiness(): Promise<unknown> {
    await this.observeRegistration();
    this.admission();
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      ...this.context,
      ready: false,
      blockers: [new CapacityContractError('CAPACITY_TARGET_UNREADY').blocker()],
    });
  }
  private async observeRegistration(): Promise<void> {
    const lease = await this.root.acquire(ProviderConnectionToken);
    try {
      const observed = await lease.value.status(
        this.configuration.registrationId,
        this.controller.signal,
      );
      this.admission();
      this.registration(observed);
      lease.assertOpen();
    } finally {
      try {
        await lease.release();
      } catch {
        throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
      }
    }
  }
  private registration(input: unknown): void {
    const record = ProviderControlSchemas.registration.safeParse(input);
    if (!record.success) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    if (record.data.id !== this.configuration.registrationId)
      throw new CapacityContractError('CAPACITY_SCOPE_MISMATCH');
    ProviderRegistrationPlugin.assertBinding(
      record.data,
      CapacityManagerService.connection(this.configuration),
    );
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
      scope: this.configuration.scope,
      role: request.role,
      operation: request.operation,
      generation: this.generation,
      success,
      result,
      problem,
    });
  }
  private failure(error: unknown): CapacityContractError {
    try {
      const code =
        error && typeof error === 'object'
          ? Object.getOwnPropertyDescriptor(error, 'code')?.value
          : null;
      if (error instanceof CapacityContractError && code === 'CAPACITY_CLEANUP_FAILED')
        return new CapacityContractError(code);
      if (this.controller.signal.aborted) return new CapacityContractError('CAPACITY_CANCELLED');
      if (error instanceof ProviderControlError && code === 'PROVIDER_IDENTITY_MISMATCH')
        return new CapacityContractError('CAPACITY_SCOPE_MISMATCH');
      const parsed = CapacitySchemas.code.safeParse(code);
      if (error instanceof CapacityContractError && parsed.success)
        return new CapacityContractError(parsed.data);
    } catch {
      /* Private provider error objects cannot expose their own text or getters. */
    }
    return new CapacityContractError('CAPACITY_TARGET_UNREADY');
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort();
      this.closing = this.root.dispose();
    }
    return this.closing;
  }
}
