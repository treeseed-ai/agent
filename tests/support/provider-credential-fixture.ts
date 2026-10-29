import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { ProviderIdentityFixture } from './provider-proof-program.js';
import { ProviderRegistrationFixture } from './provider-registration-program.js';
/** Existing public protocol receiver only; no real team approval or Keycloak authority. */
export class ProviderCredentialFixture extends ProviderIdentityFixture {
  private server: Server | null = null;
  private failure: string | null = null;
  private readonly nonces = new Set<string>();
  private posts = 0;
  private gets = 0;
  readonly inputFile = join(this.directory, 'credential-request.json');
  private readonly certificateArgs = [
    'req',
    '-x509',
    '-newkey',
    'ed25519',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    join(this.directory, 'key.pem'),
    '-out',
    join(this.directory, 'cert.pem'),
  ];
  constructor(private readonly mode: string) {
    super();
  }
  async start(): Promise<void> {
    assert.equal(
      spawnSync('openssl', this.certificateArgs, { stdio: 'ignore', timeout: 10000 }).status,
      0,
    );
    chmodSync(join(this.directory, 'key.pem'), 0o600);
    this.server = createServer(
      {
        key: readFileSync(join(this.directory, 'key.pem')),
        cert: readFileSync(join(this.directory, 'cert.pem')),
      },
      this.receive.bind(this),
    );
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    writeFileSync(this.inputFile, JSON.stringify(this.connection()), { mode: 0o600 });
  }
  private origin(): string {
    return 'https://127.0.0.1:' + (this.server!.address() as { port: number }).port;
  }
  private connection(): object {
    return {
      proof: { ...this.configuration, audience: this.origin() },
      controlPlaneUrl: this.origin(),
      teamId: 'fixture-team',
      providerId: 'fixture-provider',
      registrationKeyGeneration: 3,
      registrationId: 'fixture-request',
      membershipId: 'fixture-membership',
    };
  }
  private receive(request: IncomingMessage, response: ServerResponse): void {
    void this.respond(request, response).catch(this.failed.bind(this, response));
  }
  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('content-type', 'application/json');
    const input = await this.body(request);
    if (request.method === 'GET') this.registrationResponse(request, response, input);
    else this.credentialResponse(request, response, input);
  }
  private registrationResponse(
    request: IncomingMessage,
    response: ServerResponse,
    input: string,
  ): void {
    assert.equal(request.url, '/v1/provider-registrations/fixture-request');
    assert.equal(input, '');
    const encoded = request.headers['x-treeseed-provider-proof'];
    assert.equal(typeof encoded, 'string');
    this.proof(
      JSON.parse(Buffer.from(encoded as string, 'base64url').toString()),
      request,
      '{"requestId":"fixture-request"}',
    );
    this.gets++;
    response.end(JSON.stringify({ data: this.registration() }));
  }
  private credentialResponse(
    request: IncomingMessage,
    response: ServerResponse,
    input: string,
  ): void {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/provider-registrations/fixture-request/credential');
    assert.equal(request.headers['idempotency-key'], 'fixture-issue');
    this.proof(
      JSON.parse(input).proof,
      request,
      '{"idempotencyKey":"fixture-issue","requestId":"fixture-request"}',
    );
    this.posts++;
    response.end(
      JSON.stringify({
        data:
          this.mode === 'malformed'
            ? { credential: 'PRIVATE_CREDENTIAL_CANARY' }
            : ProviderCredentialFixture.issue(this.mode),
      }),
    );
  }
  private async body(request: IncomingMessage): Promise<string> {
    const chunks = [];
    let size = 0;
    for await (const bytes of request) {
      size += bytes.length;
      assert(size <= 65536);
      chunks.push(Buffer.from(bytes));
    }
    return Buffer.concat(chunks).toString();
  }
  private proof(
    proof: { protected: string; payload: string; signature: string },
    request: IncomingMessage,
    body: string,
  ): void {
    const payload = this.signature(proof);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.algorithm, 'Ed25519');
    assert.equal(payload.identityVersion, 7);
    assert.equal(payload.providerFingerprint, this.fingerprint);
    assert.equal(payload.audience, this.origin());
    assert.equal(payload.method, request.method);
    assert.equal(payload.path, request.url);
    assert.equal(payload.bodySha256, createHash('sha256').update(body).digest('base64url'));
    this.fresh(payload);
  }
  private signature(proof: { protected: string; payload: string; signature: string }) {
    assert(
      verify(
        null,
        Buffer.from(proof.protected + '.' + proof.payload),
        this.keys.publicKey,
        Buffer.from(proof.signature, 'base64url'),
      ),
    );
    assert.deepEqual(JSON.parse(Buffer.from(proof.protected, 'base64url').toString()), {
      alg: 'EdDSA',
      typ: 'JOSE',
    });
    return JSON.parse(Buffer.from(proof.payload, 'base64url').toString());
  }
  private fresh(payload: { issuedAt: string; expiresAt: string; jti: string }): void {
    const issued = Date.parse(payload.issuedAt),
      expires = Date.parse(payload.expiresAt);
    assert.equal(expires - issued, 60000);
    assert(issued <= Date.now() && expires > Date.now());
    assert.match(payload.jti, /^[a-f0-9-]{36}$/);
    assert(!this.nonces.has(payload.jti));
    this.nonces.add(payload.jti);
  }
  private registration(): object {
    return {
      ...ProviderRegistrationFixture.response(
        this.fingerprint,
        this.mode === 'foreign-registration' ? 'foreign' : 'status',
      ),
      status: this.mode === 'pending' ? 'pending' : 'approved',
      membershipId: 'fixture-membership',
    };
  }
  static issue(mode: string): object {
    const now = new Date().toISOString();
    return {
      id: 'fixture-credential',
      membershipId: mode === 'foreign-member' ? 'foreign-membership' : 'fixture-membership',
      teamId: mode === 'alternative' ? 'foreign-team' : 'fixture-team',
      providerId: 'fixture-provider',
      keyPrefix: 'fixture',
      issuanceGeneration: 1,
      status: mode === 'revoked' ? 'revoked' : 'active',
      scopes: ['provider:availability:write'],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + (mode === 'expired' ? -1000 : 60000)).toISOString(),
      credential: 'PRIVATE_CREDENTIAL_CANARY',
    };
  }
  private failed(response: ServerResponse, error: unknown): void {
    this.failure = error instanceof Error ? error.message : 'fixture-error';
    response.writeHead(401);
    response.end(JSON.stringify({ private: 'PRIVATE_CREDENTIAL_CANARY' }));
  }
  verify(): void {
    assert.equal(this.failure, null);
    if (this.mode === 'accepted') {
      assert.equal(this.posts, 2);
      assert.equal(this.gets, 4);
    } else if (['pending', 'foreign-registration', 'alternative', 'cancel'].includes(this.mode))
      assert.equal(this.posts, 0);
    else assert.equal(this.posts, 1);
  }
  async program(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(
      'node',
      [resolve('dist/tests/support/provider-credential-program.js'), this.inputFile, this.mode],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(this.directory, 'cert.pem') },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', output.push.bind(output));
    child.stderr.on('data', errors.push.bind(errors));
    const [code] = await once(child, 'close');
    return {
      code,
      stdout: Buffer.concat(output).toString(),
      stderr: Buffer.concat(errors).toString(),
    };
  }
  async close(): Promise<void> {
    if (this.server?.listening) {
      const closed = once(this.server, 'close');
      this.server.closeAllConnections();
      this.server.close();
      await closed;
    }
    super.close();
  }
}
