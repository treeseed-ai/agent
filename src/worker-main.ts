import { once } from 'node:events';
import { CapacityContractError, CapacityChannelSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
import { InstalledProviderLoader } from '@treeseed-cordis/sdk/runtime';
import { AgentPrivateFile } from './authority.js';
import { CapacityWorkerService } from './worker-service.js';
/** Separate process framing; no pool admission, authority invention or raw runtime access. */
class WorkerProgram {
  private buffered = Buffer.alloc(0);
  private readonly pending = new Set<Promise<void>>();
  private interrupted = false;
  private failed = false;
  private readonly interrupt: () => void;
  constructor(private readonly worker: CapacityWorkerService) {
    this.interrupt = this.cancel.bind(this);
  }
  static async main(): Promise<void> {
    let program: WorkerProgram | null = null;
    try {
      if (process.argv.length !== 4 || process.argv[2] !== '--config')
        throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
      program = new WorkerProgram(
        await CapacityWorkerService.start(AgentPrivateFile.read(process.argv[3]!)),
      );
      await program.run();
    } catch (error) {
      const invalid =
        !program ||
        (error instanceof CapacityContractError && error.code === 'INVALID_CAPACITY_CONTRACT');
      process.stderr.write(invalid ? 'INVALID_CAPACITY_CONTRACT\n' : 'CAPACITY_TARGET_UNREADY\n');
      process.exitCode = invalid ? 2 : 1;
    } finally {
      await program?.close();
    }
  }
  private async run(): Promise<void> {
    process.on('SIGTERM', this.interrupt);
    process.on('SIGINT', this.interrupt);
    try {
      for await (const input of process.stdin) this.data(Buffer.from(input));
    } catch (error) {
      if (!this.interrupted) throw error;
    }
    if (this.buffered.length && !this.interrupted)
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    await Promise.all(this.pending);
    if (this.failed) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
  }
  private data(bytes: Buffer): void {
    if (this.interrupted) return;
    this.buffered = Buffer.concat([this.buffered, bytes]);
    while (this.buffered.includes(10)) this.frame();
    if (this.buffered.length > 65536) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
  }
  private frame(): void {
    const end = this.buffered.indexOf(10);
    if (end === 0 || end > 65536 || this.pending.size >= 16)
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    const input = this.parse(this.buffered.subarray(0, end));
    this.buffered = this.buffered.subarray(end + 1);
    const response = this.respond(input);
    this.pending.add(response);
    void response.then(this.settled.bind(this, response), this.rejected.bind(this, response));
  }
  private parse(bytes: Buffer): unknown {
    try {
      return CapacityChannelSchemas.request.parse(InstalledProviderLoader.json(bytes));
    } catch {
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    }
  }
  private async respond(input: unknown): Promise<void> {
    const response = await this.worker.handle(input);
    const bytes = CanonicalJson.stringify(response) + '\n';
    if (Buffer.byteLength(bytes) > 65536)
      throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    if (!process.stdout.write(bytes))
      await once(process.stdout, 'drain', { signal: AbortSignal.timeout(10000) });
  }
  private settled(response: Promise<void>): void {
    this.pending.delete(response);
  }
  private rejected(response: Promise<void>): void {
    this.pending.delete(response);
    this.failed = true;
    this.cancel();
  }
  private cancel(): void {
    this.interrupted = true;
    process.stdin.destroy();
    void this.worker.close().catch(this.cleanupFailed.bind(this));
  }
  private cleanupFailed(): void {
    process.exitCode = 1;
  }
  private async close(): Promise<void> {
    process.off('SIGTERM', this.interrupt);
    process.off('SIGINT', this.interrupt);
    try {
      await this.worker.close();
    } catch {
      process.stderr.write('CAPACITY_CLEANUP_FAILED\n');
      process.exitCode = 1;
    }
    await Promise.allSettled(this.pending);
  }
}
if (import.meta.main) await WorkerProgram.main();
