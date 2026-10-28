import assert from 'node:assert/strict';
import { PoolSchemas, type VirginSandbox } from '@treeseed-cordis/sdk';
import { WarmSandboxPool, type SandboxPoolProvider, type SandboxDestruction } from '../../src/warm-pool.js';

/** In-memory lifecycle fixture only. It does not create or attest a Kata sandbox. */
export class FixtureSandboxPool implements SandboxPoolProvider {
  readonly created: string[] = [];
  readonly assigned: string[] = [];
  readonly destroyed: string[] = [];
  readonly bases = new Map<string, VirginSandbox>();
  failDestroy = false;
  loseCreateReply = false;
  failAssign = false;
  failInspection = false;
  async create(id: string, compatibilityDigest: string, signal: AbortSignal): Promise<VirginSandbox> {
    signal.throwIfAborted();
    this.created.push(id);
    const base = PoolSchemas.base.parse({ schemaVersion: 'treeseed.virgin-sandbox/v1',
      id, compatibilityDigest, inspectionDigest: 'b'.repeat(64), credentials: 'absent', assigned: false });
    this.bases.set(id, base);
    if (this.loseCreateReply) throw new Error('private-create-canary');
    return structuredClone(base);
  }
  async inspect(base: VirginSandbox, signal: AbortSignal): Promise<VirginSandbox> {
    signal.throwIfAborted();
    assert(this.bases.has(base.id));
    assert(!this.assigned.includes(base.id));
    if (this.failInspection) throw new Error('private-inspection-canary');
    return structuredClone(base);
  }
  async assign(base: VirginSandbox, assignmentId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    assert(assignmentId.length > 0);
    assert(!this.assigned.includes(base.id));
    if (this.failAssign) throw new Error('private-assignment-canary');
    this.assigned.push(base.id);
  }
  async destroy(id: string): Promise<SandboxDestruction> {
    if (this.failDestroy) throw new Error('private-destroy-canary');
    this.bases.delete(id);
    this.destroyed.push(id);
    return { id, verified: true, inspectionDigest: 'c'.repeat(64) };
  }
}

export class PoolFixture {
  readonly provider = new FixtureSandboxPool();
  readonly signal = new AbortController();
  readonly pool: WarmSandboxPool;
  constructor(warmTarget = 1, maximumSandboxes = 2) {
    this.pool = new WarmSandboxPool(this.provider, 'a'.repeat(64), {
      warmTarget, maximumSandboxes, claimDeadlineMs: 1000,
    });
  }
}

class WarmPoolProgram {
  async run(): Promise<void> {
    const fixture = new PoolFixture();
    await fixture.pool.warm();
    const claim = await fixture.pool.claim('assignment:probe', fixture.signal.signal);
    await fixture.pool.warm();
    assert.equal(fixture.pool.status().ready, 1);
    assert.equal(fixture.provider.created.length, 2);
    await claim.close();
    assert(fixture.provider.destroyed.includes(claim.id));
    await fixture.pool.close();
    assert.equal(fixture.provider.bases.size, 0);
    process.stdout.write('warm-pool-policy-fixture-ok\n');
  }
}
if (import.meta.main) await new WarmPoolProgram().run();
