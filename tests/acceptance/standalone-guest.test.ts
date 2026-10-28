import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class StandaloneGuestAcceptance {
  programs(): void {
    for (const mode of [
      '--normal',
      '--deny',
      '--foreign',
      '--ungranted',
      '--malformed',
      '--cancel',
    ]) {
      const result = spawnSync(
        'node',
        ['dist/tests/support/guest-program.js', mode, '--standalone'],
        { encoding: 'utf8', timeout: 12000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'guest-program-ok\n');
    }
  }
}
const suite = new StandaloneGuestAcceptance();
test(
  'acceptance: source-free standalone guest passes the full program contract with no developer tools or ambient preload',
  suite.programs.bind(suite),
  80000,
);
