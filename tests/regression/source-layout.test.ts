import { test, expect } from 'bun:test';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { TestLayout } from '../../.agents/skills/release-workflow/scripts/test-layout.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
class SourceLayoutRegression {
  architecture(): void {
    const policy = new SourcePolicy();
    expect(policy.inspect('src/main.js', 'class Program {}').length).toBeGreaterThan(0);
    expect(policy.inspect('src/main.ts', 'export function execute() {}').length).toBeGreaterThan(0);
    expect(policy.inspect('src/main.ts', 'class Program { run():void {} }')).toEqual([]);
  }
  hidden(): void {
    const root = mkdtempSync(join(tmpdir(), 'agent-layout-'));
    try {
      mkdirSync(join(root, 'tests/support'), { recursive: true });
      writeFileSync(
        join(root, 'tests/support/hidden.test.ts'),
        "import {test} from 'bun:test';class Fixture{run():void{}}const fixture=new Fixture();test('hidden',fixture.run.bind(fixture));",
      );
      expect(new TestLayout().inspect(root).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
const suite = new SourceLayoutRegression();
test(
  'regression: Agent first implementation enforces strict classes and rejects handwritten JavaScript',
  suite.architecture.bind(suite),
);
test(
  'regression: Agent test discovery cannot hide specifications under support',
  suite.hidden.bind(suite),
);
