import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

class ExternalActivityPackageAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/external-activity-package-program.js'], {
      encoding: 'utf8',
      timeout: 90000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('external-activity-archive-ok\n');
  }
}
const suite = new ExternalActivityPackageAcceptance();
test(
  'acceptance: genuine external activity package extends the public Agent without lifecycle scripts or core edits',
  suite.run.bind(suite),
  95000,
);
