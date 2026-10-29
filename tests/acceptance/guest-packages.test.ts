import { afterAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CanonicalJson,
  PackageDefinition,
  ProviderV4Schemas,
  type CapacityDispatch,
} from '@treeseed-cordis/sdk';
import { GuestProgramFixture, type GuestFixturePreparation } from '../support/guest-program.js';
import {
  GuestExtension,
  ExtensionProfilePlugin,
  ExtensionHandlerPlugin,
  ExtensionExecutionPlugin,
  MissingExecutionPlugin,
  CyclicHandlerPlugin,
} from '../support/guest-extension-plugin.js';

type Reference = { capability: string; file: string; sha256: string };
/** Genuine script-free NPM fixture acquisition, distinct from prepared-manifest construction. */
class GuestPackageArchive {
  readonly directory = mkdtempSync(join(tmpdir(), 'guest-package-archive-'));
  readonly packageDirectory = join(this.directory, 'consumer/node_modules/@fixture/guest');
  constructor() {
    this.prepare();
    this.command(['pm', 'pack', '--destination', this.directory], join(this.directory, 'source'));
    this.install();
  }
  close(): void {
    rmSync(this.directory, { recursive: true });
  }
  private command(args: string[], cwd: string): void {
    const result = spawnSync('bun', args, { cwd, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
  }
  private prepare(): void {
    mkdirSync(join(this.directory, 'source/dist'), { recursive: true });
    copyFileSync(
      'dist/tests/support/guest-extension-plugin.js',
      join(this.directory, 'source/dist/plugin.js'),
    );
    writeFileSync(join(this.directory, 'source/package.json'), JSON.stringify(this.metadata()));
    mkdirSync(join(this.directory, 'consumer'));
  }
  private metadata(): object {
    const providers = this.providers();
    return {
      name: '@fixture/guest',
      version: '1.0.0',
      type: 'module',
      files: ['dist'],
      scripts: { postinstall: 'touch postinstall-canary' },
      peerDependencies: { '@treeseed-cordis/sdk': '0.0.0-cordis.41', zod: '4.6.7' },
      cordisPackage: PackageDefinition.define(
        '@fixture/guest',
        '1.0.0',
        'fixture-guest',
        providers,
      ),
    };
  }
  private providers() {
    const providers = [];
    for (const plugin of [
      ExtensionProfilePlugin,
      ExtensionHandlerPlugin,
      ExtensionExecutionPlugin,
      MissingExecutionPlugin,
      CyclicHandlerPlugin,
    ])
      providers.push(PackageDefinition.export(plugin, 'dist/plugin.js', plugin.name));
    return providers;
  }
  private install(): void {
    const dependencies = {
      '@fixture/guest': 'file:' + join(this.directory, 'fixture-guest-1.0.0.tgz'),
      '@treeseed-cordis/sdk': 'file:' + resolve('vendor/sdk.tgz'),
      zod: '4.6.7',
    };
    writeFileSync(
      join(this.directory, 'consumer/package.json'),
      JSON.stringify({ private: true, dependencies }),
    );
    this.command(
      [
        'install',
        '--ignore-scripts',
        '--cache-dir',
        join(this.directory, 'cache'),
        '--no-progress',
      ],
      join(this.directory, 'consumer'),
    );
    assert.equal(existsSync(join(this.packageDirectory, 'postinstall-canary')), false);
  }
}
class GuestPreparedPackage implements GuestFixturePreparation {
  private readonly directories: string[] = [];
  private readonly copied = new Set<string>();
  references: Reference[] = [];
  constructor(
    private readonly archive: GuestPackageArchive,
    private readonly mode = 'normal',
  ) {}
  configure(record: CapacityDispatch, configuration: Record<string, unknown>): void {
    const profile = record.definition.profiles[0]!;
    profile.typeId = GuestExtension.capability.typeId;
    profile.capabilityRevision = GuestExtension.revision;
    profile.handler = structuredClone(GuestExtension.handler);
    profile.parameters = {};
    for (const plugin of [
      ExtensionProfilePlugin,
      this.mode === 'cycle' ? CyclicHandlerPlugin : ExtensionHandlerPlugin,
      this.mode === 'missing' ? MissingExecutionPlugin : ExtensionExecutionPlugin,
    ])
      this.references.push(this.prepare(plugin.declaration, plugin.name, record));
    this.alter();
    configuration.providers = this.references;
  }
  private prepare(
    declaration: { id: string; capability: string },
    classExport: string,
    record: CapacityDispatch,
  ): Reference {
    const temporary = mkdtempSync(join(tmpdir(), 'guest-prepared-'));
    this.copy(this.archive.packageDirectory, temporary);
    this.copied.clear();
    this.dependencies(temporary, temporary);
    const manifest = this.manifest(temporary, declaration.id, classExport, record);
    const bytes = Buffer.from(CanonicalJson.stringify(manifest));
    const sha256 = CanonicalJson.digest(manifest);
    writeFileSync(join(temporary, 'provider.json'), bytes);
    const directory = join(this.archive.directory, sha256);
    renameSync(temporary, directory);
    this.permissions(directory, true);
    this.directories.push(directory);
    return { capability: declaration.capability, file: join(directory, 'provider.json'), sha256 };
  }
  private manifest(
    directory: string,
    providerId: string,
    classExport: string,
    record: CapacityDispatch,
  ) {
    return ProviderV4Schemas.manifest.parse({
      formatVersion: 2,
      contractVersion: ProviderV4Schemas.version,
      target: 'agent',
      scopeId:
        this.mode === 'scope'
          ? 'foreign.scope'
          : 'capacity-guest:' + CanonicalJson.digest(record.lease.scope),
      providerId,
      package: { name: '@fixture/guest', version: '1.0.0' },
      entry: 'dist/plugin.js',
      classExport,
      configuration:
        this.mode === 'constructor' && classExport === 'ExtensionExecutionPlugin'
          ? { missing: true }
          : {},
      files: this.inventory(directory),
    });
  }
  private dependencies(directory: string, root: string): void {
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies })) {
      if (this.copied.has(name)) continue;
      const source = join(this.archive.directory, 'consumer/node_modules', name);
      if (!existsSync(source) && metadata.peerDependenciesMeta?.[name]?.optional) continue;
      this.copied.add(name);
      const target = join(root, 'node_modules', name);
      this.copy(source, target);
      this.dependencies(target, root);
    }
  }
  private copy(source: string, target: string): void {
    const stat = lstatSync(source);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(source)) this.copy(join(source, name), join(target, name));
    } else {
      assert(stat.isFile());
      copyFileSync(source, target);
    }
  }
  private inventory(directory: string, prefix = ''): { path: string; sha256: string }[] {
    const files: { path: string; sha256: string }[] = [];
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) files.push(...this.inventory(path, prefix + name + '/'));
      else files.push({ path: prefix + name, sha256: this.sha(readFileSync(path)) });
    }
    return files;
  }
  private sha(bytes: Buffer): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  }
  private permissions(path: string, immutable: boolean): void {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    chmodSync(path, stat.isDirectory() ? (immutable ? 0o500 : 0o700) : immutable ? 0o400 : 0o600);
    if (stat.isDirectory())
      for (const name of readdirSync(path)) this.permissions(join(path, name), immutable);
  }
  private alter(): void {
    if (this.mode === 'duplicate') this.references.push(this.references[0]!);
    if (this.mode === 'unknown') this.references[0]!.capability = 'agent.private.assignment';
    if (this.mode === 'tamper') {
      const file = this.references[0]!.file;
      chmodSync(file, 0o600);
      writeFileSync(file, '{}');
      chmodSync(file, 0o400);
    }
  }
  close(): void {
    for (const directory of this.directories) {
      this.permissions(directory, false);
      rmSync(directory, { recursive: true });
    }
  }
}
class GuestPackageAcceptance {
  private archive: GuestPackageArchive | null = null;
  private preparation(mode: string): GuestPreparedPackage {
    this.archive ??= new GuestPackageArchive();
    return new GuestPreparedPackage(this.archive, mode);
  }
  close(): void {
    this.archive?.close();
  }
  async node(): Promise<void> {
    await this.run(false);
  }
  async standalone(): Promise<void> {
    await this.run(true);
  }
  private async run(standalone: boolean): Promise<void> {
    const prepared = this.preparation('normal');
    const fixture = new GuestProgramFixture(prepared, standalone);
    try {
      const ready = await Promise.race([
        fixture.request('ready', null),
        once(fixture.child, 'exit').then(this.unexpected.bind(this, fixture)),
      ]);
      assert(ready.success);
      fixture.record.lease.generations.runner = ready.generation;
      fixture.publish();
      const reply = await fixture.request('run', ready.generation);
      assert(reply.success && reply.operation === 'run');
      assert.equal(reply.result.state, 'completed');
      assert.equal(reply.result.output, 'external:' + fixture.record.input);
      await fixture.close();
    } finally {
      fixture.kill();
      prepared.close();
    }
  }
  private unexpected(fixture: GuestProgramFixture): never {
    throw new Error('guest exited before external-provider readiness: ' + fixture.stderr);
  }
  async invalid(mode: string): Promise<void> {
    const prepared = this.preparation(mode);
    const fixture = new GuestProgramFixture(prepared);
    try {
      await fixture.close(2);
      assert.equal(fixture.stderr, 'INVALID_CAPACITY_CONTRACT\n');
    } finally {
      fixture.kill();
      prepared.close();
    }
  }
}
const suite = new GuestPackageAcceptance();
afterAll(suite.close.bind(suite));
test(
  'acceptance: Node guest executes an external profile handler and execution package through native services',
  suite.node.bind(suite),
  95000,
);
test(
  'acceptance: standalone guest loads external package SDK services with no runtime on PATH',
  suite.standalone.bind(suite),
  95000,
);
for (const mode of ['duplicate', 'unknown', 'tamper', 'constructor', 'missing', 'cycle', 'scope'])
  test(
    'acceptance: guest safely rejects external package ' + mode,
    suite.invalid.bind(suite, mode),
    95000,
  );
