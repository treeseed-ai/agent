import { describe, expect, it, vi } from 'vitest';
import { RenewalDrain } from '../../../src/provider/execution/activity/renewal-drain.ts';

describe('sandbox renewal drain', () => {
  it('waits for in-flight renewal before teardown and refuses new renewals', async () => {
    const drain = new RenewalDrain(), order: string[] = [];
    let release!: () => void;
    const renewal = drain.run(async () => { order.push('renew'); await new Promise<void>(resolve => { release = resolve; }); order.push('renewed'); });
    await Promise.resolve();
    const teardown = drain.close().then(() => { order.push('destroy'); });
    const late = vi.fn(async () => {});
    await drain.run(late);
    expect(late).not.toHaveBeenCalled();
    expect(order).toEqual(['renew']);
    release(); await renewal; await teardown;
    expect(order).toEqual(['renew', 'renewed', 'destroy']);
  });
  it('preserves active renewal errors while permitting cleanup', async () => {
    const drain = new RenewalDrain();
    await expect(drain.run(async () => { throw new Error('authority expired'); })).rejects.toThrow('authority expired');
    await expect(drain.close()).resolves.toBeUndefined();
  });
});
