import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProviderCredentialFixture } from './provider-credential-fixture.js';
/** Existing endpoint/proof contract fixture, never live enrollment or Keycloak evidence. */
export class ProviderTokenFixture extends ProviderCredentialFixture {
  protected override readonly programFile = 'dist/tests/support/provider-token-program.js';
  private tokens = 0;
  protected override async respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url !== '/v1/provider/access-tokens') return super.respond(request, response);
    response.setHeader('content-type', 'application/json');
    const input = JSON.parse(await this.body(request));
    this.tokenRequest(request, input);
    this.tokens++;
    this.tokenResponse(response);
  }
  private tokenRequest(request: IncomingMessage, input: Record<string, unknown>): void {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Treeseed-Credential PRIVATE_CREDENTIAL_CANARY');
    assert.equal(request.headers['idempotency-key'], 'fixture-token-issue');
    assert.deepEqual(Object.keys(input).sort(), [
      'credentialId',
      'proof',
      'requestedValiditySeconds',
    ]);
    assert.equal(input.credentialId, 'fixture-credential');
    assert.equal(input.requestedValiditySeconds, 60);
    this.proof(
      input.proof as { protected: string; payload: string; signature: string },
      request,
      '{"credentialId":"fixture-credential","idempotencyKey":"fixture-token-issue","requestedValiditySeconds":60}',
    );
  }
  private tokenResponse(response: ServerResponse): void {
    if (this.mode === 'denied') {
      response.writeHead(403);
      response.end('{}');
      return;
    }
    response.end(
      JSON.stringify({
        data:
          this.mode === 'token-malformed'
            ? { accessToken: 'PRIVATE_TOKEN_CANARY' }
            : ProviderTokenFixture.issueToken(this.mode),
      }),
    );
  }
  static issueToken(mode: string): object {
    const issuedAt = new Date(Date.now() - 1000).toISOString();
    return {
      id: 'fixture-token',
      membershipId: mode === 'token-member' ? 'foreign-member' : 'fixture-membership',
      teamId: mode === 'token-team' || mode === 'alternative' ? 'foreign-team' : 'fixture-team',
      providerId: mode === 'token-provider' ? 'foreign-provider' : 'fixture-provider',
      credentialId: mode === 'token-credential' ? 'foreign-credential' : 'fixture-credential',
      status: mode === 'token-revoked' ? 'revoked' : 'active',
      scopes:
        mode === 'token-scopes'
          ? ['provider:usage:write']
          : mode === 'token-duplicate'
            ? ['provider:availability:write', 'provider:availability:write']
            : ['provider:availability:write'],
      issuedAt,
      expiresAt: new Date(Date.now() + (mode === 'token-expired' ? -500 : 59000)).toISOString(),
      accessToken: 'PRIVATE_TOKEN_CANARY',
      identityVersion: mode === 'token-version' ? 8 : 7,
    };
  }
  override verify(): void {
    assert.equal(this.failure, null);
    if (this.mode === 'accepted') {
      assert.equal(this.tokens, 2);
      assert.equal(this.posts, 4);
      assert.equal(this.gets, 8);
    } else if (['pending', 'foreign-registration', 'cancel', 'invalid'].includes(this.mode)) {
      assert.equal(this.tokens, 0);
      assert.equal(this.posts, 0);
    } else if (['revoked', 'expired', 'foreign-member'].includes(this.mode)) {
      assert.equal(this.tokens, 0);
      assert.equal(this.posts, 1);
    } else if (this.mode === 'alternative') assert.equal(this.tokens, 0);
    else assert.equal(this.tokens, 1);
  }
}
