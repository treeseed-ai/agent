import { randomUUID } from 'node:crypto';
import {
  PoolSchemas,
  PlatformSchemas,
  SeedSchemas,
  type PoolPolicy,
  type VirginSandbox,
} from '@treeseed-cordis/sdk';

export interface SandboxDestruction {
  id: string;
  verified: boolean;
  inspectionDigest: string;
}
export interface SandboxPoolProvider {
  create(id: string, compatibilityDigest: string, signal: AbortSignal): Promise<VirginSandbox>;
  inspect(base: VirginSandbox, signal: AbortSignal): Promise<VirginSandbox>;
  assign(base: VirginSandbox, assignmentId: string, signal: AbortSignal): Promise<void>;
  destroy(id: string): Promise<SandboxDestruction>;
}
export interface WarmPoolStatus {
  ready: number;
  assigned: number;
  claiming: number;
  allocated: number;
  quarantined: number;
  closing: boolean;
  backgroundFailure: boolean;
}
export class WarmPoolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WarmPoolError';
  }
}

export class SandboxClaim {
  private closed = false;
  private pending: Promise<void> | null = null;
  constructor(
    readonly id: string,
    readonly compatibilityDigest: string,
    private readonly release: () => Promise<void>,
  ) {}
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.pending) this.pending = this.dispose();
    return this.pending;
  }
  private async dispose(): Promise<void> {
    try {
      await this.release();
      this.closed = true;
    } finally {
      this.pending = null;
    }
  }
}

/** Worker policy only. Production sandbox custody and atomic assignment are provider obligations. */
export class WarmSandboxPool {
  private readonly policy: PoolPolicy;
  private readonly ready = new Map<string, VirginSandbox>();
  private readonly allocated = new Set<string>();
  private readonly assigned = new Set<string>();
  private readonly claiming = new Set<string>();
  private readonly quarantined = new Set<string>();
  private readonly controller = new AbortController();
  private closing = false;
  private warming: Promise<void> | null = null;
  private backgroundFailure = false;

  constructor(
    private readonly provider: SandboxPoolProvider,
    readonly compatibilityDigest: string,
    policy: PoolPolicy,
  ) {
    if (!PlatformSchemas.digest.safeParse(compatibilityDigest).success)
      throw new WarmPoolError('POOL_COMPATIBILITY_INVALID');
    const parsed = PoolSchemas.policy.safeParse(policy);
    if (!parsed.success) throw new WarmPoolError('POOL_POLICY_INVALID');
    this.policy = parsed.data;
  }
  status(): WarmPoolStatus {
    return {
      ready: this.ready.size,
      assigned: this.assigned.size,
      claiming: this.claiming.size,
      allocated: this.allocated.size,
      quarantined: this.quarantined.size,
      closing: this.closing,
      backgroundFailure: this.backgroundFailure,
    };
  }
  private admission(signal?: AbortSignal): void {
    if (signal?.aborted) throw new WarmPoolError('POOL_CANCELLED');
    if (this.closing) throw new WarmPoolError('POOL_CLOSED');
    if (this.quarantined.size) throw new WarmPoolError('POOL_QUARANTINED');
  }
  warm(): Promise<void> {
    this.admission();
    if (!this.warming) this.warming = this.refill().finally(this.warmed.bind(this));
    return this.warming;
  }
  private warmed(): void {
    this.warming = null;
  }
  private async refill(): Promise<void> {
    while (
      !this.closing &&
      this.ready.size < this.policy.warmTarget &&
      this.allocated.size < this.policy.maximumSandboxes
    )
      await this.create();
    this.backgroundFailure = false;
  }
  private async create(): Promise<void> {
    const id = 'sandbox-' + randomUUID();
    this.allocated.add(id);
    try {
      const created = await this.provider.create(
        id,
        this.compatibilityDigest,
        this.controller.signal,
      );
      const inspected = await this.inspected(id, created, this.controller.signal);
      if (this.closing) await this.destroy(id);
      else this.ready.set(id, inspected);
    } catch {
      await this.destroy(id);
      throw new WarmPoolError('POOL_CREATE_FAILED');
    }
  }
  private async inspected(
    id: string,
    base: VirginSandbox,
    signal: AbortSignal,
  ): Promise<VirginSandbox> {
    const created = this.base(id, base);
    const inspected = await this.provider.inspect(structuredClone(created), signal);
    return this.base(id, inspected);
  }
  private base(id: string, input: unknown): VirginSandbox {
    const parsed = PoolSchemas.base.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.compatibilityDigest !== this.compatibilityDigest
    )
      throw new WarmPoolError('POOL_BASE_INVALID');
    return parsed.data;
  }
  async claim(assignmentId: string, signal: AbortSignal): Promise<SandboxClaim> {
    this.admission(signal);
    if (!SeedSchemas.key.safeParse(assignmentId).success)
      throw new WarmPoolError('POOL_ASSIGNMENT_INVALID');
    const base = this.ready.values().next().value as VirginSandbox | undefined;
    if (!base) throw new WarmPoolError('POOL_EMPTY');
    this.ready.delete(base.id);
    this.claiming.add(base.id);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.policy.claimDeadlineMs)]);
    try {
      return await this.assign(base, assignmentId, deadline);
    } catch {
      await this.destroy(base.id);
      this.replenish();
      throw new WarmPoolError('POOL_CLAIM_FAILED');
    } finally {
      this.claiming.delete(base.id);
    }
  }
  private async assign(
    base: VirginSandbox,
    assignmentId: string,
    signal: AbortSignal,
  ): Promise<SandboxClaim> {
    const inspected = await this.inspected(base.id, base, signal);
    this.admission(signal);
    await this.provider.assign(structuredClone(inspected), assignmentId, signal);
    this.assigned.add(base.id);
    this.admission(signal);
    this.replenish();
    return new SandboxClaim(base.id, this.compatibilityDigest, this.release.bind(this, base.id));
  }
  private replenish(): void {
    if (this.closing || this.quarantined.size) return;
    void this.warm().catch(this.refillFailed.bind(this));
  }
  private refillFailed(): void {
    this.backgroundFailure = true;
  }
  private async release(id: string): Promise<void> {
    if (!this.assigned.has(id)) throw new WarmPoolError('POOL_CLAIM_UNKNOWN');
    await this.destroy(id);
    this.replenish();
  }
  private async destroy(id: string): Promise<void> {
    try {
      const receipt = await this.provider.destroy(id);
      if (
        receipt.id !== id ||
        receipt.verified !== true ||
        !PlatformSchemas.digest.safeParse(receipt.inspectionDigest).success
      )
        throw new WarmPoolError('POOL_TEARDOWN_UNVERIFIED');
      this.ready.delete(id);
      this.assigned.delete(id);
      this.allocated.delete(id);
      this.quarantined.delete(id);
    } catch {
      this.quarantined.add(id);
      throw new WarmPoolError('POOL_TEARDOWN_UNVERIFIED');
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.controller.abort();
    try {
      await this.warming;
    } catch {
      /* Continue disposing known bases. */
    }
    const failures: Error[] = [];
    for (const id of this.allocated) {
      if (this.assigned.has(id) || this.claiming.has(id)) continue;
      try {
        await this.destroy(id);
      } catch {
        failures.push(new WarmPoolError('POOL_TEARDOWN_UNVERIFIED'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'POOL_TEARDOWN_UNVERIFIED');
    if (this.assigned.size || this.claiming.size) throw new WarmPoolError('POOL_CLAIMS_ACTIVE');
    if (this.allocated.size) throw new WarmPoolError('POOL_TEARDOWN_UNVERIFIED');
  }
}
