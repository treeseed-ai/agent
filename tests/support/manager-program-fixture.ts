import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import * as Manager from '@treeseed-cordis/agent/manager-service';
import { CapacityChannelSchemas, CapacityContractError } from '@treeseed-cordis/sdk';
import { ProviderRegistrationFixture } from './provider-registration-program.js';
interface ManagerService {
  readonly generation: object;
  handle(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}
interface ManagerRoot {
  start(input: unknown): Promise<ManagerService>;
}
/** Real signed HTTPS receiver and actual manager program; no injected owner collaborators. */
export class ManagerProgramFixture extends ProviderRegistrationFixture {
  private child: ChildProcess | null = null;
  private signalled = false;
  readonly scope = {
    installationId: 'fixture.installation',
    installationDirectory: this.directory,
    capacityProviderId: 'fixture-provider',
    project: 'fixture.project',
    platformProfile: 'default',
    workerId: 'fixture.worker',
  };
  constructor(readonly scenario: string) {
    super(scenario === 'foreign' ? 'foreign' : 'status');
  }
  override async start(): Promise<void> {
    await super.start();
    const connection = JSON.parse(readFileSync(this.inputFile, 'utf8'));
    writeFileSync(
      this.inputFile,
      JSON.stringify({
        ...connection,
        scope: this.scope,
        schemaVersion: 'treeseed.manager-configuration/v1',
        registrationId: 'fixture-request',
      }),
      { mode: 0o600 },
    );
    if (this.scenario === 'permissions') chmodSync(this.inputFile, 0o644);
  }
  static request(scope: object): object {
    return {
      schemaVersion: 'treeseed.capacity-channel/v1',
      requestId: 'fixture.manager',
      scope,
      role: 'manager',
      operation: 'ready',
      expectedGeneration: null,
      parameters: {},
    };
  }
  override async program(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = this.launch();
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout!.on('data', this.output.bind(this, output));
    child.stderr!.on('data', errors.push.bind(errors));
    this.send();
    const [code] = await once(child, 'close');
    return {
      code,
      stdout: Buffer.concat(output).toString(),
      stderr: Buffer.concat(errors).toString(),
    };
  }
  private launch(): ChildProcess {
    const args = ['root', 'foreign', 'composition'].includes(this.scenario)
      ? [
          resolve('dist/tests/support/manager-program-fixture.js'),
          '--library',
          this.inputFile,
          this.scenario,
        ]
      : [resolve('dist/src/manager-main.js'), '--config', this.inputFile];
    this.child = spawn('node', args, {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(this.directory, 'cert.pem') },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return this.child;
  }
  private output(chunks: Buffer[], bytes: Buffer): void {
    chunks.push(bytes);
    if (this.scenario === 'signal' && !this.signalled && Buffer.concat(chunks).includes(10)) {
      this.signalled = true;
      this.child!.kill('SIGTERM');
    }
  }
  private send(): void {
    const frame = this.frame();
    if (['root', 'foreign', 'composition', 'permissions'].includes(this.scenario)) {
      this.child!.stdin!.end();
      return;
    }
    if (this.scenario === 'signal') this.child!.stdin!.write(frame);
    else this.child!.stdin!.end(frame);
  }
  private frame(): string {
    const request = ManagerProgramFixture.request(this.scope) as Record<string, unknown>;
    if (this.scenario === 'scope') request.scope = { ...this.scope, project: 'foreign' };
    if (this.scenario === 'role') request.role = 'worker';
    if (this.scenario === 'generation')
      request.expectedGeneration = {
        compositionGeneration: 'f'.repeat(64),
        processGeneration: 'f'.repeat(64),
      };
    return this.scenario === 'malformed'
      ? '{"private":"CANARY","private":1}\n'
      : this.scenario === 'oversize'
        ? 'x'.repeat(65537)
        : JSON.stringify(request) + '\n';
  }
  override async close(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const closed = once(this.child, 'close');
      this.child.kill('SIGKILL');
      await closed;
    }
    await super.close();
  }
}
class ManagerLibraryProgram {
  async run(): Promise<void> {
    const Root = Reflect.get(Manager, 'CapacityManagerService') as ManagerRoot;
    assert(Root && typeof Root.start === 'function', 'default manager native root missing');
    const configuration = JSON.parse(readFileSync(process.argv[3]!, 'utf8'));
    const manager = await Root.start(configuration);
    try {
      if (process.argv[4] === 'composition') this.composition(manager);
      else await this.observe(manager, configuration.scope);
    } finally {
      await manager.close();
    }
    process.stdout.write('manager-library-' + process.argv[4] + '-ok\n');
  }
  private composition(manager: ManagerService): void {
    assert.match(Reflect.get(manager.generation, 'compositionGeneration'), /^[a-f0-9]{64}$/);
    assert.match(Reflect.get(manager.generation, 'processGeneration'), /^[a-f0-9]{64}$/);
  }
  private async observe(manager: ManagerService, scope: object): Promise<void> {
    const response = CapacityChannelSchemas.response.parse(
      await manager.handle(ManagerProgramFixture.request(scope)),
    );
    assert.deepEqual(response.generation, manager.generation);
    assert.equal(response.role, 'manager');
    this.result(response);
  }
  private result(response: ReturnType<typeof CapacityChannelSchemas.response.parse>): void {
    if (process.argv[4] === 'foreign') {
      assert.equal(response.success, false);
      if (response.success) throw new Error('Foreign registration accepted');
      assert.equal(response.problem.code, 'CAPACITY_SCOPE_MISMATCH');
    } else {
      assert.equal(response.success, true);
      if (!response.success || response.operation !== 'ready')
        throw new Error('Readiness observation failed');
      assert.equal(response.result.ready, false);
      assert.deepEqual(response.result.blockers, [
        new CapacityContractError('CAPACITY_TARGET_UNREADY').blocker(),
      ]);
    }
  }
}
if (import.meta.main) await new ManagerLibraryProgram().run();
