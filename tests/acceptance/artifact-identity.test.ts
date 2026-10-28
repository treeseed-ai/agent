import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
class ArtifactIdentityAcceptance {
  run():void {
    const result=spawnSync('node',['dist/tests/support/artifact-identity-program.js'],{encoding:'utf8'});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('agent-artifact-identity-ok\n');
  }
}
const suite=new ArtifactIdentityAcceptance();
test('acceptance: built public Agent identity matches its packaged version',suite.run.bind(suite));
