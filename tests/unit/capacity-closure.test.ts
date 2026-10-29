import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as control from '@treeseed-cordis/sdk/provider-control';
import * as sdk from '@treeseed-cordis/sdk/portable';
class CapacityClosureTests {
  installed(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.44');
    expect(installed.version).toBe(metadata.peerDependencies['@treeseed-cordis/sdk']);
    expect(metadata.cordisCandidate.sdk.commit).toBe('00be028b92998f8d7039a3906e784c6b8598e730');
    const expected = 'd95c54cf6081c7634498dfb4f3235d42d65b8664a5d62cc87c4dd4e85381f0f3';
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
    const availability = Reflect.get(control, 'ProviderAvailabilitySchemas');
    expect(typeof availability).toBe('function');
    expect(Reflect.get(availability, 'version')).toBe('treeseed.provider-availability/v1');
    for (const method of ['createAvailabilitySession', 'refreshAvailabilitySession', 'closeAvailabilitySession'])
      expect(typeof Reflect.get(control.ProviderProtocolClient.prototype, method)).toBe('function');
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
