import { expect, test } from 'bun:test';
import { PoolFixture } from '../support/warm-pool-program.js';
class WarmPoolBoundaries {
  async exclusive(): Promise<void> {
    const fixture = new PoolFixture(1, 1);
    await fixture.pool.warm();
    const results = await Promise.allSettled([
      fixture.pool.claim('assignment:one', fixture.signal.signal),
      fixture.pool.claim('assignment:two', fixture.signal.signal),
    ]);
    let accepted = 0;
    for (const result of results) if (result.status === 'fulfilled') {
      accepted++;
      await result.value.close();
    }
    expect(accepted).toBe(1);
    expect(fixture.provider.assigned).toHaveLength(1);
    await fixture.pool.close();
  }
  async refill(): Promise<void> {
    const fixture = new PoolFixture();
    await fixture.pool.warm();
    const claim = await fixture.pool.claim('assignment:one', fixture.signal.signal);
    await fixture.pool.warm();
    expect(fixture.pool.status()).toMatchObject({ ready: 1, assigned: 1, allocated: 2 });
    expect(fixture.provider.created).toHaveLength(2);
    await claim.close();
    expect(fixture.provider.destroyed).toContain(claim.id);
    await fixture.pool.close();
  }
  async lostCreate(): Promise<void> {
    const fixture = new PoolFixture();
    fixture.provider.loseCreateReply = true;
    await expect(fixture.pool.warm()).rejects.toThrow('POOL_CREATE_FAILED');
    expect(fixture.pool.status().allocated).toBe(0);
    expect(fixture.provider.destroyed).toEqual(fixture.provider.created);
    fixture.provider.loseCreateReply = false;
    await fixture.pool.warm();
    await fixture.pool.close();
  }
  async failedAssign(): Promise<void> {
    const fixture = new PoolFixture();
    await fixture.pool.warm();
    fixture.provider.failAssign = true;
    await expect(fixture.pool.claim('assignment:one', fixture.signal.signal)).rejects.toThrow('POOL_CLAIM_FAILED');
    expect(fixture.provider.destroyed).toContain(fixture.provider.created[0]!);
    expect(fixture.provider.assigned).toEqual([]);
    await fixture.pool.close();
  }
  async quarantine(): Promise<void> {
    const fixture = new PoolFixture(1, 1);
    await fixture.pool.warm();
    const claim = await fixture.pool.claim('assignment:one', fixture.signal.signal);
    fixture.provider.failDestroy = true;
    await expect(claim.close()).rejects.toThrow('POOL_TEARDOWN_UNVERIFIED');
    expect(fixture.pool.status()).toMatchObject({ quarantined: 1, allocated: 1 });
    await expect(fixture.pool.claim('assignment:two', fixture.signal.signal)).rejects.toThrow('POOL_QUARANTINED');
    fixture.provider.failDestroy = false;
    await claim.close();
    await fixture.pool.close();
  }
  async activeDisposal(): Promise<void> {
    const fixture = new PoolFixture();
    await fixture.pool.warm();
    const claim = await fixture.pool.claim('assignment:one', fixture.signal.signal);
    await expect(fixture.pool.close()).rejects.toThrow('POOL_CLAIMS_ACTIVE');
    expect(fixture.provider.bases.size).toBe(1);
    await claim.close();
    await fixture.pool.close();
    expect(fixture.provider.bases.size).toBe(0);
  }
  async cancellation(): Promise<void> {
    const fixture = new PoolFixture();
    await fixture.pool.warm();
    fixture.signal.abort();
    await expect(fixture.pool.claim('assignment:one', fixture.signal.signal)).rejects.toThrow('POOL_CANCELLED');
    expect(fixture.pool.status().ready).toBe(1);
    expect(fixture.provider.assigned).toEqual([]);
    await fixture.pool.close();
  }
}
const suite = new WarmPoolBoundaries();
test('integration: concurrent pool claims cannot share a virgin base', suite.exclusive.bind(suite));
test('integration: assigned pool capacity refills without recycling used sandboxes', suite.refill.bind(suite));
test('integration: lost sandbox create replies require verified cleanup', suite.lostCreate.bind(suite));
test('integration: failed assignment destroys its selected base', suite.failedAssign.bind(suite));
test('integration: unverified pool teardown quarantines capacity until explicit retry', suite.quarantine.bind(suite));
test('integration: pool disposal cannot succeed while claims remain active', suite.activeDisposal.bind(suite));
test('integration: cancelled claims leave clean warm inventory unassigned', suite.cancellation.bind(suite));
