export * from './provider-proof.js';
import { z } from 'zod';
import {
  CapabilityToken,
  CanonicalJson,
  ProviderV4Schemas,
  type ProviderSelection,
} from '@treeseed-cordis/sdk';
import {
  ProviderControlSchemas,
  ProviderControlError,
  ProviderProtocolClient,
  type ProviderRegistration as ControlRegistration,
} from '@treeseed-cordis/sdk/provider-control';
import {
  Context,
  CordisScope,
  CordisServiceLocator,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import { ProviderFileProofPlugin, ProviderProofToken } from './provider-proof.js';
import { AgentPackageIdentity } from './package-identity.js';
export interface ProviderConnection {
  status(requestId: string, signal: AbortSignal): Promise<ControlRegistration>;
}
class ConnectionAdapter {
  parse(input: unknown): ProviderConnection {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'status') !== 'function')
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    return input as ProviderConnection;
  }
}
export const ProviderConnectionToken = new CapabilityToken<ProviderConnection>(
  'agent.provider.connection',
  ProviderV4Schemas.version,
  new ConnectionAdapter(),
);
export class ProviderRegistrationPlugin implements ProviderConnection {
  static readonly provide = ['agent.provider.connection'];
  static readonly inject = ['cordis.composition', 'agent.provider.proof'];
  static readonly Config = z.strictObject({
    controlPlaneUrl: z.url(),
    teamId: ProviderControlSchemas.key,
    providerId: ProviderControlSchemas.key,
    registrationKeyGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  });
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.provider.connection.registration',
    pluginId: 'agent',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  private readonly client: ProviderProtocolClient;
  constructor(
    private readonly context: Context,
    private readonly configuration: z.infer<typeof ProviderRegistrationPlugin.Config>,
  ) {
    this.client = new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
    context.provide(ProviderConnectionToken.id, this);
  }
  async status(input: string, signal: AbortSignal): Promise<ControlRegistration> {
    const request = ProviderControlSchemas.key.safeParse(input);
    if (!request.success) throw new ProviderControlError('INVALID_PROVIDER_REQUEST');
    try {
      return await this.lookup(request.data, signal);
    } catch (error) {
      throw ConnectionFailure.safe(error);
    }
  }
  private async lookup(requestId: string, signal: AbortSignal): Promise<ControlRegistration> {
    if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
    const lease = await CordisServiceLocator.from(this.context).acquire(ProviderProofToken);
    try {
      const proof = await lease.value.sign(
        {
          method: 'GET',
          path: '/v1/provider-registrations/' + requestId,
          body: { requestId },
        },
        signal,
      );
      const result = await this.client.registration(requestId, proof, signal);
      ProviderRegistrationPlugin.assertBinding(result, this.configuration);
      if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      lease.assertOpen();
      return result;
    } finally {
      await lease.release();
    }
  }
  static assertBinding(
    result: ControlRegistration,
    expected: z.infer<typeof ProviderRegistrationPlugin.Config>,
  ): void {
    if (
      result.teamId !== expected.teamId ||
      result.providerId !== expected.providerId ||
      result.providerFingerprint !== expected.fingerprint ||
      result.registrationKeyGeneration !== expected.registrationKeyGeneration
    )
      throw new ProviderControlError('PROVIDER_IDENTITY_MISMATCH');
  }
}
class ConnectionFailure {
  private static readonly codes = [
    'INVALID_PROVIDER_CONFIGURATION',
    'INVALID_PROVIDER_REQUEST',
    'INVALID_PROVIDER_RESPONSE',
    'PROVIDER_REQUEST_REJECTED',
    'PROVIDER_TRANSPORT_FAILED',
    'PROVIDER_RESPONSE_LIMIT',
    'PROVIDER_CANCELLED',
    'PROVIDER_IDENTITY_MISMATCH',
  ];
  static safe(error: unknown): ProviderControlError {
    if (!(error instanceof ProviderControlError) || !this.codes.includes(error.code))
      return new ProviderControlError('PROVIDER_TRANSPORT_FAILED');
    const status =
      Number.isInteger(error.status) && error.status >= 0 && error.status <= 599 ? error.status : 0;
    return new ProviderControlError(error.code, status);
  }
}
export class ProviderConnectionApplication implements ProviderConnection {
  static readonly Config = ProviderRegistrationPlugin.Config.omit({ fingerprint: true }).extend({
    proof: ProviderFileProofPlugin.Config,
  });
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(
    private readonly scope: CordisScope,
    private readonly configuration: z.infer<typeof ProviderConnectionApplication.Config>,
  ) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<ProviderConnectionApplication> {
    try {
      const configuration = this.Config.parse(input);
      new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
      new ProviderProtocolClient({ baseUrl: configuration.proof.audience });
      if (
        new URL(configuration.controlPlaneUrl).origin !== configuration.controlPlaneUrl ||
        new URL(configuration.proof.audience).origin !== configuration.proof.audience
      )
        throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
      const registrations = this.select(this.defaults(configuration), overrides);
      const scope = await this.mount(configuration, registrations);
      return new ProviderConnectionApplication(scope, configuration);
    } catch {
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    }
  }
  private static defaults(configuration: z.infer<typeof this.Config>): ProviderRegistration[] {
    const { proof, ...connection } = configuration;
    const artifact = { kind: 'bundled' as const, identity: AgentPackageIdentity.artifact };
    return [
      {
        token: ProviderProofToken,
        plugin: ProviderFileProofPlugin,
        declaration: ProviderFileProofPlugin.declaration,
        configuration: proof,
        artifact,
      },
      {
        token: ProviderConnectionToken,
        plugin: ProviderRegistrationPlugin,
        declaration: ProviderRegistrationPlugin.declaration,
        configuration: { ...connection, fingerprint: proof.fingerprint },
        artifact,
      },
    ];
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
        throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
      replaced.add(id);
      selected.set(id, registration);
    }
    return [...selected.values()];
  }
  private static selection(scopeId: string, registration: ProviderRegistration): ProviderSelection {
    return {
      scopeId,
      capability: registration.token.id,
      providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id,
    };
  }
  private static mount(
    configuration: z.infer<typeof this.Config>,
    registrations: ProviderRegistration[],
  ): Promise<CordisScope> {
    const { proof, ...connection } = configuration;
    const scopeId =
      'provider-connection:' +
      CanonicalJson.digest({ ...connection, fingerprint: proof.fingerprint });
    const selections = registrations.map(this.selection.bind(null, scopeId));
    return CordisScope.start(
      { registrations, selections },
      {
        scopeId,
        target: 'agent',
        principalId: proof.fingerprint,
        resourceScope: configuration.teamId,
      },
    );
  }
  async status(requestId: string, signal: AbortSignal): Promise<ControlRegistration> {
    try {
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      return await this.invoke(requestId, signal);
    } catch (error) {
      throw ConnectionFailure.safe(error);
    }
  }
  private async invoke(requestId: string, signal: AbortSignal): Promise<ControlRegistration> {
    const lease = await this.scope.acquire(ProviderConnectionToken);
    try {
      const result = ProviderControlSchemas.registration.parse(
        await lease.value.status(requestId, signal),
      );
      ProviderRegistrationPlugin.assertBinding(result, {
        ...this.configuration,
        fingerprint: this.configuration.proof.fingerprint,
      });
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      lease.assertOpen();
      return result;
    } finally {
      await lease.release();
    }
  }
  close(): Promise<void> {
    this.closed = true;
    if (!this.disposal) this.disposal = this.scope.dispose();
    return this.disposal;
  }
}
