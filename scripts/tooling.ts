import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';
import { PackageDefinition, CanonicalJson, type NativeDescriptorClass } from '@treeseed-cordis/sdk';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { AgentFileGrantPlugin } from '../src/authority.js';
import { AgentHostPlugin } from '../src/execution.js';
import { EnvironmentPreparationPlugin } from '../src/environments.js';
import {
  AgentContextPlugin,
  AgentEchoToolPlugin,
  AgentEchoHandlerPlugin,
  AgentReporterPlugin,
  AgentExecutionPlugin,
} from '../src/providers.js';
class AgentTooling {
  private static readonly sources: Array<[NativeDescriptorClass, string, string]> = [
    [EnvironmentPreparationPlugin, 'environments', 'EnvironmentPreparationPlugin'],
    [AgentFileGrantPlugin, 'authority', 'AgentFileGrantPlugin'],
    [AgentHostPlugin, 'execution', 'AgentHostPlugin'],
    [AgentContextPlugin, 'providers', 'AgentContextPlugin'],
    [AgentEchoToolPlugin, 'providers', 'AgentEchoToolPlugin'],
    [AgentEchoHandlerPlugin, 'providers', 'AgentEchoHandlerPlugin'],
    [AgentReporterPlugin, 'providers', 'AgentReporterPlugin'],
    [AgentExecutionPlugin, 'providers', 'AgentExecutionPlugin'],
  ];
  static run(): void {
    const mode = process.argv[2];
    new SourcePolicy().check(process.cwd(), mode === 'build');
    const metadata = JSON.parse(readFileSync('package.json', 'utf8')),
      providers = [];
    for (const [plugin, file, name] of this.sources)
      providers.push(PackageDefinition.export(plugin, 'dist/src/' + file + '.js', name));
    const descriptor = PackageDefinition.define(
      metadata.name,
      metadata.version,
      'agent',
      providers,
    );
    if (mode === 'build') {
      metadata.cordisPackage = descriptor;
      writeFileSync('package.json', JSON.stringify(metadata, null, 2) + '\n');
      chmodSync('dist/src/main.js', 0o755);
    } else if (
      CanonicalJson.stringify(metadata.cordisPackage) !== CanonicalJson.stringify(descriptor)
    )
      throw new Error('AGENT_PACKAGE_METADATA_DRIFT');
  }
}
AgentTooling.run();
