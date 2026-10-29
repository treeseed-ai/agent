import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { GuestProfilePlugin } from '@treeseed-cordis/agent/guest';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  CanonicalJson,
  CapacityProtocolSchemas,
  CapacityChannelSchemas,
  type CapacityDispatch,
  type CapacityChannelResponse,
} from '@treeseed-cordis/sdk';
export class GuestProgramLauncher {
  private readonly directory = mkdtempSync(join(tmpdir(), 'guest-runtime-'));
  private readonly file = join(this.directory, 'guest');
  constructor(private readonly standalone = process.argv.includes('--standalone')) {
    if (this.standalone) this.prepare();
  }
  private prepare(): void {
    const manifest = JSON.parse(readFileSync('dist/bin/guest-runtime.json', 'utf8'));
    const compressed = this.compressed(manifest.compressed.parts);
    assert.equal(createHash('sha256').update(compressed).digest('hex'), manifest.compressed.sha256);
    const expanded = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
    assert.equal(expanded.length, manifest.executable.size);
    assert.equal(createHash('sha256').update(expanded).digest('hex'), manifest.executable.sha256);
    writeFileSync(this.file, expanded, { mode: 0o755 });
    mkdirSync(join(this.directory, 'empty'));
    this.ambientCanary();
  }
  private compressed(parts: { file: string; size: number; sha256: string }[]): Buffer {
    const chunks = [];
    for (const part of parts) {
      assert.match(part.file, /^trsd-agent-guest\.[0-9]{3}\.gzpart$/);
      const bytes = readFileSync(join('dist/bin', part.file));
      assert(bytes.length <= 7 * 1024 * 1024);
      assert.equal(bytes.length, part.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  private ambientCanary(): void {
    writeFileSync(join(this.directory, 'bunfig.toml'), 'preload = ["./ambient.ts"]\n');
    writeFileSync(
      join(this.directory, 'ambient.ts'),
      "import {writeFileSync} from 'node:fs'; class AmbientCanary {static run():void {writeFileSync('ambient-canary','unexpected');}} AmbientCanary.run();",
    );
    writeFileSync(join(this.directory, '.env'), 'BUN_OPTIONS=--preload ./ambient.ts\n');
  }
  private command(configuration: string): string[] {
    return this.standalone
      ? [this.file, '--config', configuration]
      : ['node', 'dist/src/guest-main.js', '--config', configuration];
  }
  private options(): { cwd?: string; env: NodeJS.ProcessEnv } {
    return this.standalone
      ? {
          cwd: this.directory,
          env: {
            PATH: join(this.directory, 'empty'),
            HOME: this.directory,
            TMPDIR: this.directory,
          },
        }
      : { env: process.env };
  }
  start(configuration: string): ChildProcessWithoutNullStreams {
    const [command, ...args] = this.command(configuration);
    return spawn(command!, args, this.options());
  }
  second(configuration: string, input: string): ReturnType<typeof spawnSync> {
    const [command, ...args] = this.command(configuration);
    return spawnSync(command!, args, { ...this.options(), encoding: 'utf8', input, timeout: 8000 });
  }
  verify(): void {
    assert.equal(existsSync(join(this.directory, 'ambient-canary')), false);
  }
}
/** Data-only protocol fixture, never live authority or a Kata assignment. */
export interface GuestFixturePreparation {
  configure(record: CapacityDispatch, configuration: Record<string, unknown>): void;
}
export class GuestProgramFixture {
  private static readonly data = {
    schemaVersion: 'treeseed.capacity-dispatch/v1',
    reservationId: 'fixture.reservation',
    requestId: 'fixture.request',
    lease: {
      schemaVersion: 'treeseed.capacity-lease/v1',
      operation: 'capacity-probe',
      id: 'fixture.lease',
      assignmentId: 'fixture.assignment',
      sandboxId: 'fixture.sandbox',
      scope: {
        installationId: 'fixture.installation',
        installationDirectory: '/fixture/capacity',
        capacityProviderId: 'fixture.capacity',
        project: 'fixture.project',
        platformProfile: 'default',
        workerId: 'fixture.worker',
      },
      authority: {
        issuer: 'https://identity.example.invalid/realms/fixture',
        subject: 'fixture.subject',
        teamId: 'fixture.team',
        providerId: 'fixture.capacity',
        credentialId: 'fixture.credential',
        credentialRevision: 1,
        grantId: 'fixture.grant',
        grantRevision: 1,
        capabilities: ['agent.probe'],
        state: 'granted',
        expiresAtEpochMs: 5000,
      },
      generations: {
        manager: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        worker: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        runner: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        pool: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sandbox: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        environment: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      compatibilityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fence: 1,
      expiresAtEpochMs: 4000,
    },
    definition: {
      schemaVersion: 'treeseed.agent-definition/v1',
      id: 'fixture.agent',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      profiles: [
        {
          id: 'fixture.check',
          typeId: 'external.health-probe',
          capabilityRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          handler: {
            providerId: 'fixture.handler',
            capability: 'agent.handler.probe',
            contractVersion: '1.0.0',
          },
          environmentId: 'fixture.environment',
          parameters: {
            message: 'harmless fixture',
          },
          dependsOn: [],
        },
      ],
    },
    profileId: 'fixture.check',
    environment: {
      schemaVersion: 'treeseed.agent-environment/v1',
      id: 'fixture.environment',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifact: {
        package: '@fixture/environment',
        version: '1.0.0',
        integrity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      image: {
        reference:
          'fixture/base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        manifestDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        os: 'linux',
        architecture: 'amd64',
      },
      setup: {
        file: {
          path: 'dist/setup',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 1,
        },
        arguments: [],
        deadlineMs: 30000,
        outputLimitBytes: 4096,
      },
      verification: {
        file: {
          path: 'dist/setup',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 1,
        },
        arguments: [],
        deadlineMs: 30000,
        outputLimitBytes: 4096,
      },
    },
    input: 'harmless fixture',
  };
  readonly directory = mkdtempSync(join(tmpdir(), 'guest-program-'));
  readonly assignmentFile = join(this.directory, 'assignment.json');
  readonly configurationFile = join(this.directory, 'guest.json');
  readonly record: CapacityDispatch;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly launcher: GuestProgramLauncher;
  private buffered = '';
  private error = '';
  private readonly replies: CapacityChannelResponse[] = [];
  private readonly waiting: ((reply: CapacityChannelResponse) => void)[] = [];
  constructor(
    preparation?: GuestFixturePreparation,
    standalone = process.argv.includes('--standalone'),
  ) {
    this.launcher = new GuestProgramLauncher(standalone);
    this.record = CapacityProtocolSchemas.dispatch.parse(structuredClone(GuestProgramFixture.data));
    this.configure(preparation);
    this.child = this.launcher.start(this.configurationFile);
    this.child.stdout.on('data', this.output.bind(this));
    this.child.stderr.on('data', this.errors.bind(this));
  }
  private configure(preparation?: GuestFixturePreparation): void {
    this.record.lease.scope.installationDirectory = this.directory;
    this.record.lease.expiresAtEpochMs = Date.now() + 30000;
    this.record.lease.authority.expiresAtEpochMs = Date.now() + 60000;
    this.defaultProfile();
    const configuration: Record<string, unknown> = {
      schemaVersion: 'treeseed.guest-configuration/v1',
      scope: this.record.lease.scope,
      assignmentFile: this.assignmentFile,
    };
    preparation?.configure(this.record, configuration);
    writeFileSync(this.configurationFile, JSON.stringify(configuration), { mode: 0o600 });
  }
  private defaultProfile(): void {
    const profile = this.record.definition.profiles[0]!;
    profile.typeId = 'probe.echo';
    profile.parameters = {};
    profile.capabilityRevision = GuestProfilePlugin.revision;
    profile.handler = structuredClone(GuestProfilePlugin.capability.handler);
  }
  private errors(bytes: Buffer): void {
    this.error += bytes.toString();
  }
  private output(bytes: Buffer): void {
    this.buffered += bytes.toString();
    while (this.buffered.includes('\n')) this.frame();
  }
  private frame(): void {
    const end = this.buffered.indexOf('\n');
    const reply = CapacityChannelSchemas.response.parse(JSON.parse(this.buffered.slice(0, end)));
    this.buffered = this.buffered.slice(end + 1);
    const pending = this.waiting.shift();
    if (pending) pending(reply);
    else this.replies.push(reply);
  }
  private response(resolve: (reply: CapacityChannelResponse) => void): void {
    const reply = this.replies.shift();
    if (reply) resolve(reply);
    else this.waiting.push(resolve);
  }
  request(
    operation: 'ready' | 'run' | 'cancel',
    expectedGeneration: unknown,
    record = this.record,
  ): Promise<CapacityChannelResponse> {
    const parameters =
      operation === 'run'
        ? { request: record }
        : operation === 'cancel'
          ? { lease: record.lease }
          : {};
    this.child.stdin.write(this.encoded(operation, expectedGeneration, parameters));
    return new Promise(this.response.bind(this));
  }
  private encoded(operation: string, expectedGeneration: unknown, parameters: object): string {
    return (
      JSON.stringify({
        schemaVersion: 'treeseed.capacity-channel/v1',
        requestId: 'fixture.' + operation,
        scope: this.record.lease.scope,
        role: 'runner',
        operation,
        expectedGeneration,
        parameters,
      }) + '\n'
    );
  }
  publish(): void {
    writeFileSync(this.assignmentFile, JSON.stringify(this.record), { mode: 0o600 });
  }
  async close(expected = 0): Promise<void> {
    const exited = once(this.child, 'exit');
    this.child.stdin.end();
    const [code] = await exited;
    assert.equal(code, expected, this.error);
    if (expected === 0) assert.equal(this.error, '');
    this.launcher.verify();
  }
  kill(): void {
    this.child.kill('SIGKILL');
  }
  async normal(): Promise<void> {
    const ready = await this.request('ready', null);
    assert.equal(ready.success, true);
    assert.equal(existsSync(this.assignmentFile), false);
    assert.match(ready.generation.processGeneration, /^[a-f0-9]{64}$/);
    this.anotherProcess(ready);
    this.record.lease.generations.runner = ready.generation;
    this.publish();
    const response = await this.request('run', ready.generation);
    assert.equal(response.success, true);
    if (response.success && response.operation === 'run') {
      assert.equal(response.result.state, 'completed');
      assert.equal(response.result.output, this.record.input);
      assert.deepEqual(response.result.lease, this.record.lease);
    }
    const repeated = await this.request('run', ready.generation);
    assert.equal(repeated.success, false);
    await this.close();
  }
  private anotherProcess(ready: CapacityChannelResponse): void {
    const input = {
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId: 'fixture.ready',
      scope: this.record.lease.scope,
      role: 'runner',
      operation: 'ready',
      expectedGeneration: null,
      parameters: {},
    };
    const second = this.launcher.second(this.configurationFile, JSON.stringify(input) + '\n');
    assert.equal(second.status, 0, String(second.stderr));
    const response = CapacityChannelSchemas.response.parse(JSON.parse(String(second.stdout)));
    assert.equal(response.generation.compositionGeneration, ready.generation.compositionGeneration);
    assert.notEqual(response.generation.processGeneration, ready.generation.processGeneration);
  }
  async denied(): Promise<void> {
    const ready = await this.request('ready', null);
    this.record.lease.generations.runner = ready.generation;
    const mode = process.argv[2];
    if (mode === '--foreign') {
      this.publish();
      const changed = structuredClone(this.record);
      changed.input = 'foreign-output-canary';
      this.assertDenied(await this.request('run', ready.generation, changed));
    } else {
      if (mode === '--ungranted') {
        this.record.lease.authority.capabilities = [];
        this.publish();
      }
      this.assertDenied(await this.request('run', ready.generation));
    }
    await this.close();
  }
  private assertDenied(reply: CapacityChannelResponse): void {
    assert.equal(reply.success, false);
    assert(!JSON.stringify(reply).includes('foreign-output-canary'));
  }
  async cancelled(): Promise<void> {
    const ready = await this.request('ready', null);
    this.record.lease.generations.runner = ready.generation;
    this.publish();
    const run = new Promise<CapacityChannelResponse>(this.response.bind(this));
    const cancel = new Promise<CapacityChannelResponse>(this.response.bind(this));
    this.child.stdin.write(
      this.encoded('run', ready.generation, { request: this.record }) +
        this.encoded('cancel', ready.generation, { lease: this.record.lease }),
    );
    const responses = await Promise.all([run, cancel]);
    for (const response of responses) {
      if (
        response.success &&
        response.role === 'runner' &&
        (response.operation === 'run' || response.operation === 'cancel')
      )
        assert.notEqual(response.result.state, 'completed');
    }
    await this.close();
  }
  async malformed(): Promise<void> {
    await this.request('ready', null);
    this.child.stdin.write('{"secret-output-canary":1,"secret-output-canary":2}\n');
    await this.close(2);
    assert.equal(this.error, 'INVALID_CAPACITY_CONTRACT\n');
  }
}
class GuestProgramAcceptance {
  async run(): Promise<void> {
    const fixture = new GuestProgramFixture();
    const timer = setTimeout(fixture.kill.bind(fixture), 8000);
    try {
      const mode = process.argv[2];
      if (['--deny', '--foreign', '--ungranted'].includes(mode!)) await fixture.denied();
      else if (mode === '--cancel') await fixture.cancelled();
      else if (mode === '--malformed') await fixture.malformed();
      else await fixture.normal();
    } finally {
      clearTimeout(timer);
      fixture.kill();
    }
    process.stdout.write('guest-program-ok\n');
  }
}
if (import.meta.main) await new GuestProgramAcceptance().run();
