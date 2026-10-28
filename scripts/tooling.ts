import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { EnvironmentPreparationPlugin } from '../src/environments.js';

/** Development-only owner gate; never a runtime composition or dependency resolver. */
class AgentTooling {
  static run(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const expected = metadata.cordisCandidate.sdk.sha256;
    const actual = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    if (actual !== expected) throw new Error('AGENT_SDK_ARCHIVE_CHANGED');
    new SourcePolicy().check(process.cwd(), process.argv[2] === 'build');
    this.project(metadata, process.argv[2] === 'build');
  }
  private static project(metadata: Record<string, unknown>, build: boolean): void {
    const provider = PackageDefinition.export(EnvironmentPreparationPlugin, 'dist/src/environments.js', 'EnvironmentPreparationPlugin');
    const descriptor = PackageDefinition.define(String(metadata.name), String(metadata.version), 'agent', [provider]);
    if (build) {
      metadata.cordisPackage = descriptor;
      writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
    } else if (CanonicalJson.stringify(metadata.cordisPackage) !== CanonicalJson.stringify(descriptor)) {
      throw new Error('AGENT_PACKAGE_METADATA_DRIFT');
    }
  }
}
if (import.meta.main) AgentTooling.run();
