import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
class AgentAuthorityAcceptance {
  run(): void {
    const result = spawnSync('node', ['dist/tests/support/private-authority-program.js'], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('native-agent-authority-ok\n');
  }
}
const suite = new AgentAuthorityAcceptance();
test('acceptance: built public Agent authority uses native default construction and fresh revocation read-back', suite.run.bind(suite));
