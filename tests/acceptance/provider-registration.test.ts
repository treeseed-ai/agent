import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ProviderRegistrationFixture } from '../support/provider-registration-program.js';
class ProviderRegistrationAcceptance {
  async status(): Promise<void> {
    const fixture = new ProviderRegistrationFixture();
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'connection-status-ok\n');
      assert.deepEqual(fixture.evidence(), { accepted: 1, rejected: 0, failure: null });
    } finally {
      await fixture.close();
    }
  }
  async foreign(): Promise<void> {
    const fixture = new ProviderRegistrationFixture('foreign');
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'foreign-identity-refused\n');
      assert.deepEqual(fixture.evidence(), { accepted: 1, rejected: 0, failure: null });
    } finally {
      await fixture.close();
    }
  }
  async alternative(): Promise<void> {
    const fixture = new ProviderRegistrationFixture('alternative');
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'foreign-identity-refused\n');
      assert.deepEqual(fixture.evidence(), { accepted: 0, rejected: 0, failure: null });
    } finally {
      await fixture.close();
    }
  }
}
const suite = new ProviderRegistrationAcceptance();
test(
  'acceptance: built default native registration connection proves the exact signed status body over real TLS',
  suite.status.bind(suite),
  20000,
);
test(
  'acceptance: built native registration connection rejects a foreign team despite valid TLS and SDK response schema',
  suite.foreign.bind(suite),
  20000,
);

test(
  'acceptance: selected native connection providers cannot bypass coherent enrollment identity checks',
  suite.alternative.bind(suite),
  20000,
);
