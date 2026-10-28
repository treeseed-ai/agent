import { test, expect } from 'bun:test';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';

class AgentSourcePolicyTests {
  classes(): void {
    expect(new SourcePolicy().inspect('src/provider.ts', 'class Provider { run(): void {} }')).toEqual([]);
  }
  functions(): void {
    const policy = new SourcePolicy();
    for (const source of ['export function run() {}', 'const run = () => 1', 'const run = function() {}'])
      expect(policy.inspect('src/provider.ts', source).length).toBeGreaterThan(0);
  }
  javascript(): void {
    expect(new SourcePolicy().inspect('src/provider.js', 'class Provider {}').length).toBeGreaterThan(0);
  }
  boundaries(): void {
    const policy = new SourcePolicy();
    for (const name of ['../../../sdk/src/contracts.ts', '/tmp/foreign.ts', 'file:///tmp/foreign.ts'])
      expect(policy.inspect('src/provider.ts', 'import "' + name + '";').length).toBeGreaterThan(0);
    expect(policy.inspect('src/provider.ts', 'import "@treeseed-cordis/sdk";')).toEqual([]);
  }
}
const suite = new AgentSourcePolicyTests();
test('unit: Agent semantic policy accepts cohesive TypeScript class methods', suite.classes.bind(suite));
test('unit: Agent semantic policy rejects function implementation paths', suite.functions.bind(suite));
test('unit: Agent semantic policy rejects handwritten JavaScript', suite.javascript.bind(suite));
test('unit: Agent semantic policy rejects cross-checkout source and URL imports', suite.boundaries.bind(suite));
