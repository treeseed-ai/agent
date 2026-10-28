import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
class NativeProvidersAcceptance {
  run():void {
    const result=spawnSync('node',['dist/tests/support/native-providers-program.js'],{encoding:'utf8',timeout:10000});
    expect(result.stderr).toBe('');expect(result.status).toBe(0);
    expect(result.stdout).toBe('native-agent-providers-ok\n');
  }
}
const suite=new NativeProvidersAcceptance();
test('acceptance: built public native providers compose real defaults and honor real grant revocation',suite.run.bind(suite));
