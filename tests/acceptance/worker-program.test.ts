import { test } from 'bun:test';
import { WorkerProgramScenario } from '../support/worker-program-fixture.js';
const suite = new WorkerProgramScenario();
for (const mode of [
  'ready',
  'process-generation',
  'foreign-scope',
  'foreign-role',
  'stale-generation',
  'reserve',
  'foreign-host',
  'malformed-host',
  'malformed-frame',
  'oversize',
  'truncated',
  'private-configuration',
  'signal',
])
  test(
    'acceptance: separate built worker program preserves safe native lifecycle for ' + mode,
    suite.run.bind(suite, mode),
    20000,
  );
