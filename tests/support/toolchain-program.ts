import assert from 'node:assert/strict';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { AgentSchemas, ActivitySchemas, PlatformOperations } from '@treeseed-cordis/sdk';

/** Development consumer only: no Agent runtime, credentials or sandbox execution. */
class AgentToolchainProgram {
  run(): void {
    const policy = new SourcePolicy();
    assert.deepEqual(policy.inspect('src/provider.ts', 'class Provider { run(): void {} }'), []);
    assert.ok(policy.inspect('src/provider.ts', 'export function run() {}').length > 0);
    assert.equal(typeof AgentSchemas.request.parse, 'function');
    assert.equal(typeof ActivitySchemas.definition.parse, 'function');
    assert.equal(PlatformOperations.all.length, 7);
    process.stdout.write('agent-toolchain-ok\n');
  }
}
if (import.meta.main) new AgentToolchainProgram().run();
