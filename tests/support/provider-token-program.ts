import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { ProviderV4Schemas } from '@treeseed-cordis/sdk';
import { ProviderCredentialToken } from '@treeseed-cordis/agent/provider-credentials';
import { ProviderCredentialFixture } from './provider-credential-fixture.js';
import {
  ProviderControlSchemas,
  type ProviderTokenIssue,
  type ProviderCredentialIssue,
} from '@treeseed-cordis/sdk/provider-control';
import { ProviderTokenFixture } from './provider-token-fixture.js';
interface TokenHost {
  issue(input: unknown, signal: AbortSignal): Promise<ProviderTokenIssue>;
  close(): Promise<void>;
}
interface TokenRoot {
  start(input: unknown, overrides?: ProviderRegistration[]): Promise<TokenHost>;
}
/** Hostile selected implementation verifies facade binding above provider selection. */
class ForeignTokenPlugin {
  static readonly provide = ['agent.provider.token'];
  static readonly inject: string[] = [];
  static readonly Config = ProviderControlSchemas.tokenIssue;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.token.foreign',
    pluginId: 'fixture',
    capability: this.provide[0],
    target: 'agent',
    contractVersion: ProviderV4Schemas.version,
    provide: this.provide,
    inject: this.inject,
  });
  constructor(
    context: Context,
    private readonly result: ProviderTokenIssue,
  ) {
    context.provide('agent.provider.token', this);
  }
  async issue(): Promise<ProviderTokenIssue> {
    if (process.argv[3] === 'alternative-error') throw new Error('PRIVATE_TOKEN_CANARY');
    return structuredClone(this.result);
  }
}
/** Cancellation during selected-provider read-back, with no private root access. */
class LateCancellationCredentialPlugin {
  static cancellation: AbortController | null = null;
  static readonly provide = ['agent.provider.credential'];
  static readonly inject: string[] = [];
  static readonly Config = ProviderControlSchemas.credentialIssue;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.credential.late-cancel',
    pluginId: 'fixture',
    capability: this.provide[0],
    target: 'agent',
    contractVersion: ProviderV4Schemas.version,
    provide: this.provide,
    inject: this.inject,
  });
  private reads = 0;
  constructor(
    context: Context,
    private readonly result: ProviderCredentialIssue,
  ) {
    context.provide('agent.provider.credential', this);
  }
  async exchange(): Promise<ProviderCredentialIssue> {
    const result = structuredClone(this.result);
    if (++this.reads > 1)
      Object.defineProperty(result, 'credential', {
        enumerable: true,
        get: this.credential.bind(this),
      });
    return result;
  }
  private credential(): string {
    const controller = LateCancellationCredentialPlugin.cancellation!;
    queueMicrotask(controller.abort.bind(controller));
    return this.result.credential;
  }
}
class ProviderTokenProgram {
  private readonly input = {
    credentialIssueKey: 'fixture-issue',
    tokenIssueKey: 'fixture-token-issue',
    requestedValiditySeconds: 60,
  };
  async run(): Promise<void> {
    const module = await import('@treeseed-cordis/agent/provider-token');
    const Root = Reflect.get(module, 'ProviderTokenApplication') as TokenRoot;
    assert(Root && typeof Root.start === 'function', 'native token root missing');
    const configuration = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
    const host = await Root.start(configuration, this.overrides(module));
    try {
      await this.exercise(host);
    } finally {
      await host.close();
    }
  }
  private overrides(module: object): ProviderRegistration[] {
    if (process.argv[3] === 'late-cancel')
      return [
        {
          token: ProviderCredentialToken,
          plugin: LateCancellationCredentialPlugin,
          declaration: LateCancellationCredentialPlugin.declaration,
          configuration: ProviderCredentialFixture.issue('accepted'),
          artifact: { kind: 'bundled', identity: 'fixture:late-credential-cancellation' },
        },
      ];
    if (!process.argv[3]?.startsWith('alternative')) return [];
    return [
      {
        token: Reflect.get(module, 'ProviderTokenToken'),
        plugin: ForeignTokenPlugin,
        declaration: ForeignTokenPlugin.declaration,
        configuration: ProviderTokenFixture.issueToken('alternative'),
        artifact: { kind: 'bundled', identity: 'fixture:unsafe-token' },
      },
    ];
  }
  private async exercise(host: TokenHost): Promise<void> {
    const controller = new AbortController();
    LateCancellationCredentialPlugin.cancellation = controller;
    if (process.argv[3] === 'cancel') controller.abort();
    const input =
      process.argv[3] === 'invalid' ? { ...this.input, tokenIssueKey: '../unsafe' } : this.input;
    if (process.argv[3] !== 'accepted') {
      await assert.rejects(host.issue(input, controller.signal), this.safe.bind(this));
      process.stdout.write('provider-token-refused\n');
      return;
    }
    const first = await host.issue(input, controller.signal);
    const repeated = await host.issue(input, controller.signal);
    assert.equal(first.id, 'fixture-token');
    assert.equal(first.accessToken, repeated.accessToken);
    await host.close();
    await assert.rejects(host.issue(input, controller.signal), this.safe.bind(this));
    process.stdout.write('provider-token-ok\n');
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^(?:PROVIDER|INVALID_PROVIDER)_[A-Z_]+$/);
    assert(!error.message.includes('PRIVATE_'));
    return true;
  }
}
if (import.meta.main) await new ProviderTokenProgram().run();
