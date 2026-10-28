import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

class ActivityPreparationProgramAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/activity-preparation-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('native-activity-preparation-fixture-ok\n');
  }
}
const suite = new ActivityPreparationProgramAcceptance();
test(
  'acceptance: built native activity preparation validates external profiles without dispatch',
  suite.run.bind(suite),
);
