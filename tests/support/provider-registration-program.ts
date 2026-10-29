import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, verify } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as Agent from '@treeseed-cordis/agent';
import {
  ProviderProtocolClient,
  ProviderControlError,
  type ProviderRegistration,
} from '@treeseed-cordis/sdk/provider-control';
import { ProviderIdentityFixture } from './provider-proof-program.js';
interface ConnectionHost {
  status(id: string, signal: AbortSignal): Promise<ProviderRegistration>;
  close(): Promise<void>;
}
interface ConnectionRoot {
  start(input: unknown): Promise<ConnectionHost>;
}
/** Isolated legacy receiver contract, not a live team approval authority. */
export class ProviderRegistrationFixture extends ProviderIdentityFixture {
  private server: Server | null = null;
  private failure: string | null = null;
  private accepted = 0;
  private rejected = 0;
  private readonly nonces = new Set<string>();
  readonly inputFile = join(this.directory, 'connection.json');
  constructor(private readonly mode = 'status') {
    super();
  }
  async start(): Promise<void> {
    this.certificate();
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
  private certificate(): void {
    const args = [
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
    const result = spawnSync('openssl', args, { stdio: 'ignore', timeout: 10000 });
    if (result.status !== 0) throw new Error('isolated TLS fixture requires openssl');
    chmodSync(join(this.directory, 'key.pem'), 0o600);
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
    };
  }
  private receive(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('content-type', 'application/json');
    try {
      this.validate(request);
      this.accepted++;
      response.end(JSON.stringify({ data: this.registration() }));
    } catch (error) {
      this.rejected++;
      this.failure = error instanceof Error ? error.message : 'fixture-unknown';
      response.writeHead(401);
      response.end(JSON.stringify({ secret: 'PRIVATE_RECEIVER_CANARY' }));
    }
  }
  private validate(request: IncomingMessage): void {
    if (request.method !== 'GET' || request.url !== '/v1/provider-registrations/fixture-request')
      throw new Error('fixture-endpoint');
    const encoded = request.headers['x-treeseed-provider-proof'];
    if (typeof encoded !== 'string') throw new Error('fixture-proof');
    const proof = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const signature = Buffer.from(proof.signature, 'base64url');
    if (
      !verify(
        null,
        Buffer.from(proof.protected + '.' + proof.payload),
        this.keys.publicKey,
        signature,
      )
    )
      throw new Error('fixture-signature');
    const header = JSON.parse(Buffer.from(proof.protected, 'base64url').toString());
    if (header.alg !== 'EdDSA' || header.typ !== 'JOSE') throw new Error('fixture-header');
    this.claims(JSON.parse(Buffer.from(proof.payload, 'base64url').toString()));
  }
  private claims(payload: Record<string, unknown>): void {
    const digest = createHash('sha256')
      .update('{"requestId":"fixture-request"}')
      .digest('base64url');
    if (payload.bodySha256 !== digest) throw new Error('fixture-body');
    if (
      payload.schemaVersion !== 1 ||
      payload.algorithm !== 'Ed25519' ||
      payload.identityVersion !== 7
    )
      throw new Error('fixture-version');
    if (payload.providerFingerprint !== this.fingerprint || payload.audience !== this.origin())
      throw new Error('fixture-identity');
    if (payload.method !== 'GET' || payload.path !== '/v1/provider-registrations/fixture-request')
      throw new Error('fixture-binding');
    this.fresh(payload);
  }
  private fresh(payload: Record<string, unknown>): void {
    const issued = Date.parse(String(payload.issuedAt));
    const expires = Date.parse(String(payload.expiresAt));
    if (expires - issued !== 60000 || issued > Date.now() || expires <= Date.now())
      throw new Error('fixture-time');
    if (
      typeof payload.jti !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(payload.jti) ||
      this.nonces.has(payload.jti)
    )
      throw new Error('fixture-nonce');
    this.nonces.add(payload.jti);
  }
  private registration(): object {
    const now = new Date().toISOString();
    return {
      id: 'fixture-request',
      teamId: this.mode === 'foreign' ? 'foreign-team' : 'fixture-team',
      providerId: 'fixture-provider',
      providerFingerprint: this.fingerprint,
      registrationKeyGeneration: 3,
      status: 'pending',
      capabilitySummary: ['fixture.probe'],
      supplyOffer: { capabilities: ['fixture.probe'] },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
  }
  evidence(): { accepted: number; rejected: number; failure: string | null } {
    return { accepted: this.accepted, rejected: this.rejected, failure: this.failure };
  }
  async program(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(
      'node',
      [resolve('dist/tests/support/provider-registration-program.js'), this.inputFile, this.mode],
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
class ProviderRegistrationProgram {
  private readonly configuration = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
  async run(): Promise<void> {
    if (process.argv[3] === 'empty') return this.empty();
    const Root = Reflect.get(Agent, 'ProviderConnectionApplication') as ConnectionRoot;
    assert(Root && typeof Root.start === 'function', 'native registration connection missing');
    const host = await Root.start(this.configuration);
    try {
      if (process.argv[3] === 'foreign') return await this.foreign(host);
      const registration = await host.status('fixture-request', new AbortController().signal);
      assert.equal(registration.teamId, 'fixture-team');
      assert.equal(registration.status, 'pending');
      process.stdout.write('connection-status-ok\n');
    } finally {
      await host.close();
    }
  }
  private async foreign(host: ConnectionHost): Promise<void> {
    await assert.rejects(host.status('fixture-request', new AbortController().signal), {
      message: 'PROVIDER_IDENTITY_MISMATCH',
    });
    process.stdout.write('foreign-identity-refused\n');
  }
  private async empty(): Promise<void> {
    const host = await Agent.ProviderProofApplication.start(this.configuration.proof);
    try {
      const proof = await host.sign(
        { method: 'GET', path: '/v1/provider-registrations/fixture-request', body: {} },
        new AbortController().signal,
      );
      const client = new ProviderProtocolClient({ baseUrl: this.configuration.controlPlaneUrl });
      await assert.rejects(
        client.registration('fixture-request', proof, new AbortController().signal),
        {
          message: 'PROVIDER_REQUEST_REJECTED',
          status: 401,
        },
      );
      process.stdout.write('empty-proof-refused\n');
    } finally {
      await host.close();
    }
  }
}
if (import.meta.main) await new ProviderRegistrationProgram().run();
