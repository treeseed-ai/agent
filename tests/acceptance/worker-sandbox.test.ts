import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { WorkerHostFixture } from '../support/worker-sandbox-program.js';
class WorkerSandboxAcceptance {
  async run(mode: string): Promise<void> {
    const fixture = new WorkerHostFixture(mode);
    try {
      await fixture.start();
      const result = await fixture.program();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(
        result.stdout,
        mode === 'accepted' ? 'worker-sandbox-ok\n' : 'worker-sandbox-refused\n',
      );
      assert(!JSON.stringify(result).includes('PRIVATE_WORKER_CANARY'));
      fixture.verify();
    } finally {
      await fixture.close();
    }
  }
}
const suite = new WorkerSandboxAcceptance();
test(
  'acceptance: built native worker root uses actual scoped clients for fresh sandbox lifecycle and native lease disposal',
  suite.run.bind(suite, 'accepted'),
  20000,
);
for (const mode of [
  'foreign-host',
  'moved-host',
  'foreign-scope',
  'foreign-sandbox',
  'assigned',
  'missing-runner',
  'changed-generation',
  'wrong-grant',
  'malformed',
  'cancel',
  'bad-configuration',
])
  test(
    'acceptance: built worker sandbox root safely refuses ' + mode,
    suite.run.bind(suite, mode),
    20000,
  );
