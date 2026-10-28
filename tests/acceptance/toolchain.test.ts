import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

class AgentToolchainAcceptance {
  compiled(): void {
    expect(existsSync('dist/tests/support/toolchain-program.js')).toBe(true);
    expect(existsSync('dist/tests/support/toolchain-program.d.ts')).toBe(true);
    const result = spawnSync('node', ['dist/tests/support/toolchain-program.js'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('agent-toolchain-ok\n');
  }

  wired(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(metadata.scripts.check).toContain('bun scripts/tooling.ts check');
    expect(metadata.scripts.build).toBe('bun scripts/tooling.ts build && bun scripts/guest-build.ts');
  }
}
const suite = new AgentToolchainAcceptance();
test('acceptance: independent Agent build emits a genuine public Node and declaration consumer', suite.compiled.bind(suite));
test('acceptance: normal Agent owner checks wire semantic class and source-boundary enforcement', suite.wired.bind(suite));
