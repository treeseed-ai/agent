import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
class ArtifactIdentityControl {
  runtimeDependencies():void {
    const metadata=JSON.parse(readFileSync('package.json','utf8'));
    expect(metadata.dependencies).toEqual({cordis:'4.0.0-rc.12',zod:'4.6.7'});
  }
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
test('unit: native Agent imports have explicit exact runtime dependencies',suite.runtimeDependencies.bind(suite));
