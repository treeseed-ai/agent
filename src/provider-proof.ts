import { z } from 'zod';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import {
  ProviderControlSchemas,
  type ProviderSignedProof,
} from '@treeseed-cordis/sdk/provider-control';
import { CapabilityToken, ProviderV4Schemas } from '@treeseed-cordis/sdk';
import { Context, CordisScope, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { AgentPrivateFile } from './authority.js';
import { AgentPackageIdentity } from './package-identity.js';
export interface ProviderProofSigner {
  sign(input: unknown, signal: AbortSignal): Promise<ProviderSignedProof>;
}
class ProofFailure extends Error {
  constructor() {
    super('PROVIDER_PROOF_INVALID');
  }
  static require(value: unknown): asserts value {
    if (!value) throw new ProofFailure();
  }
}
/** Legacy wire canonicalization; it is not the SDK plan digest algorithm. */
class ProofJson {
  private count = 0;
  private bytes = 0;
  private readonly seen = new WeakSet<object>();
  encode(input: unknown): string {
    const output = JSON.stringify(this.value(input, 0));
    ProofFailure.require(Buffer.byteLength(output) <= 65536);
    return output;
  }
  private value(input: unknown, depth: number): unknown {
    ProofFailure.require(depth <= 32 && ++this.count <= 65536);
    if (typeof input === 'string') this.charge(input);
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number') {
      ProofFailure.require(Number.isFinite(input));
      return input;
    }
    ProofFailure.require(input && typeof input === 'object' && !this.seen.has(input));
    this.seen.add(input);
    try {
      return Array.isArray(input) ? this.array(input, depth) : this.object(input, depth);
    } finally {
      this.seen.delete(input);
    }
  }
  private array(input: unknown[], depth: number): unknown[] {
    const result: unknown[] = [];
    for (let index = 0; index < input.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      ProofFailure.require(entry && 'value' in entry);
      result.push(this.value(entry.value, depth + 1));
    }
    return result;
  }
  private object(input: object, depth: number): object {
    const prototype = Object.getPrototypeOf(input);
    ProofFailure.require(prototype === Object.prototype || prototype === null);
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(input).sort(ProofJson.compare)) {
      this.charge(key);
      const entry = Object.getOwnPropertyDescriptor(input, key);
      ProofFailure.require(entry && 'value' in entry);
      entries.push([key, this.value(entry.value, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  private charge(value: string): void {
    this.bytes += Buffer.byteLength(value);
    ProofFailure.require(this.bytes <= 65536);
  }
  private static compare(left: string, right: string): number {
    return left.localeCompare(right);
  }
}
class ProofContract {
  static readonly configuration = z.strictObject({
    keyFile: z.string().min(1),
    fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    identityVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    audience: z.url(),
  });
  static readonly request = z.strictObject({
    method: z.enum(['GET', 'POST']),
    path: z.string().max(256),
    body: z.unknown(),
  });
  static readonly privateJwk = ProviderControlSchemas.publicJwk.extend({
    d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  });
  static origin(value: string): string {
    const url = new URL(value);
    ProofFailure.require(url.protocol === 'https:' && url.origin === value);
    return value;
  }
  static path(method: string, path: string): void {
    if (method === 'GET') {
      ProofFailure.require(
        /^\/v1\/provider-registrations\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(path),
      );
      return;
    }
    ProofFailure.require(
      path === '/v1/provider-registrations' ||
        path === '/v1/provider/access-tokens' ||
        /^\/v1\/provider-registrations\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}\/credential$/.test(path),
    );
  }
  static digest(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
  }
}
class ProofAdapter {
  parse(input: unknown): ProviderProofSigner {
    ProofFailure.require(
      input && typeof input === 'object' && typeof Reflect.get(input, 'sign') === 'function',
    );
    return input as ProviderProofSigner;
  }
}
export const ProviderProofToken = new CapabilityToken<ProviderProofSigner>(
  'agent.provider.proof',
  ProviderV4Schemas.version,
  new ProofAdapter(),
);
export class ProviderFileProofPlugin implements ProviderProofSigner {
  static readonly provide = ['agent.provider.proof'];
  static readonly inject: string[] = [];
  static readonly Config = ProofContract.configuration;
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.provider.proof.private-file',
    pluginId: 'agent',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(
    context: Context,
    private readonly configuration: z.infer<typeof ProofContract.configuration>,
  ) {
    context.provide(ProviderProofToken.id, this);
  }
  async sign(input: unknown, signal: AbortSignal): Promise<ProviderSignedProof> {
    try {
      ProofFailure.require(!signal.aborted);
      const request = ProofContract.request.parse(input);
      ProofContract.path(request.method, request.path);
      const body = new ProofJson().encode(request.body);
      const jwk = ProofContract.privateJwk.parse(AgentPrivateFile.read(this.configuration.keyFile));
      const fingerprint = this.fingerprint(jwk);
      ProofFailure.require(fingerprint === this.configuration.fingerprint);
      const payload = this.payload(request, body, fingerprint);
      const result = this.signature(payload, jwk);
      ProofFailure.require(!signal.aborted);
      return result;
    } catch {
      throw new ProofFailure();
    }
  }
  private fingerprint(jwk: JsonWebKey): string {
    return (
      'sha256:' +
      ProofContract.digest(new ProofJson().encode({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    );
  }
  private payload(
    request: { method: string; path: string },
    body: string,
    fingerprint: string,
  ): string {
    const now = Date.now();
    return Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        algorithm: 'Ed25519',
        providerFingerprint: fingerprint,
        identityVersion: this.configuration.identityVersion,
        method: request.method,
        path: request.path,
        bodySha256: ProofContract.digest(body),
        audience: ProofContract.origin(this.configuration.audience),
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 59000).toISOString(),
        jti: randomUUID(),
      }),
    ).toString('base64url');
  }
  private signature(payload: string, jwk: JsonWebKey): ProviderSignedProof {
    const protectedValue = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JOSE' })).toString(
      'base64url',
    );
    const bytes = Buffer.from(protectedValue + '.' + payload);
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    const signature = sign(null, bytes, key);
    const publicKey = createPublicKey({
      key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      format: 'jwk',
    });
    ProofFailure.require(verify(null, bytes, publicKey, signature));
    return ProviderControlSchemas.proof.parse({
      protected: protectedValue,
      payload,
      signature: signature.toString('base64url'),
    });
  }
}
export class ProviderProofApplication implements ProviderProofSigner {
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(private readonly scope: CordisScope) {}
  static async start(
    input: unknown,
    overrides: readonly ProviderRegistration[] = [],
  ): Promise<ProviderProofApplication> {
    try {
      const configuration = ProofContract.configuration.parse(input);
      ProofContract.origin(configuration.audience);
      const registrations = this.registrations(configuration, overrides);
      return new ProviderProofApplication(await this.mount(configuration, registrations));
    } catch {
      throw new ProofFailure();
    }
  }
  private static mount(
    configuration: z.infer<typeof ProofContract.configuration>,
    registrations: ProviderRegistration[],
  ): Promise<CordisScope> {
    const selection = {
      scopeId: configuration.fingerprint,
      capability: ProviderProofToken.id,
      providerId: ProviderV4Schemas.declaration.parse(registrations[0]!.declaration).id,
    };
    const policy = {
      scopeId: configuration.fingerprint,
      target: 'agent' as const,
      principalId: configuration.fingerprint,
      resourceScope: 'provider-enrollment',
    };
    return CordisScope.start({ registrations, selections: [selection] }, policy);
  }
  private static registrations(
    configuration: z.infer<typeof ProofContract.configuration>,
    overrides: readonly ProviderRegistration[],
  ): ProviderRegistration[] {
    ProofFailure.require(overrides.length <= 1);
    if (overrides.length) {
      ProofFailure.require(overrides[0]!.token.id === ProviderProofToken.id);
      return [...overrides];
    }
    return [
      {
        token: ProviderProofToken,
        plugin: ProviderFileProofPlugin,
        declaration: ProviderFileProofPlugin.declaration,
        configuration,
        artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
      },
    ];
  }
  async sign(input: unknown, signal: AbortSignal): Promise<ProviderSignedProof> {
    try {
      ProofFailure.require(!this.closed && !signal.aborted);
      return await this.invoke(input, signal);
    } catch {
      throw new ProofFailure();
    }
  }
  private async invoke(input: unknown, signal: AbortSignal): Promise<ProviderSignedProof> {
    const lease = await this.scope.acquire(ProviderProofToken);
    try {
      const result = ProviderControlSchemas.proof.parse(await lease.value.sign(input, signal));
      ProofFailure.require(!this.closed && !signal.aborted);
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
