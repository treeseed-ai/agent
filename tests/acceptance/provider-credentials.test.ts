import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ProviderCredentialFixture } from '../support/provider-credential-fixture.js';
class CredentialProgramAcceptance {
  async run(mode: string): Promise<void> {
    const fixture = new ProviderCredentialFixture(mode);
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(
        result.stdout,
        mode === 'accepted' ? 'provider-credential-ok\n' : 'provider-credential-refused\n',
      );
      assert(!JSON.stringify(result).includes('PRIVATE_CREDENTIAL_CANARY'));
      fixture.verify();
    } finally {
      await fixture.close();
    }
  }
}
const suite = new CredentialProgramAcceptance();
test(
  'acceptance: built native credential exchange verifies exact HTTPS proofs approval and stable idempotent identity',
  suite.run.bind(suite, 'accepted'),
  20000,
);
for (const mode of [
  'pending',
  'foreign-registration',
  'foreign-member',
  'revoked',
  'expired',
  'malformed',
  'alternative',
  'cancel',
])
  test(
    'acceptance: built credential exchange safely rejects ' + mode,
    suite.run.bind(suite, mode),
    20000,
  );
