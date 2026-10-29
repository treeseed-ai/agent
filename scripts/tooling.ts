import { ProviderCredentialPlugin } from '../src/provider-credentials.js';
import { ProviderRegistrationPlugin } from '../src/provider-connection.js';
import { ProviderFileProofPlugin } from '../src/provider-proof.js';
import { GuestProfilePlugin, GuestContextPlugin, GuestHandlerPlugin, GuestToolPlugin, GuestReportingPlugin, GuestExecutionPlugin } from '../src/guest-providers.js';
import { AgentHostPlugin } from '../src/execution.js';
import { AgentContextPlugin, AgentEchoToolPlugin, AgentEchoHandlerPlugin, AgentReporterPlugin, AgentExecutionPlugin } from '../src/providers.js';
import { AgentPackageIdentity } from '../src/package-identity.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { CanonicalJson, PackageDefinition } from '@treeseed-cordis/sdk';
import { AgentFileGrantPlugin, AgentCapacityAssignmentFilePlugin } from '../src/authority.js';

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
    {plugin: ProviderCredentialPlugin, entry: 'dist/src/provider-credentials.js', name: 'ProviderCredentialPlugin'},
    {plugin: ProviderRegistrationPlugin, entry: 'dist/src/provider-connection.js', name: 'ProviderRegistrationPlugin'},
    {plugin: ProviderFileProofPlugin, entry: 'dist/src/provider-proof.js', name: 'ProviderFileProofPlugin'},
    {plugin: GuestProfilePlugin, entry: 'dist/src/guest-providers.js', name: 'GuestProfilePlugin'},
    {plugin: GuestContextPlugin, entry: 'dist/src/guest-providers.js', name: 'GuestContextPlugin'},
    {plugin: GuestHandlerPlugin, entry: 'dist/src/guest-providers.js', name: 'GuestHandlerPlugin'},
    {plugin: GuestToolPlugin, entry: 'dist/src/guest-providers.js', name: 'GuestToolPlugin'},
    {plugin: GuestReportingPlugin, entry: 'dist/src/guest-providers.js', name: 'GuestReportingPlugin'},
    {plugin: GuestExecutionPlugin, entry: 'dist/src/guest-providers.js', name: 'GuestExecutionPlugin'},
    {plugin: AgentCapacityAssignmentFilePlugin, entry: 'dist/src/authority.js', name: 'AgentCapacityAssignmentFilePlugin'},
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
