import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk/portable';
class CapacityClosureTests {
  installed():void {
    const metadata=JSON.parse(readFileSync('package.json','utf8'));
    const installed=JSON.parse(readFileSync('node_modules/@treeseed-cordis/sdk/package.json','utf8'));
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.36');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('0ae4f3973672e5c66ee021e7748c2ea73f7cb21c');
    const expected='04cea0518a3d64228cfbdad73a357d18cc7040e4bc7a122833dddd9de96ed000';
    expect(metadata.cordisCandidate.sdk.sha256).toBe(expected);
    expect(createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex')).toBe(expected);
  }
  protocols():void {
    for(const name of ['ActivitySchemas','EnvironmentSchemas','CapacitySchemas','PoolSchemas','CapacityProtocolSchemas','SandboxControlSchemas'])
      expect(typeof Reflect.get(sdk,name)).toBe('function');
    expect(sdk.PlatformOperations.all).toHaveLength(7);
  }
}
const suite=new CapacityClosureTests();
test('unit: Agent service contracts bind reviewed SDK archive peer and installed identity',suite.installed.bind(suite));
test('unit: Agent service archive contains the entire accepted portable capacity closure',suite.protocols.bind(suite));
