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
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.41');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('4bb54954ac6d636309a8312c2bf71536b5aefb73');
    const expected = '2bbde1a4ca35fbffaeacb2fbeab40b49f56dc57dca3355e8e47e22ed5f0f822a';
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
