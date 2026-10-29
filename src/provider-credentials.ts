import { z } from 'zod';
import {
  CanonicalJson,
  CapabilityToken,
  ProviderV4Schemas,
  type ProviderSelection,
} from '@treeseed-cordis/sdk';
import {
  ProviderControlSchemas,
  ProviderControlError,
  ProviderProtocolClient,
  type ProviderCredentialIssue,
  type ProviderRegistration as ControlRegistration,
} from '@treeseed-cordis/sdk/provider-control';
import {
  Context,
  CordisScope,
  CordisServiceLocator,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import {
  ProviderProofToken,
  ProviderFileProofPlugin,
  type ProviderProofSigner,
} from './provider-proof.js';
import { ProviderRegistrationPlugin } from './provider-connection.js';
import { AgentPackageIdentity } from './package-identity.js';
export interface ProviderCredentialExchange {
  exchange(idempotencyKey: string, signal: AbortSignal): Promise<ProviderCredentialIssue>;
}
class CredentialFailure {
  private static readonly codes: readonly ConstructorParameters<typeof ProviderControlError>[0][] =
    [
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
    try {
      if (error instanceof ProviderControlError) {
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
        if (this.codes.includes(code))
          return new ProviderControlError(
            code,
            Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
          );
      }
    } catch {
      /* Provider exceptions cannot expose private detail. */
    }
    return new ProviderControlError('PROVIDER_TRANSPORT_FAILED');
  }
}
class CredentialAdapter {
  parse(input: unknown): ProviderCredentialExchange {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'exchange') !== 'function')
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    return input as ProviderCredentialExchange;
  }
}
export const ProviderCredentialToken = new CapabilityToken<ProviderCredentialExchange>(
  'agent.provider.credential',
  ProviderV4Schemas.version,
  new CredentialAdapter(),
);
export class ProviderCredentialPlugin implements ProviderCredentialExchange {
  static readonly provide = ['agent.provider.credential'];
  static readonly inject = ['cordis.composition', 'agent.provider.proof'];
  static readonly Config = ProviderRegistrationPlugin.Config.extend({
    registrationId: ProviderControlSchemas.key,
    membershipId: ProviderControlSchemas.key,
  });
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.provider.credential.approved',
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
    private readonly configuration: z.infer<typeof ProviderCredentialPlugin.Config>,
  ) {
    this.client = new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
    context.provide(ProviderCredentialToken.id, this);
  }
  async exchange(input: string, signal: AbortSignal): Promise<ProviderCredentialIssue> {
    try {
      const key = ProviderControlSchemas.key.safeParse(input);
      if (!key.success) throw new ProviderControlError('INVALID_PROVIDER_REQUEST');
      return await this.invoke(key.data, signal);
    } catch (error) {
      throw CredentialFailure.safe(error);
    }
  }
  private async invoke(key: string, signal: AbortSignal): Promise<ProviderCredentialIssue> {
    if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
    const lease = await CordisServiceLocator.from(this.context).acquire(ProviderProofToken);
    try {
      await this.registration(lease.value, signal);
      const result = await this.issue(lease.value, key, signal);
      ProviderCredentialPlugin.assertIssue(result, this.configuration);
      await this.registration(lease.value, signal);
      if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      lease.assertOpen();
      return result;
    } finally {
      await lease.release();
    }
  }
  private async registration(
    proof: ProviderProofSigner,
    signal: AbortSignal,
  ): Promise<ControlRegistration> {
    const requestId = this.configuration.registrationId;
    const signed = await proof.sign(
      { method: 'GET', path: '/v1/provider-registrations/' + requestId, body: { requestId } },
      signal,
    );
    const registration = await this.client.registration(requestId, signed, signal);
    ProviderRegistrationPlugin.assertBinding(registration, this.configuration);
    if (
      registration.status !== 'approved' ||
      registration.membershipId !== this.configuration.membershipId
    )
      throw new ProviderControlError('PROVIDER_REQUEST_REJECTED', 409);
    return registration;
  }
  private async issue(
    proof: ProviderProofSigner,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ProviderCredentialIssue> {
    const requestId = this.configuration.registrationId;
    const signed = await proof.sign(
      {
        method: 'POST',
        path: '/v1/provider-registrations/' + requestId + '/credential',
        body: { requestId, idempotencyKey },
      },
      signal,
    );
    return this.client.exchangeCredential(requestId, signed, idempotencyKey, signal);
  }
  static assertIssue(
    input: unknown,
    binding: Pick<z.infer<typeof this.Config>, 'teamId' | 'providerId' | 'membershipId'>,
  ): ProviderCredentialIssue {
    const result = ProviderControlSchemas.credentialIssue.safeParse(input);
    if (!result.success) throw new ProviderControlError('INVALID_PROVIDER_RESPONSE');
    const credential = result.data;
    if (
      credential.teamId !== binding.teamId ||
      credential.providerId !== binding.providerId ||
      credential.membershipId !== binding.membershipId
    )
      throw new ProviderControlError('PROVIDER_IDENTITY_MISMATCH');
    if (
      credential.status !== 'active' ||
      (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) ||
      new Set(credential.scopes).size !== credential.scopes.length
    )
      throw new ProviderControlError('PROVIDER_REQUEST_REJECTED', 403);
    return credential;
  }
}
export class ProviderCredentialApplication implements ProviderCredentialExchange {
  static readonly Config = ProviderCredentialPlugin.Config.omit({ fingerprint: true }).extend({
    proof: ProviderFileProofPlugin.Config,
  });
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(
    private readonly scope: CordisScope,
    private readonly configuration: z.infer<typeof ProviderCredentialApplication.Config>,
  ) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<ProviderCredentialApplication> {
    try {
      const configuration = this.Config.parse(input);
      this.origins(configuration);
      const registrations = this.select(this.defaults(configuration), overrides);
      const scope = await this.mount(configuration, registrations);
      return new ProviderCredentialApplication(scope, configuration);
    } catch {
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    }
  }
  private static origins(configuration: z.infer<typeof this.Config>): void {
    for (const origin of [configuration.controlPlaneUrl, configuration.proof.audience]) {
      new ProviderProtocolClient({ baseUrl: origin });
      if (new URL(origin).origin !== origin)
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
        token: ProviderCredentialToken,
        plugin: ProviderCredentialPlugin,
        declaration: ProviderCredentialPlugin.declaration,
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
      'provider-credential:' +
      CanonicalJson.digest({ ...connection, fingerprint: proof.fingerprint });
    const selections = registrations.map(this.selection.bind(null, scopeId));
    return CordisScope.start(
      { registrations, selections },
      {
        scopeId,
        target: 'agent',
        principalId: proof.fingerprint,
        resourceScope: configuration.membershipId,
      },
    );
  }
  async exchange(input: string, signal: AbortSignal): Promise<ProviderCredentialIssue> {
    try {
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      const key = ProviderControlSchemas.key.safeParse(input);
      if (!key.success) throw new ProviderControlError('INVALID_PROVIDER_REQUEST');
      return await this.invoke(key.data, signal);
    } catch (error) {
      throw CredentialFailure.safe(error);
    }
  }
  private async invoke(key: string, signal: AbortSignal): Promise<ProviderCredentialIssue> {
    const lease = await this.scope.acquire(ProviderCredentialToken);
    try {
      const result = ProviderCredentialPlugin.assertIssue(
        await lease.value.exchange(key, signal),
        this.configuration,
      );
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      lease.assertOpen();
      return result;
    } finally {
      await lease.release();
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
      throw new ProviderControlError('PROVIDER_TRANSPORT_FAILED');
    }
  }
}
