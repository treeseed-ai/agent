import assert from 'node:assert/strict';
import { readFileSync, chmodSync, renameSync, symlinkSync } from 'node:fs';
import * as Agent from '@treeseed-cordis/agent';
import {
  ProviderControlSchemas,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/provider-control';
import {
  Context,
  type ProviderRegistration as NativeRegistration,
} from '@treeseed-cordis/sdk/runtime';
import { ProviderV4Schemas } from '@treeseed-cordis/sdk';
import { ProviderRegistrationFixture } from './provider-registration-program.js';
import { ProviderEnrollmentFixture } from './provider-enrollment-fixture.js';
interface EnrollmentHost {
  submit(input: unknown, signal: AbortSignal): Promise<ProviderRegistration>;
  close(): Promise<void>;
}
interface EnrollmentRoot {
  start(input: unknown, overrides?: NativeRegistration[]): Promise<EnrollmentHost>;
}
/** Deliberately foreign selected provider; coherent enrollment identity is mandatory. */
class ForeignEnrollment {
  static readonly provide = ['agent.provider.enrollment'];
  static readonly inject: string[] = [];
  static readonly Config = ProviderControlSchemas.registration;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.foreign.enrollment',
    pluginId: 'fixture',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(
    context: Context,
    private readonly configuration: ProviderRegistration,
  ) {
    context.provide(ForeignEnrollment.provide[0]!, this);
  }
  async submit(): Promise<ProviderRegistration> {
    return this.configuration;
  }
}
interface EnrollmentConfiguration {
  registrationKeyFile: string;
  publicJwk: { x: string };
  proof: { audience: string; fingerprint: string };
}
class ProviderEnrollmentProgram {
  async run(): Promise<void> {
    const Root = Reflect.get(Agent, 'ProviderEnrollmentApplication') as EnrollmentRoot;
    assert(Root && typeof Root.start === 'function', 'default enrollment root missing');
    const configuration = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
    const mode = process.argv[3]!;
    this.corrupt(configuration, mode);
    if (mode === 'identity' || mode === 'audience') {
      await assert.rejects(Root.start(configuration), { code: 'INVALID_PROVIDER_CONFIGURATION' });
      return this.marker(mode);
    }
    const host = await Root.start(configuration, this.overrides(configuration, mode));
    try {
      await this.exercise(host, mode);
    } finally {
      await host.close();
    }
    this.marker(mode);
  }
  private corrupt(configuration: EnrollmentConfiguration, mode: string): void {
    if (mode === 'identity') configuration.publicJwk.x = 'A'.repeat(43);
    if (mode === 'audience') configuration.proof.audience = 'https://foreign.fixture.invalid';
    if (mode === 'permissions') chmodSync(configuration.registrationKeyFile, 0o644);
    if (mode === 'symlink') {
      renameSync(configuration.registrationKeyFile, configuration.registrationKeyFile + '.held');
      symlinkSync(configuration.registrationKeyFile + '.held', configuration.registrationKeyFile);
    }
  }
  private overrides(configuration: EnrollmentConfiguration, mode: string): NativeRegistration[] {
    if (mode !== 'alternative') return [];
    const token = Reflect.get(Agent, 'ProviderEnrollmentToken');
    return [
      {
        token,
        plugin: ForeignEnrollment,
        declaration: ForeignEnrollment.declaration,
        configuration: {
          ...ProviderRegistrationFixture.response(configuration.proof.fingerprint, 'foreign'),
          capabilitySummary: ProviderEnrollmentFixture.input.capabilitySummary,
          supplyOffer: ProviderEnrollmentFixture.input.supplyOffer,
        },
        artifact: { kind: 'bundled', identity: 'fixture:foreign-enrollment' },
      },
    ];
  }
  private async exercise(host: EnrollmentHost, mode: string): Promise<void> {
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    if (mode === 'closed') await host.close();
    const input =
      mode === 'invalid'
        ? { ...ProviderEnrollmentFixture.input, command: 'secret' }
        : ProviderEnrollmentFixture.input;
    const rejected = this.code(mode);
    if (rejected) {
      await assert.rejects(host.submit(input, controller.signal), { code: rejected });
      return;
    }
    const result = await host.submit(input, controller.signal);
    assert.equal(result.status, 'pending');
    assert.equal(result.teamId, 'fixture-team');
    assert.equal(result.providerId, 'fixture-provider');
    assert(!JSON.stringify(result).includes('REGISTRATION_CODE_CANARY'));
    if (mode === 'repeat') assert.deepEqual(await host.submit(input, controller.signal), result);
  }
  private code(mode: string): string | null {
    if (['foreign', 'offer', 'alternative'].includes(mode)) return 'PROVIDER_IDENTITY_MISMATCH';
    if (['permissions', 'symlink'].includes(mode)) return 'INVALID_PROVIDER_CONFIGURATION';
    if (['cancelled', 'closed'].includes(mode)) return 'PROVIDER_CANCELLED';
    if (mode === 'invalid') return 'INVALID_PROVIDER_REQUEST';
    return null;
  }
  private marker(mode: string): void {
    process.stdout.write('enrollment-' + mode + '-ok\n');
  }
}
if (import.meta.main) await new ProviderEnrollmentProgram().run();
