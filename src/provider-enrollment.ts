import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CanonicalJson,
  CapabilityToken,
  PlatformSchemas,
  ProviderV4Schemas,
} from '@treeseed-cordis/sdk';
import {
  ProviderControlSchemas,
  ProviderControlError,
  ProviderProtocolClient,
  type ProviderRegistration as EnrollmentRecord,
  type ProviderRegistrationSubmission,
} from '@treeseed-cordis/sdk/provider-control';
import {
  Context,
  CordisScope,
  CordisServiceLocator,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/runtime';
import { AgentPrivateFile } from './authority.js';
import { AgentPackageIdentity } from './package-identity.js';
import {
  ProviderConnectionApplication,
  ProviderRegistrationPlugin,
} from './provider-connection.js';
import {
  ProviderFileProofPlugin,
  ProviderProofToken,
  type ProviderProofSigner,
} from './provider-proof.js';

export interface ProviderEnrollment {
  submit(input: unknown, signal: AbortSignal): Promise<EnrollmentRecord>;
}
class EnrollmentContracts {
  static readonly additional = {
    publicJwk: ProviderControlSchemas.publicJwk,
    registrationKeyFile: PlatformSchemas.absolute,
  };
  static readonly configuration = ProviderRegistrationPlugin.Config.extend(this.additional);
  static readonly input = ProviderControlSchemas.submission
    .omit({ schemaVersion: true, publicJwk: true, proof: true })
    .extend({ idempotencyKey: ProviderControlSchemas.key });
  static readonly secret = z.strictObject({ registrationKey: ProviderControlSchemas.secret });
  static identity(configuration: z.infer<typeof this.configuration>): void {
    new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
    const { kty, crv, x } = configuration.publicJwk;
    const fingerprint =
      'sha256:' +
      createHash('sha256').update(CanonicalJson.stringify({ kty, crv, x })).digest('base64url');
    if (
      fingerprint !== configuration.fingerprint ||
      new URL(configuration.controlPlaneUrl).origin !== configuration.controlPlaneUrl
    )
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
  }
  static assert(
    result: EnrollmentRecord,
    configuration: z.infer<typeof this.configuration>,
    input: Pick<z.infer<typeof this.input>, 'capabilitySummary' | 'supplyOffer'>,
  ): void {
    ProviderRegistrationPlugin.assertBinding(result, configuration);
    if (
      CanonicalJson.stringify(result.capabilitySummary) !==
        CanonicalJson.stringify(input.capabilitySummary) ||
      CanonicalJson.stringify(result.supplyOffer) !== CanonicalJson.stringify(input.supplyOffer)
    )
      throw new ProviderControlError('PROVIDER_IDENTITY_MISMATCH');
  }
  static active(closed: boolean, signal: AbortSignal): void {
    if (closed || signal.aborted) throw new ProviderControlError('PROVIDER_CANCELLED');
  }
  static parse<T>(
    schema: z.ZodType<T>,
    input: unknown,
    code:
      | 'INVALID_PROVIDER_REQUEST'
      | 'INVALID_PROVIDER_CONFIGURATION'
      | 'INVALID_PROVIDER_RESPONSE',
  ): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new ProviderControlError(code);
    return result.data;
  }
  static key(file: string): string {
    try {
      return this.secret.parse(AgentPrivateFile.read(file)).registrationKey;
    } catch {
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    }
  }
}
class EnrollmentFailure {
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
      /* Selected providers cannot expose private error detail. */
    }
    return new ProviderControlError('PROVIDER_TRANSPORT_FAILED');
  }
}
class EnrollmentAdapter {
  parse(input: unknown): ProviderEnrollment {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'submit') !== 'function')
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    return input as ProviderEnrollment;
  }
}
export const ProviderEnrollmentToken = new CapabilityToken<ProviderEnrollment>(
  'agent.provider.enrollment',
  ProviderV4Schemas.version,
  new EnrollmentAdapter(),
);
/** Same-repository replacement of the legacy signed registration submission adapter. */
export class ProviderEnrollmentPlugin implements ProviderEnrollment {
  static readonly provide = ['agent.provider.enrollment'];
  static readonly inject = ['cordis.composition', 'agent.provider.proof'];
  static readonly Config = EnrollmentContracts.configuration;
  static readonly Input = EnrollmentContracts.input;
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.provider.enrollment.registration',
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
    private readonly configuration: z.infer<typeof ProviderEnrollmentPlugin.Config>,
  ) {
    EnrollmentContracts.identity(configuration);
    this.client = new ProviderProtocolClient({ baseUrl: configuration.controlPlaneUrl });
    context.provide(ProviderEnrollmentToken.id, this);
  }
  async submit(input: unknown, signal: AbortSignal): Promise<EnrollmentRecord> {
    try {
      EnrollmentContracts.active(false, signal);
      const request = EnrollmentContracts.parse(
        ProviderEnrollmentPlugin.Input,
        input,
        'INVALID_PROVIDER_REQUEST',
      );
      return await this.send(request, signal);
    } catch (error) {
      throw EnrollmentFailure.safe(error);
    }
  }
  private async send(
    input: z.infer<typeof ProviderEnrollmentPlugin.Input>,
    signal: AbortSignal,
  ): Promise<EnrollmentRecord> {
    const registrationKey = EnrollmentContracts.key(this.configuration.registrationKeyFile);
    const lease = await CordisServiceLocator.from(this.context).acquire(ProviderProofToken);
    try {
      const submission = await this.signed(input, lease.value, signal);
      lease.assertOpen();
      EnrollmentContracts.active(false, signal);
      const result = await this.publish(submission, input.idempotencyKey, registrationKey, signal);
      lease.assertOpen();
      return result;
    } finally {
      await lease.release();
    }
  }
  private async signed(
    input: z.infer<typeof ProviderEnrollmentPlugin.Input>,
    signer: ProviderProofSigner,
    signal: AbortSignal,
  ): Promise<ProviderRegistrationSubmission> {
    const { idempotencyKey, ...description } = input;
    const unsigned = {
      schemaVersion: 1 as const,
      ...description,
      publicJwk: this.configuration.publicJwk,
    };
    const proof = await signer.sign(
      { method: 'POST', path: '/v1/provider-registrations', body: unsigned },
      signal,
    );
    return { ...unsigned, proof };
  }
  private async publish(
    submission: ProviderRegistrationSubmission,
    idempotencyKey: string,
    registrationKey: string,
    signal: AbortSignal,
  ): Promise<EnrollmentRecord> {
    const result = await this.client.register(registrationKey, submission, idempotencyKey, signal);
    EnrollmentContracts.assert(result, this.configuration, submission);
    EnrollmentContracts.active(false, signal);
    return result;
  }
}
/** Coherent enrollment identity checks remain outside selectable provider behavior. */
export class ProviderEnrollmentApplication implements ProviderEnrollment {
  static readonly Config = ProviderConnectionApplication.Config.extend(
    EnrollmentContracts.additional,
  );
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(
    private readonly scope: CordisScope,
    private readonly configuration: z.infer<typeof ProviderEnrollmentApplication.Config>,
  ) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<ProviderEnrollmentApplication> {
    try {
      const configuration = this.Config.parse(input);
      const expected = this.binding(configuration);
      EnrollmentContracts.identity(expected);
      if (configuration.proof.audience !== configuration.controlPlaneUrl)
        throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
      const registrations = this.select(this.defaults(configuration), overrides);
      const scope = await this.mount(configuration, registrations);
      return new ProviderEnrollmentApplication(scope, configuration);
    } catch {
      throw new ProviderControlError('INVALID_PROVIDER_CONFIGURATION');
    }
  }
  private static binding(
    configuration: z.infer<typeof this.Config>,
  ): z.infer<typeof ProviderEnrollmentPlugin.Config> {
    const { proof, ...binding } = configuration;
    return { ...binding, fingerprint: proof.fingerprint };
  }
  private static defaults(configuration: z.infer<typeof this.Config>): ProviderRegistration[] {
    const artifact = { kind: 'bundled' as const, identity: AgentPackageIdentity.artifact };
    return [
      {
        token: ProviderProofToken,
        plugin: ProviderFileProofPlugin,
        declaration: ProviderFileProofPlugin.declaration,
        configuration: configuration.proof,
        artifact,
      },
      {
        token: ProviderEnrollmentToken,
        plugin: ProviderEnrollmentPlugin,
        declaration: ProviderEnrollmentPlugin.declaration,
        configuration: this.binding(configuration),
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
  private static mount(
    configuration: z.infer<typeof this.Config>,
    registrations: ProviderRegistration[],
  ): Promise<CordisScope> {
    const scopeId = 'provider-enrollment:' + CanonicalJson.digest(configuration);
    const selections = [];
    for (const registration of registrations)
      selections.push({
        scopeId,
        capability: registration.token.id,
        providerId: ProviderV4Schemas.declaration.parse(registration.declaration).id,
      });
    return CordisScope.start(
      { registrations, selections },
      {
        scopeId,
        target: 'agent',
        principalId: configuration.proof.fingerprint,
        resourceScope: configuration.teamId,
      },
    );
  }
  async submit(input: unknown, signal: AbortSignal): Promise<EnrollmentRecord> {
    try {
      EnrollmentContracts.active(this.closed, signal);
      const request = EnrollmentContracts.parse(
        ProviderEnrollmentPlugin.Input,
        input,
        'INVALID_PROVIDER_REQUEST',
      );
      return await this.invoke(request, signal);
    } catch (error) {
      throw EnrollmentFailure.safe(error);
    }
  }
  private async invoke(
    request: z.infer<typeof ProviderEnrollmentPlugin.Input>,
    signal: AbortSignal,
  ): Promise<EnrollmentRecord> {
    const lease = await this.scope.acquire(ProviderEnrollmentToken);
    try {
      const result = EnrollmentContracts.parse(
        ProviderControlSchemas.registration,
        await lease.value.submit(structuredClone(request), signal),
        'INVALID_PROVIDER_RESPONSE',
      );
      EnrollmentContracts.assert(
        result,
        ProviderEnrollmentApplication.binding(this.configuration),
        request,
      );
      EnrollmentContracts.active(this.closed, signal);
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
