import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import type {AgentAuthorityBinding,AgentExecutionResult} from '@treeseed-cordis/sdk';
import {AgentAuthorityFixture} from '../support/private-authority-program.js';
interface ProbeRoot {
  status():{generation:string;ready:boolean;disposedChildren:number};
  execute(input:unknown,signal?:AbortSignal):Promise<AgentExecutionResult>;
  dispose():Promise<void>;
}
interface ProbeConstructor {
  start(input:{binding:AgentAuthorityBinding;authorityFile:string}):Promise<ProbeRoot>;
}
const require=createRequire(import.meta.url);
class NativeProbeProgram {
  private load():Record<string,unknown> {
    try {return require('@treeseed-cordis/agent');} catch {return {};}
  }
  async run():Promise<void> {
    const fixture=new AgentAuthorityFixture();
    let root:ProbeRoot|undefined;
    try {
      const Constructor=this.load().AgentApplication as ProbeConstructor;
      assert.equal(typeof Constructor,'function','public native probe root must exist');
      root=await Constructor.start({binding:fixture.binding,authorityFile:fixture.file});
      await this.probe(root,fixture);
      await this.denials(root,fixture);
    } finally {
      await root?.dispose();
      fixture.close();
    }
    process.stdout.write('native-agent-probe-root-ok\n');
  }
  private async probe(root:ProbeRoot,fixture:AgentAuthorityFixture):Promise<void> {
    assert.equal(root.status().ready,true);
    const result=await root.execute(fixture.request(root.status().generation));
    assert.equal(result.state,'completed');
    assert.equal(result.output,'harmless fixture');
    assert.deepEqual(result.blockers,[]);
    assert.equal(result.cleanup,'disposed');
    assert.equal(root.status().disposedChildren,1);
  }
  private async denials(root:ProbeRoot,fixture:AgentAuthorityFixture):Promise<void> {
    await assert.rejects(root.execute(fixture.request('b'.repeat(64))),/STALE_AGENT_GENERATION/);
    fixture.write({...fixture.binding,state:'revoked'});
    const result=await root.execute(fixture.request(root.status().generation));
    assert.equal(result.state,'blocked');
    assert.equal(result.output,null);
    assert.equal(result.blockers[0]?.code,'AGENT_GRANT_REVOKED');
    assert.equal(result.cleanup,'disposed');
    await root.dispose();
    await assert.rejects(root.execute(fixture.request(root.status().generation)),/AGENT_ADMISSION_CLOSED/);
  }
}
class NativeProbeAcceptance {
  run():void {
    const result=spawnSync('node',['dist/tests/acceptance/native-probe-root.test.js','--public-consumer'],{encoding:'utf8',timeout:10000});
    assert.equal(result.stderr,'');
    assert.equal(result.status,0);
    assert.equal(result.stdout,'native-agent-probe-root-ok\n');
  }
}
if(process.argv[2]==='--public-consumer') await new NativeProbeProgram().run();
else {
  const {test}=await import('bun:test');
  const suite=new NativeProbeAcceptance();
  test('acceptance: built public default Agent root executes native probes and fences revoked authority',suite.run.bind(suite));
}
