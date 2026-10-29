import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ProviderRegistrationFixture } from '../support/provider-registration-program.js';
class ProviderRegistrationRegression {
  async empty(): Promise<void> {
    const fixture = new ProviderRegistrationFixture('empty');
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'empty-proof-refused\n');
      assert(!result.stdout.includes('CANARY'));
      assert.deepEqual(fixture.evidence(), { accepted: 0, rejected: 1, failure: 'fixture-body' });
    } finally {
      await fixture.close();
    }
  }
}
const suite = new ProviderRegistrationRegression();
test(
  'regression: existing registration-status receiver rejects the formerly documented empty GET proof body without leaking denial text',
  suite.empty.bind(suite),
  20000,
);
