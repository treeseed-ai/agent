import { AgentHostPlugin } from '../src/execution.js';
import { AgentContextPlugin, AgentEchoToolPlugin, AgentEchoHandlerPlugin, AgentReporterPlugin, AgentExecutionPlugin } from '../src/providers.js';
import { AgentPackageIdentity } from '../src/package-identity.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { AgentFileGrantPlugin } from '../src/authority.js';

/** Development-only owner gate; never a runtime composition or dependency resolver. */
class AgentTooling {
  static run(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    if (metadata.version !== AgentPackageIdentity.version) throw new Error('AGENT_PACKAGE_IDENTITY_DRIFT');
    const expected = metadata.cordisCandidate.sdk.sha256;
    const actual = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    if (actual !== expected) throw new Error('AGENT_SDK_ARCHIVE_CHANGED');
    new SourcePolicy().check(process.cwd(), process.argv[2] === 'build');
    this.project(metadata, process.argv[2] === 'build');
  }
  private static readonly definitions = [
    {plugin: AgentFileGrantPlugin, entry: 'dist/src/authority.js', name: 'AgentFileGrantPlugin'},
    {plugin: AgentHostPlugin, entry: 'dist/src/execution.js', name: 'AgentHostPlugin'},
    {plugin: AgentContextPlugin, entry: 'dist/src/providers.js', name: 'AgentContextPlugin'},
    {plugin: AgentEchoToolPlugin, entry: 'dist/src/providers.js', name: 'AgentEchoToolPlugin'},
    {plugin: AgentEchoHandlerPlugin, entry: 'dist/src/providers.js', name: 'AgentEchoHandlerPlugin'},
    {plugin: AgentReporterPlugin, entry: 'dist/src/providers.js', name: 'AgentReporterPlugin'},
    {plugin: AgentExecutionPlugin, entry: 'dist/src/providers.js', name: 'AgentExecutionPlugin'},
  ];
  private static providers() {
    const providers = [];
    for (const {plugin, entry, name} of this.definitions) providers.push(PackageDefinition.export(plugin, entry, name));
    return providers;
  }
  private static project(metadata: Record<string, unknown>, build: boolean): void {
    const descriptor = PackageDefinition.define(String(metadata.name), String(metadata.version), 'agent', this.providers());
    if (build) {
      metadata.cordisPackage = descriptor;
      writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
    } else if (CanonicalJson.stringify(metadata.cordisPackage) !== CanonicalJson.stringify(descriptor)) {
      throw new Error('AGENT_PACKAGE_METADATA_DRIFT');
    }
  }
}
if (import.meta.main) AgentTooling.run();
