import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ProviderTokenFixture } from '../support/provider-token-fixture.js';
class ProviderTokenAcceptance {
  async run(mode: string): Promise<void> {
    const fixture = new ProviderTokenFixture(mode);
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(
        result.stdout,
        mode === 'accepted' ? 'provider-token-ok\n' : 'provider-token-refused\n',
      );
      assert(!JSON.stringify(result).includes('PRIVATE_CREDENTIAL_CANARY'));
      assert(!JSON.stringify(result).includes('PRIVATE_TOKEN_CANARY'));
      fixture.verify();
    } finally {
      await fixture.close();
    }
  }
}
const suite = new ProviderTokenAcceptance();
test(
  'acceptance: built native token root exchanges exact approved credentials over HTTPS with stable idempotency',
  suite.run.bind(suite, 'accepted'),
  20000,
);
for (const mode of [
  'pending',
  'foreign-registration',
  'foreign-member',
  'revoked',
  'expired',
  'denied',
  'token-malformed',
  'token-member',
  'token-team',
  'token-provider',
  'token-credential',
  'token-revoked',
  'token-scopes',
  'token-duplicate',
  'token-expired',
  'token-version',
  'alternative',
  'cancel',
  'invalid',
])
  test(
    'acceptance: built token root refuses ' + mode + ' without secret output',
    suite.run.bind(suite, mode),
    20000,
  );
