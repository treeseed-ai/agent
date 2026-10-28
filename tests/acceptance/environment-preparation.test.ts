import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

class EnvironmentPreparationAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/environment-preparation-program.js'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('native-environment-preparation-fixture-ok\n');
  }
}
const suite = new EnvironmentPreparationAcceptance();
test('acceptance: built native environment preparation requires setup and verification through selected providers', suite.run.bind(suite));
