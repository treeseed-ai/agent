import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkerApplication } from '@treeseed-cordis/agent/worker';
import { CapacitySchemas, SandboxControlSchemas } from '@treeseed-cordis/sdk';
/** Actual Node worker root. This process receives only the bounded client configuration. */
class WorkerKataClient {
  async run(): Promise<void> {
    const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
    const root = await WorkerApplication.start(input.worker);
    const lease = await root.acquireSandbox();
    try {
      lease.assertOpen();
      const signal = new AbortController().signal;
      const first = await lease.value.create(input.sandboxId, signal);
      const next = await lease.value.inspect(input.sandboxId, first.runner.generation, signal);
      assert.equal(first.sandbox.assignment, null);
      assert.deepEqual(next.runner.generation, first.runner.generation);
      const receipt = await lease.value.destroy(input.sandboxId, signal);
      this.report(first.runner, receipt, first.hostConfigurationDigest);
    } finally {
      await lease.release();
      await root.close();
    }
    assert.throws(lease.assertOpen.bind(lease));
    await assert.rejects(root.acquireSandbox());
  }
  private report(runner: unknown, destruction: unknown, digest: string): void {
    const record = {
      runner: CapacitySchemas.readiness.parse(runner),
      destruction: SandboxControlSchemas.destruction.parse(destruction),
      hostConfigurationDigest: digest,
    };
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}
if (import.meta.main) await new WorkerKataClient().run();
