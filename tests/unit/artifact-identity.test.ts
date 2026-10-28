import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
class ArtifactIdentityControl {
  mismatch():void {
    const directory=mkdtempSync(join(tmpdir(),'cordis-agent-identity-'));
    try {
      writeFileSync(join(directory,'package.json'),JSON.stringify({version:'0.0.0-cordis.999'}));
      const result=spawnSync(process.execPath,[resolve('scripts/tooling.ts'),'check'],{cwd:directory,encoding:'utf8'});
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('AGENT_PACKAGE_IDENTITY_DRIFT');
    } finally {rmSync(directory,{recursive:true,force:true});}
  }
}
const suite=new ArtifactIdentityControl();
test('unit: package identity drift fails before source compilation or metadata rewrite',suite.mismatch.bind(suite));
