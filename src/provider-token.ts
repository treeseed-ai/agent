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
  type ProviderTokenIssue,
} from '@treeseed-cordis/sdk/provider-control';
import {
  Context,
  CordisScope,
  CordisServiceLocator,
  type ProviderRegistration,
  type ProviderLease,
} from '@treeseed-cordis/sdk/runtime';
import {
  ProviderFileProofPlugin,
  ProviderProofToken,
  type ProviderProofSigner,
} from './provider-proof.js';
import {
  ProviderCredentialApplication,
  ProviderCredentialPlugin,
  ProviderCredentialToken,
  type ProviderCredentialExchange,
} from './provider-credentials.js';
import { AgentPackageIdentity } from './package-identity.js';
export type ProviderTokenInput = z.infer<typeof ProviderTokenPlugin.Input>;
export interface ProviderTokenIssuer {
  issue(
    credential: ProviderCredentialIssue,
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue>;
}
class TokenFailure {
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
      /* Selected implementations cannot leak private error detail. */
    }
    return new ProviderControlError('PROVIDER_TRANSPORT_FAILED');
  }
}
class TokenAdapter {
  parse(input: unknown): ProviderTokenIssuer {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'issue') !== 'function')
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    return input as ProviderTokenIssuer;
  }
}
export const ProviderTokenToken = new CapabilityToken<ProviderTokenIssuer>(
  'agent.provider.token',
  ProviderV4Schemas.version,
  new TokenAdapter(),
);
export class ProviderTokenPlugin implements ProviderTokenIssuer {
  static readonly provide = ['agent.provider.token'];
  static readonly inject = ['cordis.composition', 'agent.provider.proof'];
  static readonly Config = ProviderCredentialPlugin.Config.extend({
    identityVersion: ProviderFileProofPlugin.Config.shape.identityVersion,
  });
  static readonly Input = z.strictObject({
    credentialIssueKey: ProviderControlSchemas.key,
    tokenIssueKey: ProviderControlSchemas.key,
    requestedValiditySeconds: ProviderControlSchemas.tokenRequest.shape.requestedValiditySeconds,
  });
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.provider.token.approved',
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
    private readonly configuration: z.infer<typeof ProviderTokenPlugin.Config>,
  ) {
    this.client = new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
    context.provide(ProviderTokenToken.id, this);
  }
  async issue(
    credential: ProviderCredentialIssue,
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue> {
    try {
      const request = ProviderTokenPlugin.Input.safeParse(input);
      if (!request.success) throw new ProviderControlError('INVALID_PROVIDER_REQUEST');
      const admitted = ProviderCredentialPlugin.assertIssue(credential, this.configuration);
      if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      return await this.invoke(admitted, request.data, signal);
    } catch (error) {
      throw TokenFailure.safe(error);
    }
  }
  private async invoke(
    credential: ProviderCredentialIssue,
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue> {
    const lease = await CordisServiceLocator.from(this.context).acquire(ProviderProofToken);
    try {
      const result = await this.request(lease.value, credential, input, signal);
      const token = ProviderTokenPlugin.assertIssue(
        result,
        credential,
        this.configuration.identityVersion,
      );
      if (signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      lease.assertOpen();
      return token;
    } finally {
      await lease.release();
    }
  }
  private async request(
    proof: ProviderProofSigner,
    credential: ProviderCredentialIssue,
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue> {
    const validity =
      input.requestedValiditySeconds === undefined
        ? {}
        : { requestedValiditySeconds: input.requestedValiditySeconds };
    const body = { credentialId: credential.id, idempotencyKey: input.tokenIssueKey, ...validity };
    const signed = await proof.sign(
      { method: 'POST', path: '/v1/provider/access-tokens', body },
      signal,
    );
    return this.client.issueAccessToken(
      credential.credential,
      { credentialId: credential.id, proof: signed, ...validity },
      input.tokenIssueKey,
      signal,
    );
  }
  static assertIssue(
    input: unknown,
    credential: ProviderCredentialIssue,
    identityVersion: number,
  ): ProviderTokenIssue {
    const result = ProviderControlSchemas.tokenIssue.safeParse(input);
    if (!result.success) throw new ProviderControlError('INVALID_PROVIDER_RESPONSE');
    const token = result.data;
    this.binding(token, credential, identityVersion);
    this.state(token, credential);
    return token;
  }
  private static binding(
    token: ProviderTokenIssue,
    credential: ProviderCredentialIssue,
    identityVersion: number,
  ): void {
    if (
      token.teamId !== credential.teamId ||
      token.providerId !== credential.providerId ||
      token.membershipId !== credential.membershipId ||
      token.credentialId !== credential.id ||
      token.identityVersion !== identityVersion
    )
      throw new ProviderControlError('PROVIDER_IDENTITY_MISMATCH');
  }
  private static state(token: ProviderTokenIssue, credential: ProviderCredentialIssue): void {
    if (
      token.status !== 'active' ||
      token.revokedAt ||
      Date.parse(token.expiresAt) <= Date.now() ||
      Date.parse(token.issuedAt) > Date.now() ||
      Date.parse(token.expiresAt) <= Date.parse(token.issuedAt)
    )
      throw new ProviderControlError('PROVIDER_REQUEST_REJECTED', 403);
    for (const scope of token.scopes)
      if (!credential.scopes.includes(scope))
        throw new ProviderControlError('PROVIDER_REQUEST_REJECTED', 403);
    if (new Set(token.scopes).size !== token.scopes.length)
      throw new ProviderControlError('INVALID_PROVIDER_RESPONSE');
  }
}
/** Coherent facade validates identity, authority read-back and retained native generations. */
export class ProviderTokenApplication {
  static readonly Config = ProviderCredentialApplication.Config;
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(
    private readonly scope: CordisScope,
    private readonly configuration: z.infer<typeof ProviderTokenApplication.Config>,
  ) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<ProviderTokenApplication> {
    try {
      const configuration = this.Config.parse(input);
      new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
      if (
        configuration.controlPlaneUrl !== configuration.proof.audience ||
        new URL(configuration.controlPlaneUrl).origin !== configuration.controlPlaneUrl
      )
        throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
      const registrations = this.select(this.defaults(configuration), overrides);
      const scope = await this.mount(configuration, registrations);
      return new ProviderTokenApplication(scope, configuration);
    } catch {
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    }
  }
  private static readonly providers = [
    { token: ProviderProofToken, plugin: ProviderFileProofPlugin },
    { token: ProviderCredentialToken, plugin: ProviderCredentialPlugin },
    { token: ProviderTokenToken, plugin: ProviderTokenPlugin },
  ];
  private static defaults(configuration: z.infer<typeof this.Config>): ProviderRegistration[] {
    const registrations: ProviderRegistration[] = [];
    for (const { token, plugin } of this.providers) {
      const selected = this.providerConfiguration(token.id, configuration);
      registrations.push({
        token,
        plugin,
        declaration: plugin.declaration,
        configuration: selected,
        artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
      });
    }
    return registrations;
  }
  private static providerConfiguration(
    id: string,
    configuration: z.infer<typeof this.Config>,
  ): object {
    const { proof, ...binding } = configuration;
    if (id === ProviderProofToken.id) return proof;
    return {
      ...binding,
      fingerprint: proof.fingerprint,
      ...(id === ProviderTokenToken.id ? { identityVersion: proof.identityVersion } : {}),
    };
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
      'provider-token:' +
      CanonicalJson.digest({
        ...connection,
        fingerprint: proof.fingerprint,
        identityVersion: proof.identityVersion,
      });
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
  async issue(input: unknown, signal: AbortSignal): Promise<ProviderTokenIssue> {
    try {
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      const request = ProviderTokenPlugin.Input.safeParse(input);
      if (!request.success) throw new ProviderControlError('INVALID_PROVIDER_REQUEST');
      return await this.invoke(request.data, signal);
    } catch (error) {
      throw TokenFailure.safe(error);
    }
  }
  private async invoke(
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue> {
    const lease = await this.scope.acquire(ProviderCredentialToken);
    try {
      const credential = ProviderCredentialPlugin.assertIssue(
        await lease.value.exchange(input.credentialIssueKey, signal),
        this.configuration,
      );
      return await this.selected(lease, credential, input, signal);
    } finally {
      await lease.release();
    }
  }
  private async selected(
    credentialLease: ProviderLease<ProviderCredentialExchange>,
    credential: ProviderCredentialIssue,
    input: ProviderTokenInput,
    signal: AbortSignal,
  ): Promise<ProviderTokenIssue> {
    const lease = await this.scope.acquire(ProviderTokenToken);
    try {
      const result = await lease.value.issue(credential, input, signal);
      const fresh = ProviderCredentialPlugin.assertIssue(
        await credentialLease.value.exchange(input.credentialIssueKey, signal),
        this.configuration,
      );
      ProviderTokenApplication.sameCredential(credential, fresh);
      const token = ProviderTokenPlugin.assertIssue(
        result,
        fresh,
        this.configuration.proof.identityVersion,
      );
      if (this.closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
      credentialLease.assertOpen();
      lease.assertOpen();
      return token;
    } finally {
      await lease.release();
    }
  }
  private static sameCredential(
    previous: ProviderCredentialIssue,
    current: ProviderCredentialIssue,
  ): void {
    if (
      previous.id !== current.id ||
      previous.issuanceGeneration !== current.issuanceGeneration ||
      previous.credential !== current.credential
    )
      throw new ProviderControlError('PROVIDER_IDENTITY_MISMATCH');
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
