import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  statSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { CapacitySchemas, CanonicalJson, SandboxControlSchemas } from '@treeseed-cordis/sdk';
import { WorkerApplication } from '@treeseed-cordis/agent/worker';
import { PackageArchiveInspector } from '@treeseed-cordis/deployment';
import { PrivateKataFixture } from '@treeseed-cordis/deployment/testing/kata';
import { KataSandboxPlugin } from '@treeseed-cordis/deployment/sandbox';
import {
  SandboxControlApplication,
  SandboxSocketClient,
} from '@treeseed-cordis/deployment/sandbox-control';
class WorkerKataProcess {
  private readonly output: Buffer[] = [];
  private readonly errors: Buffer[] = [];
  private total = 0;
  private overflow = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  async run(file: string): Promise<unknown> {
    this.child = spawn('node', [resolve('dist/tests/support/worker-kata-client.js'), file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000,
    });
    this.child.stdin.end();
    this.child.stdout.on('data', this.collect.bind(this, this.output));
    this.child.stderr.on('data', this.collect.bind(this, this.errors));
    const [code] = await once(this.child, 'close');
    assert.equal(this.overflow, false, 'Worker output exceeded the qualification bound');
    assert.equal(code, 0, Buffer.concat(this.errors).toString());
    assert.equal(Buffer.concat(this.errors).length, 0);
    const text = Buffer.concat(this.output).toString();
    assert.equal(text.indexOf('\n'), text.length - 1);
    return JSON.parse(text);
  }
  private collect(target: Buffer[], bytes: Buffer): void {
    this.total += bytes.length;
    if (this.total > 65536) {
      this.overflow = true;
      this.child!.kill('SIGKILL');
      return;
    }
    target.push(bytes);
  }
}
/** Test composition only. Deployment retains all host infrastructure implementation. */
class WorkerKataQualification {
  private readonly fixture = new PrivateKataFixture();
  private readonly endpoint = join(this.fixture.directory, 'worker-control');
  private readonly authorityFile = join(this.fixture.directory, 'worker-authority.json');
  private readonly credential = randomBytes(32).toString('hex');
  private readonly id = 'sandbox-' + randomUUID();
  private readonly scope = { ...this.fixture.namespaceScope, serviceGeneration: 'e'.repeat(64) };
  private readonly capacityScope = CapacitySchemas.scope.parse({
    installationId: this.scope.installationId,
    installationDirectory: this.fixture.directory,
    capacityProviderId: 'fixture.provider',
    project: 'fixture.project',
    platformProfile: 'fixture.default',
    workerId: 'fixture.worker',
  });
  private readonly archive = resolve('vendor/agent-guest.tgz');
  private readonly artifactDirectory = join(this.fixture.directory, 'guest-artifact');
  private readonly digest = '93f0ab94247dc253a227cf92c85e6393fd238965da252b2ff31069ee8dce9679';
  private readonly image =
    'docker.io/library/ubuntu@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725';
  private readonly imageArguments = [
    'images',
    'pull',
    '--local',
    '--platform',
    'linux/amd64',
    '--snapshotter',
    'native',
    this.image,
  ];
  private application: SandboxControlApplication | null = null;
  private attempted = false;
  private destroyed = false;
  async run(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.exercise();
    } catch (error) {
      failures.push(error);
    }
    await this.finish(failures);
    assert(!existsSync(join(this.endpoint, 'control.sock')));
    process.stdout.write('worker-kata-qualified-ok\n');
  }
  private async finish(failures: unknown[]): Promise<void> {
    for (const operation of [
      this.cleanup.bind(this),
      this.close.bind(this),
      this.fixture.stop.bind(this.fixture),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Worker Kata qualification failed');
  }
  private async close(): Promise<void> {
    await this.application?.close();
  }
  private async cleanup(): Promise<void> {
    if (!this.attempted || this.destroyed) return;
    const receipt = await this.control().destroy(this.id, new AbortController().signal);
    assert.equal(receipt.sandboxId, this.id);
    assert.equal(receipt.destroyed, true);
    this.destroyed = true;
  }
  private async artifact(): Promise<void> {
    const index = await PackageArchiveInspector.inspect(
      join(this.artifactDirectory, 'agent.tgz'),
      this.digest,
    );
    assert.equal(index.metadata.name, '@treeseed-cordis/agent');
    assert.equal(index.metadata.version, '0.0.0-cordis.28');
    const file = index.files.find(WorkerKataQualification.workerFile);
    assert(file, 'Frozen worker entry missing');
    assert.equal(file.sha256, PrivateKataFixture.hash('dist/src/worker.js'));
    assert.equal(file.size, statSync('dist/src/worker.js').size);
  }
  private static workerFile(file: { path: string }): boolean {
    return file.path === 'dist/src/worker.js';
  }
  private async exercise(): Promise<void> {
    this.stage();
    await this.artifact();
    await this.fixture.start();
    const host = await this.host();
    mkdirSync(this.endpoint, { mode: 0o700 });
    writeFileSync(this.authorityFile, JSON.stringify(this.authority()), { mode: 0o600 });
    this.application = await SandboxControlApplication.start(this.hostConfiguration(host));
    const availability = await this.control().ready(new AbortController().signal);
    const file = this.configuration(availability.configurationDigest);
    this.attempted = true;
    const result = await new WorkerKataProcess().run(file);
    this.result(result, availability.configurationDigest);
    await assert.rejects(this.control().inspect(this.id, new AbortController().signal));
    this.absent();
    this.fixture.workloads.canaries();
  }
  private stage(): void {
    mkdirSync(this.artifactDirectory, { mode: 0o700 });
    const file = join(this.artifactDirectory, 'agent.tgz');
    copyFileSync(this.archive, file);
    chmodSync(file, 0o600);
  }
  private async host(): Promise<unknown> {
    const { workloads, ...base } = KataSandboxPlugin.Config.parse(
      await this.fixture.configuration(),
    );
    const directory = this.artifactDirectory;
    this.fixture.run(this.imageArguments);
    return {
      ...base,
      image: this.image,
      guestRuntime: {
        scope: this.capacityScope,
        artifact: {
          directory,
          archive: { path: 'agent.tgz', sha256: this.digest, size: statSync(this.archive).size },
          package: { name: '@treeseed-cordis/agent', version: '0.0.0-cordis.28' },
        },
      },
    };
  }
  private hostConfiguration(host: unknown): object {
    const path = realpathSync('/lib/x86_64-linux-gnu/libc.so.6');
    return {
      scope: this.scope,
      endpointDirectory: this.endpoint,
      authorityFile: this.authorityFile,
      socketLibrary: { path, sha256: PrivateKataFixture.hash(path) },
      host,
      artifact: {
        package: '@treeseed-cordis/deployment',
        version: '0.0.0-cordis.106',
        integrity: 'e0fdebbdeb81a374a58437179bec2a79a5074e52705aa927d7d4865426ab398c',
      },
    };
  }
  private authority(): object {
    return {
      credential: this.credential,
      grant: this.controlGrant(),
      runnerGrant: {
        schemaVersion: 'treeseed.sandbox-runner-grant/v1',
        id: 'grant:runner',
        revision: 1,
        scope: this.scope,
        capacityScope: this.capacityScope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 240000,
        operations: ['ready'],
      },
    };
  }
  private controlGrant(): object {
    return {
      schemaVersion: 'treeseed.sandbox-grant/v1',
      id: 'grant:control',
      revision: 1,
      scope: this.scope,
      state: 'granted',
      expiresAtEpochMs: Date.now() + 240000,
      operations: ['ready', 'create', 'inspect', 'destroy'],
    };
  }
  private control(): SandboxSocketClient {
    return new SandboxSocketClient({
      scope: this.scope,
      endpointDirectory: this.endpoint,
      authorityFile: this.authorityFile,
    });
  }
  private configuration(digest: string): string {
    const file = join(this.fixture.directory, 'worker.json');
    const worker = WorkerApplication.Config.parse({
      scope: this.capacityScope,
      hostScope: this.scope,
      hostConfigurationDigest: digest,
      endpointDirectory: this.endpoint,
      authorityFile: this.authorityFile,
    });
    writeFileSync(file, JSON.stringify({ worker, sandboxId: this.id }), { mode: 0o600 });
    return file;
  }
  private result(input: unknown, digest: string): void {
    assert(input && typeof input === 'object');
    const result = input as Record<string, unknown>;
    assert.deepEqual(Object.keys(result).sort(), [
      'destruction',
      'hostConfigurationDigest',
      'runner',
    ]);
    const runner = CapacitySchemas.readiness.parse(result.runner);
    assert.equal(runner.role, 'runner');
    assert.equal(runner.ready, true);
    assert.deepEqual(runner.scope, this.capacityScope);
    assert.deepEqual(runner.blockers, []);
    const receipt = SandboxControlSchemas.destruction.parse(result.destruction);
    assert.equal(receipt.sandboxId, this.id);
    assert.equal(receipt.destroyed, true);
    assert.equal(result.hostConfigurationDigest, digest);
    assert(!JSON.stringify(result).includes(this.credential));
    this.destroyed = true;
  }
  private absent(): void {
    assert.equal(this.fixture.run(['tasks', 'list', '--quiet']), '');
    assert.equal(this.fixture.run(['containers', 'list', '--quiet']), '');
    const name = this.fixture.namespace + '-' + CanonicalJson.digest({ id: this.id }).slice(0, 24);
    const snapshots = this.fixture.run(['snapshots', '--snapshotter', 'native', 'list']);
    for (const line of snapshots.split('\n')) assert.notEqual(line.trim().split(/\s+/)[0], name);
  }
}
class WorkerKataEntry {
  static async run(): Promise<void> {
    if (process.argv[2] === '--interface') return this.interface();
    await new WorkerKataQualification().run();
  }
  private static interface(): void {
    assert.equal(typeof WorkerApplication.start, 'function');
    assert.throws(this.unqualified.bind(this), { message: 'KATA_QUALIFICATION_REQUIRED' });
    process.stdout.write('worker-kata-interface-ok\n');
  }
  private static unqualified(): void {
    new PrivateKataFixture();
  }
}
if (import.meta.main) await WorkerKataEntry.run();
