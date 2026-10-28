import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
class WarmPoolProgramAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/warm-pool-program.js'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('warm-pool-policy-fixture-ok\n');
  }
}
const suite = new WarmPoolProgramAcceptance();
test(
  'acceptance: built worker pool policy claims once and verifies teardown with explicit fixtures',
  suite.run.bind(suite),
);
