import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

class AgentPackageIdentityTests {
  private readonly metadata = JSON.parse(readFileSync('package.json', 'utf8'));

  sdk(): void {
    expect(this.metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.19');
    const selected = this.metadata.cordisCandidate.sdk;
    expect(selected.commit).toBe('90cf4f3cc62e166685280450c727499defd2af5b');
    expect(selected.sha256).toBe(
      '93dd549c98aba180306e9b19cc1cbc37494544b2764ed341c531c9af618c6f81',
    );
    expect(this.hash('vendor/sdk.tgz')).toBe(selected.sha256);
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(installed.version).toBe(this.metadata.peerDependencies['@treeseed-cordis/sdk']);
  }

  ui(): void {
    expect(this.metadata.peerDependencies['@treeseed-cordis/ui']).toBe('0.0.0-cordis.18');
    expect(this.metadata.peerDependenciesMeta['@treeseed-cordis/ui'].optional).toBe(true);
    const selected = this.metadata.cordisCandidate.ui;
    expect(selected.commit).toBe('e2b9c5e10611c196834fd57ba5358a74304e373c');
    expect(selected.sha256).toBe(
      'd09e6ed33f7f1bc2f7210208a94f33bbd2a6453d8fe886f75a1f950887223e48',
    );
    expect(this.hash('vendor/ui.tgz')).toBe(selected.sha256);
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/ui/package.json', 'utf8'),
    );
    expect(installed.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.19');
  }

  private hash(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}

const suite = new AgentPackageIdentityTests();
test('unit: Agent uses the exact public capacity SDK archive', suite.sdk.bind(suite));
test('unit: optional presentation shares the exact capacity SDK selection', suite.ui.bind(suite));
