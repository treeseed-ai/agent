import { expect, test } from 'bun:test';
import { PoolFixture } from '../support/warm-pool-program.js';
import { WarmSandboxPool } from '../../src/warm-pool.js';
class WarmPoolContracts {
  invalidPolicy(): void {
    expect(this.invalidBounds.bind(this)).toThrow('POOL_POLICY_INVALID');
    expect(this.invalidCompatibility.bind(this)).toThrow('POOL_COMPATIBILITY_INVALID');
  }
  private invalidBounds(): void { new PoolFixture(2, 1); }
  private invalidCompatibility(): void {
    const fixture = new PoolFixture();
    new WarmSandboxPool(fixture.provider, 'mutable', {
      warmTarget: 0, maximumSandboxes: 1, claimDeadlineMs: 1000,
    });
  }
  async zeroTarget(): Promise<void> {
    const fixture = new PoolFixture(0, 1);
    await fixture.pool.warm();
    expect(fixture.pool.status()).toMatchObject({ ready: 0, assigned: 0, allocated: 0 });
    expect(fixture.provider.created).toEqual([]);
    await fixture.pool.close();
  }
}
const suite = new WarmPoolContracts();
test('unit: pool policy rejects invalid bounds and compatibility identities', suite.invalidPolicy.bind(suite));
test('unit: an explicit zero warm target creates no bases', suite.zeroTarget.bind(suite));
