import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class WorkerContractAcceptance {
  portable(): void {
    const result = spawnSync('node', ['dist/tests/support/worker-contract-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'agent-worker-contract-ok\n');
  }
}
const suite = new WorkerContractAcceptance();
test(
  'acceptance: built Agent consumer validates the portable private worker contract',
  suite.portable.bind(suite),
);
