import { expect, it } from 'vitest';
import * as observations from '../../../../acceptance/workday/support/campaign-observation.ts';
import { accountingHistoryFixture, type Row } from './accounting-history-fixture.ts';
function inspect(f: ReturnType<typeof accountingHistoryFixture>) {
 const verify = Reflect.get(observations, 'verifyAccountingTransitionHistory') as ((run: Row, items: Row[], usage: Row[], ledger: Row[], events: Row[]) => void) | undefined;
 expect(verify, 'Owning accounting history must be verified before campaign continuation').toBeTypeOf('function');
 if (!verify) throw new Error('Original accounting observer missing'); verify(f.run, f.items, f.usage, f.ledger, f.events);
}
it('reconciles each original admission checkpoint and aggregate settlement with complete public inventories exact scoped supply and unchanged historical snapshots', () => {
 const f = accountingHistoryFixture(), before = structuredClone(f);
 for (let length = 1; length <= 3; length++) {
  const prefix = { ...f, events: f.events.slice(0, length), usage: f.usage.slice(0, length - 1), ledger: length === 3 ? f.ledger : [] };
  inspect(prefix); inspect(prefix);
 }
 expect(f).toEqual(before);
});
it('denies omitted duplicate foreign unmatched or changed accounting rows without repairing failed inventories before exact retry', () => {
 const changes: Array<(f: ReturnType<typeof accountingHistoryFixture>) => void> = [
  f => { f.events.shift(); }, f => { f.usage.shift(); }, f => { f.ledger.length = 0; }, f => { f.items.length = 0; },
  f => { f.events.push(structuredClone(f.events[1]!)); }, f => { f.usage.push({ ...f.usage[0]!, id: 'unobserved-usage' }); },
  f => { f.ledger.push({ ...f.ledger[0]!, id: 'unobserved-ledger' }); }, f => { f.events[1]!.context.usageActual!.activeSeconds = 9; },
  f => { f.usage[0]!.projectId = 'foreign'; }, f => { f.usage[0]!.workDayId = 'foreign'; },
  f => { f.events[1]!.assignmentId = 'foreign'; }, f => { f.events[1]!.teamId = 'foreign'; },
  f => { f.ledger[0]!.usageSettlement.id = 'foreign'; }, f => { f.events.reverse(); },
 ];
 const original = accountingHistoryFixture();
 for (const change of changes) { const failed = structuredClone(original); change(failed); const before = structuredClone(failed); expect(() => inspect(failed)).toThrow(); expect(failed).toEqual(before); }
 inspect(original);
});
it('denies wrong reservation authority malformed supply missing claims regressed versions changed limits and dishonest terminal accounting without losing original evidence', () => {
 const changes: Array<(f: ReturnType<typeof accountingHistoryFixture>) => void> = [
  ...['id', 'assignmentId', 'teamId', 'projectId', 'workDayId', 'capacityProviderId', 'executionProviderId', 'membershipId'].map(field => (f: ReturnType<typeof accountingHistoryFixture>) => { Reflect.set(f.events[0]!.context.reservation, field, 'foreign'); }),
  f => { f.events[0]!.context.remainingSupply.length = 0; }, f => { f.events[0]!.context.remainingSupply.pop(); },
  f => { f.events[1]!.context.remainingSupply[0]!.remainingAmount = 99; }, f => { f.events[1]!.context.remainingSupply[0]!.stateVersion = 1; },
  f => { f.events[1]!.context.remainingSupply[0]!.hardLimit = 101; }, f => { f.events[0]!.context.remainingSupply[0]!.scopeId = 'foreign'; },
  f => { Reflect.set(f.events[1]!.context.remainingSupply[0]!, 'committedAmount', '30'); }, f => { f.events[2]!.context.reservation.state = 'reserved'; },
  f => { f.events[2]!.context.remainingSupply[0]!.releasedAmount = 0; }, f => { f.events[2]!.context.reservation.releasedSeconds = 0; },
  f => { f.events[2]!.createdAt = f.events[0]!.createdAt; }, f => { f.events[2]!.status = 'failed'; },
 ];
 const original = accountingHistoryFixture();
 for (const change of changes) { const failed = structuredClone(original); change(failed); const before = structuredClone(failed); expect(() => inspect(failed)).toThrow(); expect(failed).toEqual(before); }
 inspect(original);
});
