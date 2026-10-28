import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
class NativeProbeAcceptance {
  run():void {
    const result=spawnSync('node',['dist/tests/support/native-probe-root-program.js'],{encoding:'utf8',timeout:10000});
    assert.equal(result.stderr,'');
    assert.equal(result.status,0);
    assert.equal(result.stdout,'native-agent-probe-root-ok\n');
  }
}
const suite=new NativeProbeAcceptance();
test('acceptance: built public default Agent root executes native probes and fences revoked authority',suite.run.bind(suite));
