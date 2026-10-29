import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, verify } from 'node:crypto';
import { writeFileSync, chmodSync, unlinkSync, symlinkSync } from 'node:fs';
import * as Agent from '@treeseed-cordis/agent';
import {
  ProviderIdentityFixture,
  type ProofHost,
  type ProofRoot,
} from '../support/provider-proof-program.js';
class ProviderProofIntegration {
  private async host(fixture: ProviderIdentityFixture): Promise<ProofHost> {
    const Root = Reflect.get(Agent, 'ProviderProofApplication') as ProofRoot;
    assert(Root && typeof Root.start === 'function', 'default enrollment proof root missing');
    return Root.start(fixture.configuration);
  }
  async fresh(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      host = await this.host(fixture);
      const first = await host.sign(fixture.request, new AbortController().signal);
      const second = await host.sign(fixture.request, new AbortController().signal);
      assert.notEqual(first.payload, second.payload);
      chmodSync(fixture.file, 0o644);
      await this.denied(host, fixture.request);
      chmodSync(fixture.file, 0o600);
      writeFileSync(
        fixture.file,
        JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })),
      );
      await this.denied(host, fixture.request);
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  async keyPair(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      host = await this.host(fixture);
      const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
      writeFileSync(fixture.file, JSON.stringify({ ...fixture.jwk, d: other.d }));
      await this.denied(host, fixture.request);
      unlinkSync(fixture.file);
      symlinkSync('/etc/passwd', fixture.file);
      await this.denied(host, fixture.request);
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  async canonical(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      host = await this.host(fixture);
      const body = { z: 1, a: { c: 3, b: [2, { y: true, x: null }] } };
      const proof = await host.sign({ ...fixture.request, body }, new AbortController().signal);
      const payload = JSON.parse(Buffer.from(proof.payload, 'base64url').toString());
      const canonical = '{"a":{"b":[2,{"x":null,"y":true}],"c":3},"z":1}';
      assert.equal(payload.bodySha256, createHash('sha256').update(canonical).digest('base64url'));
      this.changedPath(proof, payload, fixture);
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  private changedPath(
    proof: { protected: string; signature: string },
    payload: object,
    fixture: ProviderIdentityFixture,
  ): void {
    const changed = Buffer.from(
      JSON.stringify({ ...payload, path: '/v1/provider-registrations' }),
    ).toString('base64url');
    assert.equal(
      verify(
        null,
        Buffer.from(proof.protected + '.' + changed),
        fixture.keys.publicKey,
        Buffer.from(proof.signature, 'base64url'),
      ),
      false,
    );
  }
  async bounds(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      host = await this.host(fixture);
      for (const request of this.invalid(fixture)) await this.denied(host, request);
      const cancellation = new AbortController();
      cancellation.abort();
      await assert.rejects(
        host.sign(fixture.request, cancellation.signal),
        /^Error: PROVIDER_PROOF_INVALID$/,
      );
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  async configuration(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    try {
      for (const audience of [
        'http://example.com',
        'https://example.com/path',
        'https://u:p@example.com',
        'https://example.com/?q=CANARY',
      ])
        await this.deniedConfiguration({ ...fixture.configuration, audience });
      await this.deniedConfiguration({ ...fixture.configuration, identityVersion: 0 });
      await this.deniedConfiguration({ ...fixture.configuration, fingerprint: 'CANARY' });
    } finally {
      fixture.close();
    }
  }
  private async deniedConfiguration(input: unknown): Promise<void> {
    const Root = Reflect.get(Agent, 'ProviderProofApplication') as ProofRoot;
    await assert.rejects(Root.start(input), /^Error: PROVIDER_PROOF_INVALID$/);
  }
  private getterCalled = false;
  private getter(): string {
    this.getterCalled = true;
    return 'PRIVATE_CANARY';
  }
  async json(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      host = await this.host(fixture);
      const body = Object.defineProperty({}, 'secret', {
        enumerable: true,
        get: this.getter.bind(this),
      });
      for (const input of this.invalidJson(body))
        await this.denied(host, { ...fixture.request, body: input });
      assert.equal(this.getterCalled, false);
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  private invalidJson(getter: object): unknown[] {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    return [getter, cycle, new Array(2), { invalid: undefined }, { invalid: Infinity }];
  }
  private invalid(fixture: ProviderIdentityFixture): unknown[] {
    let nested: unknown = null;
    for (let count = 0; count < 33; count++) nested = { child: nested };
    return [
      { ...fixture.request, path: '/v1/teams' },
      { ...fixture.request, path: '/v1/provider/access-tokens?secret=CANARY' },
      { ...fixture.request, method: 'DELETE' },
      { ...fixture.request, body: 'CANARY'.repeat(12000) },
      { ...fixture.request, body: nested },
      { ...fixture.request, unknown: 'CANARY' },
    ];
  }
  private async denied(host: ProofHost, input: unknown): Promise<void> {
    await assert.rejects(
      host.sign(input, new AbortController().signal),
      /^Error: PROVIDER_PROOF_INVALID$/,
    );
  }
}
const suite = new ProviderProofIntegration();
test(
  'integration: native proof provider rereads identity and rejects unsafe permissions or changed fingerprints',
  suite.fresh.bind(suite),
);
test(
  'integration: provider signer rejects mismatched private/public key material and symlink identity files',
  suite.keyPair.bind(suite),
);
test(
  'integration: enrollment proofs preserve recursive legacy canonical body binding and reject changed signed paths',
  suite.canonical.bind(suite),
);
test(
  'integration: native proof root rejects unsupported requests oversized or deep bodies and pre-cancellation with safe errors',
  suite.bounds.bind(suite),
);

test(
  'integration: native proof configuration rejects foreign noncanonical audiences and malformed pinned identities',
  suite.configuration.bind(suite),
);
test(
  'integration: proof canonicalization rejects cyclic sparse and non-JSON bodies without invoking body getters',
  suite.json.bind(suite),
);
