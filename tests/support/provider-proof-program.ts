import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Agent from '@treeseed-cordis/agent';
import {
  ProviderControlSchemas,
  type ProviderSignedProof,
} from '@treeseed-cordis/sdk/provider-control';
export interface ProofHost {
  sign(input: unknown, signal: AbortSignal): Promise<ProviderSignedProof>;
  close(): Promise<void>;
}
export interface ProofRoot {
  start(input: unknown): Promise<ProofHost>;
}
export class ProviderIdentityFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'cordis-provider-proof-')));
  readonly file = join(this.directory, 'identity.json');
  readonly keys = generateKeyPairSync('ed25519');
  readonly jwk = this.keys.privateKey.export({ format: 'jwk' });
  readonly fingerprint =
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify({ crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x }))
      .digest('base64url');
  readonly configuration = {
    keyFile: this.file,
    fingerprint: this.fingerprint,
    identityVersion: 7,
    audience: 'https://control-plane.fixture.invalid',
  };
  readonly request = {
    method: 'POST',
    path: '/v1/provider/access-tokens',
    body: { credentialId: 'credential:fixture', idempotencyKey: 'fixture-request' },
  };
  constructor() {
    chmodSync(this.directory, 0o700);
    writeFileSync(this.file, JSON.stringify(this.jwk), { mode: 0o600 });
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class ProviderProofProgram {
  async run(): Promise<void> {
    const fixture = new ProviderIdentityFixture();
    let host: ProofHost | undefined;
    try {
      const Root = Reflect.get(Agent, 'ProviderProofApplication') as ProofRoot;
      assert(Root && typeof Root.start === 'function', 'default enrollment proof root missing');
      host = await Root.start(fixture.configuration);
      await this.exercise(host, fixture);
    } finally {
      await host?.close();
      fixture.close();
    }
  }
  private async exercise(host: ProofHost, fixture: ProviderIdentityFixture): Promise<void> {
    const bytes = readFileSync(fixture.file);
    const proof = await host.sign(fixture.request, new AbortController().signal);
    this.verify(proof, fixture.keys.publicKey, fixture.fingerprint);
    assert.deepEqual(readFileSync(fixture.file), bytes);
    await host.close();
    await assert.rejects(
      host.sign(fixture.request, new AbortController().signal),
      /PROVIDER_PROOF_INVALID/,
    );
    process.stdout.write('native-provider-proof-ok\n');
  }
  private verify(proof: ProviderSignedProof, key: KeyObject, fingerprint: string): void {
    ProviderControlSchemas.proof.parse(proof);
    const input = Buffer.from(proof.protected + '.' + proof.payload);
    assert(verify(null, input, key, Buffer.from(proof.signature, 'base64url')));
    assert.deepEqual(JSON.parse(Buffer.from(proof.protected, 'base64url').toString()), {
      alg: 'EdDSA',
      typ: 'JOSE',
    });
    this.claims(JSON.parse(Buffer.from(proof.payload, 'base64url').toString()), fingerprint);
    assert(!JSON.stringify(proof).includes('credential:fixture'));
  }
  private claims(payload: Record<string, string>, fingerprint: string): void {
    assert.equal(payload.providerFingerprint, fingerprint);
    assert.equal(payload.identityVersion, 7);
    assert.equal(payload.audience, 'https://control-plane.fixture.invalid');
    assert.equal(payload.path, '/v1/provider/access-tokens');
    assert.equal(payload.method, 'POST');
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.algorithm, 'Ed25519');
    assert.equal(
      payload.bodySha256,
      createHash('sha256')
        .update('{"credentialId":"credential:fixture","idempotencyKey":"fixture-request"}')
        .digest('base64url'),
    );
    this.freshness(payload);
  }
  private freshness(payload: Record<string, string>): void {
    assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), 60000);
    assert(Math.abs(Date.now() - Date.parse(payload.issuedAt) - 1000) < 5000);
    assert.match(payload.jti, /^[0-9a-f-]{36}$/);
  }
}
if (import.meta.main) await new ProviderProofProgram().run();
