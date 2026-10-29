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
