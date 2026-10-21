import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { capacityFixture } from './capacity-fixture.ts';

describe('native TreeDX handler recovery through durable local capacity', () => {
 it('retains original native closure and measured usage while releasing only its terminal concurrency once', async () => {
  const f = await capacityFixture(); try {
   const lease = f.lease();
   const original = lease.dispatchEnvelope.assignment.assignmentAttempt;
   const path = 'notes/native-report.mdx';
   const frozen = assignmentAttemptSchema.parse({ ...original,
    effectiveProfile: { ...original.effectiveProfile, handler: 'reporter', handlerOrigin: 'agent-package', activity: 'reporting' },
    workspace: { mode: 'treedx', workspaceId: 'original-workspace', repository: 'original-library', baseCommit: 'a'.repeat(40), writablePaths: [path] },
    grant: { ...original.grant, sourceWrite: [], contentWrite: [{ store: 'treedx', model: 'note', id: 'native-report', repository: 'original-library', commit: 'a'.repeat(40), path }] } });
   lease.dispatchEnvelope.assignment.assignmentAttempt = frozen;
   lease.dispatchEnvelope.assignment.workspaceContext.assignmentAttempt = frozen;
   const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
   if (!claim) throw new Error('Original claim required');
   await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id); await f.store.beginActiveExecution(claim.id);
   await new Promise(resolve => setTimeout(resolve, 10));
   const completedAt = new Date().toISOString();
   const output = { assignmentResult: { schemaVersion: 'treeseed.assignment-result/v1', id: 'original-native-result', assignmentId: frozen.id,
    status: 'completed', summary: 'Native report retained', references: [{ kind: 'treedx', projectId: frozen.projectId, repository: 'original-library',
     commit: 'b'.repeat(40), path, workspaceId: 'original-workspace' }], verification: [], diagnostics: [],
    usage: { elapsedSeconds: 1, native: { activeSeconds: 0.01 } }, completedAt }, teardown: { verified: true, completedAt }, artifacts: [] };
   await new Promise(resolve => setTimeout(resolve, 5)); await f.store.finishActiveExecution(claim.id);
   await f.store.recordCloseoutOutput(claim.id, output); await f.store.recordFailure(claim.id, 'original terminal publication rejection');
   const before = JSON.parse(await f.bytes());
   await Promise.all([f.store.retainUnresolvedUsage(claim.id), f.reopen().retainUnresolvedUsage(claim.id)]);
   const after = JSON.parse(await f.bytes());
   expect(after.claims[0]).toEqual({ ...before.claims[0], status: 'unresolved', updatedAt: after.claims[0].updatedAt });
   expect(after.usage).toEqual(before.usage);
   expect(after.claims[0].closeoutOutput).toEqual(output);
   expect(after.events.filter((e: { outcome: string }) => e.outcome === 'operator-usage-unresolved')).toHaveLength(1);
   const next = await f.reopen().claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
   expect(next).not.toBeNull(); if (next) await f.store.release(next.id);
  } finally { await f.close(); }
 });
});

import { ReporterHandler } from '../../../../src/kernel/handlers/reporter.ts';
import { request } from '../../kernel/provider-kernel-fixture.ts';

it('recognizes the registered native handler for renamed agents and rejects foreign, model, guest, unclosed and ungranted evidence', () => {
 const source = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
 const start = Date.parse(source.createdAt), at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
 const path = 'notes/native-report.mdx';
 const assignment = assignmentAttemptSchema.parse({ ...source, agentClass: 'renamed-coordination-class',
  effectiveProfile: { ...source.effectiveProfile, handler: 'reporter', handlerOrigin: 'agent-package', activity: 'reporting' },
  workspace: { mode: 'treedx', workspaceId: 'native-workspace', repository: 'native-library', baseCommit: 'a'.repeat(40), writablePaths: [path] },
  grant: { ...source.grant, sourceWrite: [], contentWrite: [{ store: 'treedx', model: 'note', id: 'original-note', repository: 'native-library', commit: 'a'.repeat(40), path }] } });
 const output = { assignmentResult: { schemaVersion: 'treeseed.assignment-result/v1', id: 'original-result', assignmentId: assignment.id, status: 'completed',
  summary: 'Original native report', references: [{ kind: 'treedx', projectId: assignment.projectId, repository: 'native-library', commit: 'b'.repeat(40), path, workspaceId: 'native-workspace' }],
  verification: [], diagnostics: [], usage: { elapsedSeconds: 2, native: { activeSeconds: 1.5 } }, completedAt: at(2) },
  teardown: { verified: true, completedAt: at(2) }, artifacts: [] };
 const clock = { activeStartedAt: at(0), activeFinishedAt: at(2.1), accountedThrough: at(2.1) };
 expect(ReporterHandler.retainedNativeResult(assignment, output, clock)).toEqual(output.assignmentResult);
 for (const change of [
  (a: any, _o: any, _c: any) => { a.effectiveProfile.handler = 'actor'; },
  (a: any, _o: any, _c: any) => { a.effectiveProfile.handlerOrigin = 'project-runtime'; },
  (a: any, _o: any, _c: any) => { a.grant.contentWrite = []; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.assignmentId = 'foreign'; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.references[0].workspaceId = 'foreign'; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.references[0].projectId = 'foreign'; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.references[0].path = 'notes/ungranted.mdx'; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.usage.modelInputTokens = 1; },
  (_a: any, o: any, _c: any) => { o.assignmentResult.usage.native.activeSeconds = 0; },
  (_a: any, o: any, _c: any) => { o.sandboxId = 'guest'; },
  (_a: any, o: any, _c: any) => { o.environmentReceipt = {}; },
  (_a: any, o: any, _c: any) => { o.artifacts = [{ id: 'guest-artifact' }]; },
  (_a: any, o: any, _c: any) => { o.teardown.verified = false; },
  (_a: any, o: any, _c: any) => { o.teardown.completedAt = at(-1); },
  (_a: any, _o: any, c: any) => { delete c.activeFinishedAt; },
  (_a: any, _o: any, c: any) => { c.accountedThrough = at(1); },
 ]) {
  const a = structuredClone(assignment), o = structuredClone(output), c = structuredClone(clock); change(a, o, c);
  const before = structuredClone({ a, o, c }); expect(ReporterHandler.retainedNativeResult(a, o, c)).toBeNull();
  expect({ a, o, c }).toEqual(before);
 }
});
