import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

class AgentPackageIdentityTests {
  private readonly metadata = JSON.parse(readFileSync('package.json', 'utf8'));

  sdk(): void {
    expect(this.metadata.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.22');
    const selected = this.metadata.cordisCandidate.sdk;
    expect(selected.commit).toBe('c4f7849d402fc60bd1ee8274f647dac71a45b76e');
    expect(selected.sha256).toBe(
      'dc9a91c26b12180a6dd003a8f7b56e1bc76c19c48fde42feaa0026765dd6583f',
    );
    expect(this.hash('vendor/sdk.tgz')).toBe(selected.sha256);
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/sdk/package.json', 'utf8'),
    );
    expect(installed.version).toBe(this.metadata.peerDependencies['@treeseed-cordis/sdk']);
  }

  ui(): void {
    expect(this.metadata.peerDependencies['@treeseed-cordis/ui']).toBe('0.0.0-cordis.19');
    expect(this.metadata.peerDependenciesMeta['@treeseed-cordis/ui'].optional).toBe(true);
    const selected = this.metadata.cordisCandidate.ui;
    expect(selected.commit).toBe('1dd048ddbcb55124840b94e843e1ed1b5fa8ba2b');
    expect(selected.sha256).toBe(
      'cc78d9a007d9c2bb077f709d6ab72ef2d4861a52ef78d310cea3680d28bf4ec2',
    );
    expect(this.hash('vendor/ui.tgz')).toBe(selected.sha256);
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/ui/package.json', 'utf8'),
    );
    expect(installed.peerDependencies['@treeseed-cordis/sdk']).toBe('0.0.0-cordis.22');
  }

  private hash(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}

const suite = new AgentPackageIdentityTests();
test('unit: Agent uses the exact public capacity SDK archive', suite.sdk.bind(suite));
test('unit: optional presentation shares the exact capacity SDK selection', suite.ui.bind(suite));
