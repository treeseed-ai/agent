import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, verify } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ProviderIdentityFixture } from './provider-proof-program.js';
import { ProviderRegistrationFixture } from './provider-registration-program.js';

/** Independent isolated control-plane receiver; no team creation or production authority. */
export class ProviderEnrollmentFixture extends ProviderIdentityFixture {
  private server: Server | null = null;
  private readonly nonces = new Set<string>();
  readonly inputFile = join(this.directory, 'enrollment.json');
  readonly registrationKeyFile = join(this.directory, 'registration-code.json');
  private result: object | null = null;
  accepted = 0;
  rejected = 0;
  constructor(readonly mode: string) {
    super();
  }
  static readonly input = {
    idempotencyKey: 'fixture-enrollment',
    displayName: 'Harmless fixture capacity',
    capabilitySummary: ['agent.probe'],
    supplyOffer: { maxConcurrentRunners: 1, capabilities: ['agent.probe'] },
  };
  async start(): Promise<void> {
    this.certificate();
    this.server = createServer(
      {
        key: readFileSync(join(this.directory, 'tls-key.pem')),
        cert: readFileSync(join(this.directory, 'cert.pem')),
      },
      this.receive.bind(this),
    );
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    writeFileSync(this.inputFile, JSON.stringify(this.connection()), { mode: 0o600 });
    writeFileSync(
      this.registrationKeyFile,
      JSON.stringify({ registrationKey: 'REGISTRATION_CODE_CANARY' }),
      { mode: 0o600 },
    );
  }
  private static readonly certificateArguments = [
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
  ];
  private certificate(): void {
    const result = spawnSync(
      'openssl',
      [
        ...ProviderEnrollmentFixture.certificateArguments,
        '-keyout',
        join(this.directory, 'tls-key.pem'),
        '-out',
        join(this.directory, 'cert.pem'),
      ],
      { stdio: 'ignore', timeout: 10000 },
    );
    assert.equal(result.status, 0, 'isolated TLS fixture requires openssl');
    chmodSync(join(this.directory, 'tls-key.pem'), 0o600);
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
      registrationKeyFile: this.registrationKeyFile,
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: this.jwk.x, alg: 'EdDSA' },
    };
  }
  private receive(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', this.chunk.bind(this, request, chunks));
    request.on('end', this.respond.bind(this, request, response, chunks));
  }
  private chunk(request: IncomingMessage, chunks: Buffer[], value: Buffer): void {
    chunks.push(value);
    if (Buffer.concat(chunks).length > 65536) request.destroy();
  }
  private respond(request: IncomingMessage, response: ServerResponse, chunks: Buffer[]): void {
    response.setHeader('content-type', 'application/json');
    try {
      this.validate(request, JSON.parse(Buffer.concat(chunks).toString()));
      this.accepted++;
      response.end(JSON.stringify({ data: this.registration() }));
    } catch {
      this.rejected++;
      response.writeHead(401);
      response.end(JSON.stringify({ secret: 'PRIVATE_RECEIVER_CANARY' }));
    }
  }
  private validate(request: IncomingMessage, body: Record<string, unknown>): void {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/provider-registrations');
    assert.equal(request.headers.authorization, 'Treeseed-Registration REGISTRATION_CODE_CANARY');
    assert.equal(request.headers['idempotency-key'], 'fixture-enrollment');
    const { proof, ...unsigned } = body;
    const expected = { ...ProviderEnrollmentFixture.input } as Record<string, unknown>;
    delete expected.idempotencyKey;
    assert.deepEqual(unsigned, {
      schemaVersion: 1,
      ...expected,
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: this.jwk.x, alg: 'EdDSA' },
    });
    this.proof(proof as { protected: string; payload: string; signature: string }, unsigned);
  }
  private proof(
    proof: { protected: string; payload: string; signature: string },
    body: object,
  ): void {
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
    this.claims(JSON.parse(Buffer.from(proof.payload, 'base64url').toString()), body);
  }
  private claims(claims: Record<string, unknown>, body: object): void {
    const expected = {
      bodySha256: this.digest(body),
      schemaVersion: 1,
      algorithm: 'Ed25519',
      providerFingerprint: this.fingerprint,
      identityVersion: 7,
      audience: this.origin(),
      method: 'POST',
      path: '/v1/provider-registrations',
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(claims[key], value);
    this.fresh(claims);
  }
  private digest(body: object): string {
    return createHash('sha256')
      .update(JSON.stringify(this.canonical(body)))
      .digest('base64url');
  }
  private canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(this.canonical.bind(this));
    if (!input || typeof input !== 'object') return input;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort())
      result[key] = this.canonical(Reflect.get(input, key));
    return result;
  }
  private fresh(claims: Record<string, unknown>): void {
    const issued = Date.parse(String(claims.issuedAt)),
      expires = Date.parse(String(claims.expiresAt));
    assert.equal(expires - issued, 60000);
    assert(issued <= Date.now() && expires > Date.now());
    assert.match(String(claims.jti), /^[0-9a-f-]{36}$/);
    assert(!this.nonces.has(String(claims.jti)));
    this.nonces.add(String(claims.jti));
  }
  private registration(): object {
    if (this.result) return this.result;
    this.result = {
      ...ProviderRegistrationFixture.response(this.fingerprint, this.mode),
      capabilitySummary: ProviderEnrollmentFixture.input.capabilitySummary,
      supplyOffer:
        this.mode === 'offer'
          ? { capabilities: ['productive.work'] }
          : ProviderEnrollmentFixture.input.supplyOffer,
    };
    return this.result;
  }
  async program(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(
      'node',
      [resolve('dist/tests/support/provider-enrollment-program.js'), this.inputFile, this.mode],
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
  override async close(): Promise<void> {
    if (this.server?.listening) {
      const closed = once(this.server, 'close');
      this.server.closeAllConnections();
      this.server.close();
      await closed;
    }
    super.close();
  }
}
