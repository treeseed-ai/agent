import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class ProviderProofAcceptance {
  native(): void {
    const result = spawnSync('node', ['dist/tests/support/provider-proof-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'native-provider-proof-ok\n');
  }
}
const suite = new ProviderProofAcceptance();
test(
  'acceptance: built public native enrollment proof root signs the exact legacy protocol without modifying private identity',
  suite.native.bind(suite),
);
