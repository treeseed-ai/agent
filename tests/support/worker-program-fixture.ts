import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CapacityChannelSchemas, type CapacityProcessGeneration } from '@treeseed-cordis/sdk';
import { WorkerHostFixture } from './worker-sandbox-program.js';
/** Actual Node process; the peer remains an explicit Unix protocol fixture. */
class WorkerProgramChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: Buffer[] = [];
  private readonly errors: Buffer[] = [];
  private readonly ended: Promise<unknown[]>;
  constructor(file: string) {
    this.child = spawn('node', ['dist/src/worker-main.js', '--config', file], { timeout: 10000 });
    this.child.stdout.on('data', this.output.push.bind(this.output));
    this.child.stderr.on('data', this.errors.push.bind(this.errors));
    this.ended = once(this.child, 'close');
  }
  async run(input: string, signal = false) {
    try {
      if (signal) {
        this.child.stdin.write(input);
        await this.interrupt();
      } else this.child.stdin.end(input);
      const [code] = await this.ended;
      return {
        code,
        stdout: Buffer.concat(this.output).toString(),
        stderr: Buffer.concat(this.errors).toString(),
      };
    } finally {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill('SIGKILL');
    }
  }
  async first(input: string): Promise<ReturnType<typeof CapacityChannelSchemas.response.parse>> {
    this.child.stdin.write(input);
    return CapacityChannelSchemas.response.parse(JSON.parse(await this.initial()));
  }
  terminate(): void {
    this.child.kill('SIGTERM');
  }
  stop(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
  private async initial(): Promise<string> {
    const deadline = Date.now() + 5000;
    while (!Buffer.concat(this.output).includes(10)) {
      assert(Date.now() < deadline, 'worker did not produce its initial reply');
      assert.equal(this.child.exitCode, null);
      await delay(10);
    }
    return Buffer.concat(this.output).toString().split('\n')[0]!;
  }
  private async interrupt(): Promise<void> {
    await this.initial();
    this.child.kill('SIGTERM');
  }
}
export class WorkerProgramScenario {
  async run(mode: string): Promise<void> {
    const hostMode =
      mode === 'cancel-inflight'
        ? 'silent-ready'
        : mode === 'malformed-host'
          ? 'malformed'
          : mode === 'foreign-host'
            ? mode
            : 'accepted';
    const fixture = new WorkerHostFixture(hostMode);
    try {
      await fixture.start();
      this.configuration(fixture, mode);
      await this.exercise(fixture, mode);
    } finally {
      await fixture.close();
    }
  }
  private configuration(fixture: WorkerHostFixture, mode: string): void {
    const original = JSON.parse(readFileSync(fixture.inputFile, 'utf8'));
    writeFileSync(
      fixture.inputFile,
      JSON.stringify({ ...original, schemaVersion: 'treeseed.worker-configuration/v1' }),
      { mode: 0o600 },
    );
    if (mode === 'private-configuration') chmodSync(fixture.inputFile, 0o644);
  }
  private frame(fixture: WorkerHostFixture, mode: string): string {
    const frame = {
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId: 'fixture.worker.ready',
      scope:
        mode === 'foreign-scope'
          ? { ...fixture.capacityScope, workerId: 'foreign' }
          : fixture.capacityScope,
      role: mode === 'foreign-role' ? 'runner' : 'worker',
      operation: 'ready',
      expectedGeneration: mode === 'stale-generation' ? fixture.generation : null,
      parameters: {},
    };
    if (mode === 'malformed-frame') return '{"private":"PRIVATE_WORKER_CANARY","private":1}\n';
    if (mode === 'oversize') return 'x'.repeat(65537) + '\n';
    if (mode === 'truncated') return JSON.stringify(frame);
    return JSON.stringify(frame) + '\n';
  }
  private async exercise(fixture: WorkerHostFixture, mode: string): Promise<void> {
    if (mode === 'reserve') return this.reserve(fixture);
    if (mode === 'cancel-inflight') return this.cancel(fixture);
    const reply = await new WorkerProgramChild(fixture.inputFile).run(
      this.frame(fixture, mode),
      mode === 'signal',
    );
    assert(!JSON.stringify(reply).includes('PRIVATE_WORKER_CANARY'));
    if (['malformed-frame', 'oversize', 'truncated', 'private-configuration'].includes(mode)) {
      assert.deepEqual(reply, { code: 2, stdout: '', stderr: 'INVALID_CAPACITY_CONTRACT\n' });
      fixture.assertIdle(0);
      return;
    }
    assert.equal(reply.code, 0, reply.stderr);
    assert.equal(reply.stderr, '');
    const response = CapacityChannelSchemas.response.parse(JSON.parse(reply.stdout));
    await this.result(fixture, mode, response);
  }
  private async result(
    fixture: WorkerHostFixture,
    mode: string,
    response: ReturnType<typeof CapacityChannelSchemas.response.parse>,
  ): Promise<void> {
    assert.equal(response.role, mode === 'foreign-role' ? 'runner' : 'worker');
    assert.deepEqual(response.scope, fixture.capacityScope);
    if (
      [
        'foreign-scope',
        'foreign-role',
        'stale-generation',
        'foreign-host',
        'malformed-host',
      ].includes(mode)
    ) {
      this.denied(response, mode);
      fixture.assertIdle(['foreign-host', 'malformed-host'].includes(mode) ? 1 : 0);
      return;
    }
    this.blocked(response);
    if (mode === 'process-generation') await this.successor(fixture, response.generation);
    fixture.assertIdle(mode === 'process-generation' ? 2 : 1);
  }
  private denied(
    response: ReturnType<typeof CapacityChannelSchemas.response.parse>,
    mode: string,
  ): void {
    assert.equal(response.success, false);
    assert.equal(response.result, null);
    assert.equal(
      response.problem?.code,
      ['foreign-scope', 'foreign-role'].includes(mode)
        ? 'CAPACITY_SCOPE_MISMATCH'
        : mode === 'stale-generation'
          ? 'STALE_CAPACITY_GENERATION'
          : 'CAPACITY_TARGET_UNREADY',
    );
  }
  private blocked(response: ReturnType<typeof CapacityChannelSchemas.response.parse>): void {
    assert(response.success && response.operation === 'ready');
    assert.equal(response.result.ready, false);
    assert.equal(response.result.role, 'worker');
    assert.deepEqual(response.result.generation, response.generation);
    assert.deepEqual(response.result.blockers.map(WorkerProgramScenario.code), [
      'CAPACITY_TARGET_UNREADY',
    ]);
  }
  private static code(blocker: { code: string }): string {
    return blocker.code;
  }
  private async successor(
    fixture: WorkerHostFixture,
    generation: CapacityProcessGeneration,
  ): Promise<void> {
    const reply = await new WorkerProgramChild(fixture.inputFile).run(this.frame(fixture, 'ready'));
    assert.equal(reply.code, 0, reply.stderr);
    const response = CapacityChannelSchemas.response.parse(JSON.parse(reply.stdout));
    this.blocked(response);
    assert.equal(response.generation.compositionGeneration, generation.compositionGeneration);
    assert.notEqual(response.generation.processGeneration, generation.processGeneration);
  }
  private static readonly reserveEnvelope = {
    schemaVersion: 'treeseed.capacity-channel/v1',
    requestId: 'fixture.reserve',
    role: 'worker',
    operation: 'reserve',
  };
  private static readonly reserveData = {
    schemaVersion: 'treeseed.capacity-reserve/v1',
    requestId: 'fixture.request',
    assignmentId: 'fixture.assignment',
    leaseId: 'fixture.lease',
    compatibilityDigest: 'a'.repeat(64),
    fence: 1,
  };
  private static readonly authorityData = {
    issuer: 'https://identity.example.invalid/realms/fixture',
    subject: 'fixture.subject',
    teamId: 'fixture.team',
    credentialId: 'fixture.credential',
    credentialRevision: 1,
    grantId: 'fixture.grant',
    grantRevision: 1,
    capabilities: ['agent.probe'],
    state: 'granted',
  };
  private reserveFrame(fixture: WorkerHostFixture, generation: CapacityProcessGeneration): object {
    const request = {
      ...WorkerProgramScenario.reserveData,
      scope: fixture.capacityScope,
      authority: {
        ...WorkerProgramScenario.authorityData,
        providerId: fixture.capacityScope.capacityProviderId,
        expiresAtEpochMs: Date.now() + 60000,
      },
      manager: fixture.generation,
      expectedWorker: generation,
      expiresAtEpochMs: Date.now() + 30000,
    };
    return {
      ...WorkerProgramScenario.reserveEnvelope,
      scope: fixture.capacityScope,
      expectedGeneration: generation,
      parameters: { request },
    };
  }
  private async cancel(fixture: WorkerHostFixture): Promise<void> {
    const child = new WorkerProgramChild(fixture.inputFile);
    try {
      const pending = child.first(this.frame(fixture, 'ready'));
      await this.pendingObservation(fixture);
      child.terminate();
      const response = await pending;
      const result = await child.run('');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(response.success, false);
      assert.equal(response.problem?.code, 'CAPACITY_CANCELLED');
      fixture.assertIdle(1);
    } finally {
      child.stop();
    }
  }
  private async pendingObservation(fixture: WorkerHostFixture): Promise<void> {
    const deadline = Date.now() + 5000;
    while (fixture.observations === 0) {
      assert(Date.now() < deadline, 'worker observation was not admitted');
      await delay(10);
    }
  }
  private async reserve(fixture: WorkerHostFixture): Promise<void> {
    const child = new WorkerProgramChild(fixture.inputFile);
    try {
      const ready = await child.first(this.frame(fixture, 'ready'));
      this.blocked(ready);
      const frame = CapacityChannelSchemas.request.parse(
        this.reserveFrame(fixture, ready.generation),
      );
      const reply = await child.run(JSON.stringify(frame) + '\n');
      assert.equal(reply.code, 0, reply.stderr);
      assert.equal(reply.stderr, '');
      const rows = reply.stdout.trim().split('\n');
      assert.equal(rows.length, 2);
      const response = CapacityChannelSchemas.response.parse(JSON.parse(rows[1]!));
      assert.equal(response.success, false);
      assert.equal(response.result, null);
      assert.equal(response.problem?.code, 'CAPACITY_CAPABILITY_DENIED');
      fixture.assertIdle(1);
    } finally {
      child.stop();
    }
  }
}
