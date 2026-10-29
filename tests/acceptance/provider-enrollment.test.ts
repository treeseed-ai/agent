import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ProviderEnrollmentFixture } from '../support/provider-enrollment-fixture.js';
class ProviderEnrollmentAcceptance {
  async run(mode: string): Promise<void> {
    const fixture = new ProviderEnrollmentFixture(mode);
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'enrollment-' + mode + '-ok\n');
      assert.equal(fixture.rejected, 0);
      assert.equal(
        fixture.accepted,
        mode === 'repeat' ? 2 : ['submit', 'foreign', 'offer'].includes(mode) ? 1 : 0,
      );
    } finally {
      await fixture.close();
    }
  }
}
const suite = new ProviderEnrollmentAcceptance();
for (const mode of [
  'submit',
  'repeat',
  'foreign',
  'offer',
  'alternative',
  'identity',
  'audience',
  'permissions',
  'symlink',
  'cancelled',
  'closed',
  'invalid',
])
  test(
    'acceptance: built native enrollment preserves existing receiver authority for ' + mode,
    suite.run.bind(suite, mode),
    20000,
  );
