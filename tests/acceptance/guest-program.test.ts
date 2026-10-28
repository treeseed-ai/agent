import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
class GuestProgramTests {
  normal(): void {
    this.run('--normal');
  }
  denied(): void {
    this.run('--deny');
  }
  malformed(): void {
    this.run('--malformed');
  }
  foreign(): void {
    this.run('--foreign');
  }
  ungranted(): void {
    this.run('--ungranted');
  }
  cancelled(): void {
    this.run('--cancel');
  }
  private run(mode: string): void {
    const result = spawnSync('node', ['dist/tests/support/guest-program.js', mode], {
      encoding: 'utf8',
      timeout: 12000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'guest-program-ok\n');
  }
}
const suite = new GuestProgramTests();
test(
  'acceptance: separate built guest composes a warm root and executes one exact harmless assignment',
  suite.normal.bind(suite),
  15000,
);
test(
  'acceptance: separate built guest rejects missing foreign and ungranted assignments',
  suite.denied.bind(suite),
  15000,
);
test(
  'acceptance: separate built guest rejects duplicate-key input without leaking bytes',
  suite.malformed.bind(suite),
  15000,
);

test(
  'acceptance: separate built guest compares the entire dispatch to trusted custody',
  suite.foreign.bind(suite),
  15000,
);
test(
  'acceptance: separate built guest denies a trusted assignment without probe authority',
  suite.ungranted.bind(suite),
  15000,
);
test(
  'acceptance: separate built guest cancellation fences an in-progress admission',
  suite.cancelled.bind(suite),
  15000,
);
