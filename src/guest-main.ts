import { once } from 'node:events';
import { CapacityContractError, CapacityChannelSchemas, CanonicalJson } from '@treeseed-cordis/sdk';
import { InstalledProviderLoader } from '@treeseed-cordis/sdk/runtime';
import { AgentPrivateFile } from './authority.js';
import { CapacityGuest } from './guest.js';
/** Guest-owned stdio protocol only; no host scripts, socket or runtime access. */
class GuestProgram {
  private buffered = Buffer.alloc(0);
  private readonly pending = new Set<Promise<void>>();
  private failed = false;
  private readonly interrupt: () => void;
  constructor(private readonly guest: CapacityGuest) {
    this.interrupt = this.cancel.bind(this);
  }
  static async main(): Promise<void> {
    let program: GuestProgram | null = null;
    try {
      if (process.argv.length !== 4 || process.argv[2] !== '--config')
        throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
      program = new GuestProgram(
        await CapacityGuest.start(AgentPrivateFile.read(process.argv[3]!)),
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
    for await (const input of process.stdin) this.data(Buffer.from(input));
    if (this.buffered.length) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    await Promise.all(this.pending);
    if (this.failed) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
  }
  private data(bytes: Buffer): void {
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
    const response = await this.guest.handle(input);
    if (!process.stdout.write(CanonicalJson.stringify(response) + '\n'))
      await once(process.stdout, 'drain');
  }
  private settled(response: Promise<void>): void {
    this.pending.delete(response);
  }
  private rejected(response: Promise<void>): void {
    this.pending.delete(response);
    this.failed = true;
    process.stdin.destroy();
    this.cancel();
  }
  private cancel(): void {
    process.stdin.destroy();
    void this.guest.close().catch(this.cleanupFailed.bind(this));
  }
  private cleanupFailed(): void {
    process.exitCode = 1;
  }
  private async close(): Promise<void> {
    process.off('SIGTERM', this.interrupt);
    process.off('SIGINT', this.interrupt);
    try {
      await this.guest.close();
    } catch {
      process.stderr.write('CAPACITY_CLEANUP_FAILED\n');
      process.exitCode = 1;
    }
    await Promise.allSettled(this.pending);
  }
}
await GuestProgram.main();
