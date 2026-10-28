import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as authority from '@treeseed-cordis/agent/authority';
class ArtifactIdentityProgram {
  run():void {
    const identity=Reflect.get(authority,'AgentPackageIdentity');
    assert.equal(typeof identity,'function','public bundled identity must exist');
    const metadata=JSON.parse(readFileSync('package.json','utf8'));
    assert.equal(identity.version,metadata.version);
    assert.equal(identity.artifact,metadata.name+'@'+metadata.version);
    process.stdout.write('agent-artifact-identity-ok\n');
  }
}
if(import.meta.main)new ArtifactIdentityProgram().run();
