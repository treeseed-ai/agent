import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
class WorkerKataAcceptance {
  private readonly arguments = [
    '-n',
    'env',
    'PATH=/opt/kata/runtime-rs/bin:/opt/kata/bin:' + process.env.PATH,
    'GITHUB_ACTIONS=' + process.env.GITHUB_ACTIONS,
    'RUNNER_ENVIRONMENT=' + process.env.RUNNER_ENVIRONMENT,
    'RUNNER_TEMP=' + process.env.RUNNER_TEMP,
    'KATA_CONF_FILE=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml',
    process.execPath,
    resolve('dist/tests/support/worker-kata-program.js'),
  ];
  interface(): void {
    const result = spawnSync('node', ['dist/tests/support/worker-kata-program.js', '--interface'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'worker-kata-interface-ok\n');
  }
  real(): void {
    const result = spawnSync('sudo', this.arguments, { encoding: 'utf8', timeout: 240000 });
    assert.equal(result.status, 0, result.stderr || 'Worker Kata qualification failed');
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'worker-kata-qualified-ok\n');
  }
}
const suite = new WorkerKataAcceptance();
test(
  'acceptance: built worker Kata interface refuses unqualified fixture construction without host effects',
  suite.interface.bind(suite),
);
test(
  'acceptance: real default worker root holds an exact guest generation through Kata teardown',
  suite.real.bind(suite),
  245000,
);
