import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@treeseed-cordis/sdk/portable';
class CapacityClosureTests {
  installed(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.42');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('afdfac7bdd3c9c1f783362cd1d50324181e1d725');
    const expected = '0ecfe599916fe8ef364fc4b73203c810981f163109fbe71a0dd4c01a9dfb7bbc';
    expect(metadata.cordisCandidate.sdk.sha256).toBe(expected);
    expect(createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex')).toBe(
      expected,
    );
  }
  private static readonly contracts = [
    'ActivitySchemas',
    'EnvironmentSchemas',
    'CapacitySchemas',
    'PoolSchemas',
    'CapacityProtocolSchemas',
    'SandboxControlSchemas',
    'CapacityChannelSchemas',
    'CapacityChannelBinding',
    'SandboxRunnerSchemas',
    'SandboxRunnerBinding',
    'GuestRuntimeSchemas',
    'GuestRuntimeBinding',
    'SandboxProfileSchemas',
    'SandboxProfileBinding',
    'SandboxProfileError',
  ];
  protocols(): void {
    for (const name of CapacityClosureTests.contracts)
      expect(typeof Reflect.get(sdk, name)).toBe('function');
    expect(sdk.PlatformOperations.all).toHaveLength(7);
  }
}
const suite = new CapacityClosureTests();
test(
  'unit: Agent service contracts bind reviewed SDK archive peer and installed identity',
  suite.installed.bind(suite),
);
test(
  'unit: Agent service archive contains the entire accepted portable capacity closure',
  suite.protocols.bind(suite),
);
