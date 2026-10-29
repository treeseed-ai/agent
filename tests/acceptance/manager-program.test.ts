import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CapacityChannelSchemas } from '@treeseed-cordis/sdk';
import { ManagerProgramFixture } from '../support/manager-program-fixture.js';
class ManagerProgramAcceptance {
  async run(mode: string): Promise<void> {
    const fixture = new ManagerProgramFixture(mode);
    try {
      await fixture.start();
      const result = await fixture.program();
      this.output(result, mode);
      assert.deepEqual(fixture.evidence(), {
        accepted: ['root', 'foreign', 'ready', 'signal'].includes(mode) ? 1 : 0,
        rejected: 0,
        failure: null,
      });
    } finally {
      await fixture.close();
    }
  }
  private output(
    result: { code: number | null; stdout: string; stderr: string },
    mode: string,
  ): void {
    const invalid = ['permissions', 'malformed', 'oversize'].includes(mode);
    assert.equal(result.code, invalid ? 2 : 0, result.stderr);
    assert.equal(result.stderr, invalid ? 'INVALID_CAPACITY_CONTRACT\n' : '');
    if (invalid) return assert.equal(result.stdout, '');
    if (['root', 'foreign', 'composition'].includes(mode))
      return assert.equal(result.stdout, 'manager-library-' + mode + '-ok\n');
    const response = CapacityChannelSchemas.response.parse(JSON.parse(result.stdout));
    assert.equal(response.operation, 'ready');
    assert.match(response.generation.processGeneration, /^[a-f0-9]{64}$/);
    if (!['scope', 'role', 'generation'].includes(mode)) assert.equal(response.role, 'manager');
    this.readiness(response, mode);
  }
  private readiness(
    response: ReturnType<typeof CapacityChannelSchemas.response.parse>,
    mode: string,
  ): void {
    if (['scope', 'role', 'generation'].includes(mode)) {
      assert.equal(response.success, false);
      if (response.success) throw new Error('Foreign request accepted');
      assert.equal(
        response.problem.code,
        mode === 'generation' ? 'STALE_CAPACITY_GENERATION' : 'CAPACITY_SCOPE_MISMATCH',
      );
      return;
    }
    assert.equal(response.success, true);
    if (!response.success || response.operation !== 'ready') throw new Error('Readiness failed');
    assert.equal(response.result.ready, false);
  }
}
const suite = new ManagerProgramAcceptance();
for (const mode of [
  'root',
  'composition',
  'foreign',
  'ready',
  'scope',
  'role',
  'generation',
  'permissions',
  'malformed',
  'oversize',
  'signal',
])
  test(
    'acceptance: separate built manager preserves native authority and bounded admission for ' +
      mode,
    suite.run.bind(suite, mode),
    20000,
  );
