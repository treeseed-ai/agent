import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class CapacityAssignmentAcceptance {
  read(): void {
    this.program('read');
  }
  deny(): void {
    this.program('deny');
  }
  private program(mode: string): void {
    const result = spawnSync(
      'node',
      ['dist/tests/support/capacity-assignment-program.js', '--' + mode],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'capacity-assignment-' + mode + '-ok\n');
  }
}
const suite = new CapacityAssignmentAcceptance();
test(
  'acceptance: built native capacity assignment reader preserves fresh trusted dispatch identity',
  suite.read.bind(suite),
);
test(
  'acceptance: built native capacity assignment reader rejects foreign expired and unsafe custody',
  suite.deny.bind(suite),
);
