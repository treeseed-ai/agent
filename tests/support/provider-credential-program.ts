import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Agent from '@treeseed-cordis/agent';
import {
  ProviderControlSchemas,
  type ProviderCredentialIssue,
} from '@treeseed-cordis/sdk/provider-control';
import { ProviderV4Schemas } from '@treeseed-cordis/sdk';
import { Context, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { ProviderCredentialFixture } from './provider-credential-fixture.js';
interface CredentialHost {
  exchange(key: string, signal: AbortSignal): Promise<ProviderCredentialIssue>;
  close(): Promise<void>;
}
interface CredentialRoot {
  start(input: unknown, overrides?: ProviderRegistration[]): Promise<CredentialHost>;
}
/** Intentionally unsafe selected provider: coherent identity checks must survive replacement. */
class ForeignCredentialPlugin {
  static readonly provide = ['agent.provider.credential'];
  static readonly inject: string[] = [];
  static readonly Config = ProviderControlSchemas.credentialIssue;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.credential.foreign',
    pluginId: 'fixture',
    capability: this.provide[0],
    target: 'agent',
    contractVersion: ProviderV4Schemas.version,
    provide: this.provide,
    inject: this.inject,
  });
  constructor(
    context: Context,
    private readonly result: ProviderCredentialIssue,
  ) {
    context.provide('agent.provider.credential', this);
  }
  async exchange(): Promise<ProviderCredentialIssue> {
    return structuredClone(this.result);
  }
}
class CredentialProgram {
  async run(): Promise<void> {
    const Root = Reflect.get(Agent, 'ProviderCredentialApplication') as CredentialRoot;
    assert(Root && typeof Root.start === 'function', 'native approved credential root missing');
    const configuration = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
    const host = await Root.start(configuration, this.overrides());
    try {
      await this.exercise(host);
    } finally {
      await host.close();
    }
  }
  private overrides(): ProviderRegistration[] {
    if (process.argv[3] !== 'alternative') return [];
    return [
      {
        token: Reflect.get(Agent, 'ProviderCredentialToken'),
        plugin: ForeignCredentialPlugin,
        declaration: ForeignCredentialPlugin.declaration,
        configuration: ProviderCredentialFixture.issue('alternative'),
        artifact: { kind: 'bundled', identity: 'fixture:unsafe-credential' },
      },
    ];
  }
  private async exercise(host: CredentialHost): Promise<void> {
    const controller = new AbortController();
    if (process.argv[3] === 'cancel') controller.abort();
    if (process.argv[3] !== 'accepted') {
      await assert.rejects(host.exchange('fixture-issue', controller.signal), this.safe.bind(this));
      process.stdout.write('provider-credential-refused\n');
      return;
    }
    const first = await host.exchange('fixture-issue', controller.signal);
    const repeated = await host.exchange('fixture-issue', controller.signal);
    assert.equal(first.id, 'fixture-credential');
    assert.equal(first.membershipId, 'fixture-membership');
    assert.equal(first.teamId, 'fixture-team');
    assert(first.credential === repeated.credential);
    await host.close();
    await assert.rejects(host.exchange('fixture-issue', controller.signal), this.safe.bind(this));
    process.stdout.write('provider-credential-ok\n');
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^PROVIDER_[A-Z_]+$/);
    assert(!error.message.includes('PRIVATE_CREDENTIAL_CANARY'));
    return true;
  }
}
if (import.meta.main) await new CredentialProgram().run();
