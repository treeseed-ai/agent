import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CapacitySchemas,
  CapacityChannelSchemas,
  CapacityChannelBinding,
  CapacityContractError,
  type CapacityChannelRequest,
  type CapacityChannelResponse,
  type CapacityProcessGeneration,
} from '@treeseed-cordis/sdk';
import { WorkerApplication } from './worker.js';
/** Worker-owned protocol admission; the native root retains provider resolution and disposal. */
export class CapacityWorkerService {
  static readonly Config = WorkerApplication.Config.extend({
    schemaVersion: z.literal('treeseed.worker-configuration/v1'),
  });
  private readonly nonce = randomBytes(32).toString('hex');
  private readonly controller = new AbortController();
  private closing: Promise<void> | null = null;
  private constructor(
    private readonly configuration: z.infer<typeof CapacityWorkerService.Config>,
    private readonly root: WorkerApplication,
  ) {}
  static async start(input: unknown): Promise<CapacityWorkerService> {
    const result = this.Config.safeParse(input);
    if (!result.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    try {
      const host = WorkerApplication.Config.parse(this.hostConfiguration(result.data));
      return new CapacityWorkerService(result.data, await WorkerApplication.start(host));
    } catch {
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    }
  }
  private static hostConfiguration(input: z.infer<typeof this.Config>): object {
    const { schemaVersion, ...host } = input;
    return host;
  }
  get generation(): CapacityProcessGeneration {
    return { compositionGeneration: this.root.generation, processGeneration: this.nonce };
  }
  private get context() {
    return {
      role: 'worker' as const,
      scope: this.configuration.scope,
      generation: this.generation,
    };
  }
  async handle(input: unknown): Promise<CapacityChannelResponse> {
    const parsed = CapacityChannelSchemas.request.safeParse(input);
    if (!parsed.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    try {
      const request = CapacityChannelBinding.assertRequest(parsed.data, this.context);
      if (this.closing) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
      if (request.operation !== 'ready')
        throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
      const readiness = await this.readiness();
      return this.response(request, true, readiness, null);
    } catch (error) {
      return this.response(parsed.data, false, null, this.failure(error).blocker());
    }
  }
  private async readiness(): Promise<unknown> {
    const lease = await this.root.acquireSandbox();
    try {
      lease.assertOpen();
      await lease.value.ready(this.controller.signal);
      if (this.closing || this.controller.signal.aborted)
        throw new CapacityContractError('CAPACITY_CANCELLED');
    } finally {
      try {
        await lease.release();
      } catch {
        throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
      }
    }
    return CapacitySchemas.readiness.parse({
      schemaVersion: 'treeseed.capacity-readiness/v1',
      ...this.context,
      ready: false,
      blockers: [new CapacityContractError('CAPACITY_TARGET_UNREADY').blocker()],
    });
  }
  private response(
    request: CapacityChannelRequest,
    success: boolean,
    result: unknown,
    problem: unknown,
  ): CapacityChannelResponse {
    return CapacityChannelSchemas.response.parse({
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      scope: this.configuration.scope,
      role: request.role,
      operation: request.operation,
      generation: this.generation,
      success,
      result,
      problem,
    });
  }
  private failure(error: unknown): CapacityContractError {
    if (this.controller.signal.aborted) return new CapacityContractError('CAPACITY_CANCELLED');
    try {
      if (error instanceof CapacityContractError) {
        const code = CapacitySchemas.code.safeParse(
          Object.getOwnPropertyDescriptor(error, 'code')?.value,
        );
        if (code.success) return new CapacityContractError(code.data);
      }
    } catch {
      /* Provider error objects cannot expose private state. */
    }
    return new CapacityContractError('CAPACITY_TARGET_UNREADY');
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort();
      this.closing = this.root.close();
    }
    return this.closing;
  }
}
