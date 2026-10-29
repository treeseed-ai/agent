import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CanonicalJson,
  SandboxControlSchemas,
  SandboxRunnerSchemas,
  type SandboxControlRequest,
  type SandboxRunnerRequest,
  type CapacityProcessGeneration,
  type SandboxEvidence,
  type CapacityReadiness,
  type SandboxDestructionReceipt,
  type SandboxAvailability,
} from '@treeseed-cordis/sdk';
import type { ProviderLease } from '@treeseed-cordis/sdk/runtime';
interface WorkerEvidence {
  sandbox: SandboxEvidence;
  runner: CapacityReadiness;
  hostConfigurationDigest: string;
}
interface WorkerHost {
  ready(signal: AbortSignal): Promise<SandboxAvailability>;
  create(id: string, signal: AbortSignal): Promise<WorkerEvidence>;
  inspect(
    id: string,
    expected: CapacityProcessGeneration | null,
    signal: AbortSignal,
  ): Promise<WorkerEvidence>;
  destroy(id: string, signal: AbortSignal): Promise<SandboxDestructionReceipt>;
}
interface WorkerRoot {
  acquireSandbox(): Promise<ProviderLease<WorkerHost>>;
  close(): Promise<void>;
}
interface WorkerFactory {
  start(input: unknown): Promise<WorkerRoot>;
}
/** External service protocol fixture only: never an actual Kata sandbox or capacity claim. */
export class WorkerHostFixture {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'worker-host-fixture-')));
  readonly scope = {
    installationId: 'fixture.installation',
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
    serviceGeneration: 'b'.repeat(64),
  };
  readonly capacityScope = {
    installationId: this.scope.installationId,
    installationDirectory: this.directory,
    capacityProviderId: 'fixture.provider',
    project: 'fixture.project',
    platformProfile: 'fixture.default',
    workerId: 'fixture.worker',
  };
  readonly generation = {
    compositionGeneration: 'c'.repeat(64),
    processGeneration: 'd'.repeat(64),
  };
  private readonly server = createServer(this.connected.bind(this));
  private readonly sockets = new Map<Socket, Buffer>();
  private readonly bases = new Set<string>();
  private creates = 0;
  private requests = 0;
  private replies = 0;
  private failure: string | null = null;
  readonly inputFile = join(this.directory, 'configuration.json');
  constructor(readonly mode: string) {
    this.files();
  }
  private files(): void {
    const authorityFile = join(this.directory, 'authority.json');
    writeFileSync(authorityFile, JSON.stringify(this.authority()), { mode: 0o600 });
    writeFileSync(
      this.inputFile,
      JSON.stringify({
        scope: this.capacityScope,
        hostScope:
          this.mode === 'bad-configuration'
            ? { ...this.scope, installationId: 'foreign' }
            : this.scope,
        hostConfigurationDigest: 'e'.repeat(64),
        endpointDirectory: this.directory,
        authorityFile,
        timeoutMs: 500,
      }),
      { mode: 0o600 },
    );
  }
  private authority(): object {
    return {
      credential: 'f'.repeat(64),
      grant: {
        schemaVersion: 'treeseed.sandbox-grant/v1',
        id: 'grant:control',
        revision: 1,
        scope: this.scope,
        state: 'granted',
        expiresAtEpochMs: Date.now() + 60000,
        operations: ['ready', 'create', 'inspect', 'destroy'],
      },
      runnerGrant: this.runnerGrant(),
    };
  }
  private runnerGrant(): object {
    return {
      schemaVersion: 'treeseed.sandbox-runner-grant/v1',
      id: 'grant:runner',
      revision: 1,
      scope: this.mode === 'wrong-grant' ? { ...this.scope, serviceId: 'foreign' } : this.scope,
      capacityScope: this.capacityScope,
      state: 'granted',
      expiresAtEpochMs: Date.now() + 60000,
      operations: ['ready'],
    };
  }
  async start(): Promise<void> {
    const ready = once(this.server, 'listening');
    this.server.listen(join(this.directory, 'control.sock'));
    await ready;
    chmodSync(join(this.directory, 'control.sock'), 0o600);
  }
  private connected(socket: Socket): void {
    this.sockets.set(socket, Buffer.alloc(0));
    socket.on('data', this.data.bind(this, socket));
    socket.once('close', this.closed.bind(this, socket));
  }
  private closed(socket: Socket): void {
    this.sockets.delete(socket);
  }
  private data(socket: Socket, bytes: Buffer): void {
    const before = this.sockets.get(socket)!;
    if (before.length + bytes.length > 65536) {
      socket.destroy();
      return;
    }
    const combined = Buffer.concat([before, bytes]);
    this.sockets.set(socket, combined);
    if (!combined.includes(10)) return;
    try {
      this.reply(socket, combined);
    } catch {
      this.failure = 'fixture-protocol-failure';
      socket.destroy();
    }
  }
  private reply(socket: Socket, bytes: Buffer): void {
    this.requests++;
    assert.equal(bytes.indexOf(10), bytes.length - 1);
    const frame = JSON.parse(bytes.toString());
    assert.equal(frame.credential, 'f'.repeat(64));
    if (this.mode === 'malformed') {
      socket.end('{"private":"PRIVATE_WORKER_CANARY"}\n');
      return;
    }
    if (this.mode === 'silent-ready') return;
    const request = frame.request;
    const response =
      request.schemaVersion === 'treeseed.sandbox-control/v1'
        ? this.control(SandboxControlSchemas.request.parse(request))
        : this.runner(SandboxRunnerSchemas.request.parse(request));
    socket.end(CanonicalJson.stringify(response) + '\n');
  }
  private control(request: SandboxControlRequest): object {
    const common = {
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope: request.scope,
      operation: request.operation,
      success: true,
      problem: null,
    };
    return { ...common, result: this.controlResult(request) };
  }
  private controlResult(request: SandboxControlRequest): object {
    if (request.operation === 'ready') return this.availability();
    assert(
      request.operation === 'create' ||
        request.operation === 'inspect' ||
        request.operation === 'destroy',
    );
    const id = request.parameters.sandboxId;
    if (request.operation === 'create') {
      this.creates++;
      this.bases.add(id);
    }
    assert(this.bases.has(id));
    if (request.operation === 'destroy') return this.destroyed(id);
    return this.evidence(id);
  }
  private destroyed(id: string): object {
    this.bases.delete(id);
    return { sandboxId: id, destroyed: true, inspectionDigest: '1'.repeat(64) };
  }
  private availability(): object {
    const moved = this.mode === 'foreign-host' || (this.mode === 'moved-host' && this.creates > 0);
    return {
      state: 'available',
      configurationDigest: (moved ? '9' : 'e').repeat(64),
      capabilityVersion: '1.0.0-cordis.1',
    };
  }
  private evidence(id: string): object {
    return {
      sandboxId: this.mode === 'foreign-sandbox' ? 'sandbox-' + randomUUID() : id,
      inspectionDigest: '2'.repeat(64),
      assignment:
        this.mode === 'assigned'
          ? {
              sandboxId: id,
              assignmentId: 'fixture.assignment',
              environmentId: 'fixture.environment',
              environmentDigest: '3'.repeat(64),
              environmentRevision: '4'.repeat(64),
            }
          : null,
    };
  }
  private runner(request: SandboxRunnerRequest): object {
    assert(this.bases.has(request.sandboxId));
    const common = {
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope: request.scope,
      sandboxId: request.sandboxId,
    };
    if (this.mode === 'missing-runner')
      return {
        ...common,
        success: false,
        result: null,
        problem: { code: 'SANDBOX_PROVIDER_UNAVAILABLE' },
      };
    return { ...common, success: true, result: this.frame(request), problem: null };
  }
  private readiness(): CapacityReadiness {
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      role: 'runner',
      scope:
        this.mode === 'foreign-scope'
          ? { ...this.capacityScope, workerId: 'foreign' }
          : this.capacityScope,
      generation:
        this.mode === 'changed-generation' && this.replies > 1
          ? { ...this.generation, processGeneration: '8'.repeat(64) }
          : this.generation,
      ready: true,
      blockers: [],
    });
  }
  private frame(request: SandboxRunnerRequest): object {
    this.replies++;
    const ready = this.readiness();
    return CapacityChannelSchemas.response.parse({
      schemaVersion: request.frame.schemaVersion,
      requestId: request.requestId,
      scope: ready.scope,
      role: 'runner',
      operation: 'ready',
      generation: ready.generation,
      success: true,
      result: ready,
      problem: null,
    });
  }
  get observations(): number {
    return this.requests;
  }
  assertIdle(requests: number): void {
    assert.equal(this.failure, null);
    assert.equal(this.requests, requests);
    assert.equal(this.creates, 0);
    assert.equal(this.bases.size, 0);
  }
  verify(): void {
    assert.equal(this.failure, null);
    if (this.mode === 'accepted') {
      assert.equal(this.creates, 1);
      assert.equal(this.bases.size, 0);
    }
    if (
      ['foreign-host', 'cancel', 'bad-configuration', 'wrong-grant', 'malformed'].includes(
        this.mode,
      )
    )
      assert.equal(this.creates, 0);
    if (this.mode === 'moved-host')
      assert.equal(this.bases.size, 1, 'uncertain old-generation state requires explicit repair');
    else assert.equal(this.bases.size, 0);
  }
  async program(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(
      'node',
      [resolve('dist/tests/support/worker-sandbox-program.js'), this.inputFile, this.mode],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', output.push.bind(output));
    child.stderr.on('data', errors.push.bind(errors));
    const [code] = await once(child, 'close');
    return {
      code,
      stdout: Buffer.concat(output).toString(),
      stderr: Buffer.concat(errors).toString(),
    };
  }
  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy();
    if (this.server.listening) {
      const closed = once(this.server, 'close');
      this.server.close();
      await closed;
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class WorkerSandboxProgram {
  private root: WorkerRoot | null = null;
  private lease: ProviderLease<WorkerHost> | null = null;
  private readonly controller = new AbortController();
  private readonly id = 'sandbox-' + randomUUID();
  async run(): Promise<void> {
    const module = await import('@treeseed-cordis/agent/worker');
    const Root = Reflect.get(module, 'WorkerApplication') as WorkerFactory;
    assert(Root && typeof Root.start === 'function', 'native worker composition root missing');
    const configuration = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
    if (process.argv[3] === 'bad-configuration') {
      await assert.rejects(Root.start(configuration), this.safe.bind(this));
      process.stdout.write('worker-sandbox-refused\n');
      return;
    }
    this.root = await Root.start(configuration);
    try {
      this.lease = await this.root.acquireSandbox();
      await this.exercise();
    } finally {
      await this.lease?.release();
      await this.root.close();
    }
  }
  private async exercise(): Promise<void> {
    if (process.argv[3] === 'cancel') this.controller.abort();
    if (process.argv[3] !== 'accepted') {
      await assert.rejects(this.operations(), this.safe.bind(this));
      if (
        !['foreign-host', 'moved-host', 'cancel', 'wrong-grant', 'malformed'].includes(
          process.argv[3]!,
        )
      )
        await this.lease!.value.destroy(this.id, new AbortController().signal);
      process.stdout.write('worker-sandbox-refused\n');
      return;
    }
    await this.operations();
    await this.lease!.release();
    await this.root!.close();
    assert.throws(this.lease!.assertOpen.bind(this.lease));
    await assert.rejects(this.root!.acquireSandbox(), this.safe.bind(this));
    process.stdout.write('worker-sandbox-ok\n');
  }
  private async operations(): Promise<void> {
    const host = this.lease!.value,
      signal = this.controller.signal;
    assert.equal((await host.ready(signal)).state, 'available');
    const first = await host.create(this.id, signal);
    assert.equal(first.sandbox.assignment, null);
    assert.equal(first.runner.ready, true);
    assert.equal(first.hostConfigurationDigest, 'e'.repeat(64));
    const inspected = await host.inspect(this.id, first.runner.generation, signal);
    assert.deepEqual(inspected.runner.generation, first.runner.generation);
    const destroyed = await host.destroy(this.id, signal);
    assert.equal(destroyed.sandboxId, this.id);
    assert.equal(destroyed.destroyed, true);
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.match(error.message, /^(?:INVALID_)?SANDBOX_[A-Z_]+$/);
    assert(!error.message.includes('PRIVATE_WORKER_CANARY'));
    return true;
  }
}
if (import.meta.main) await new WorkerSandboxProgram().run();
