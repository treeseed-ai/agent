import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { state, gate, read, assignment, usageMeasurement, classes, workdayId, commit, type Row } from '../architecture/golden-readback-fixture.ts';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { readCompleteEvidence } from '../../../acceptance/workday/support/evidence-pages.ts';

describe('golden read-back assertion regressions (fixtures are not live acceptance)', () => {
  it('reads complete ascending public event pages with exact diagnostic selection and refuses duplicate reversed or unbound cursor evidence without rewriting pages', () => {
    const first = { id: 'a', createdAt: '2026-10-04T00:00:00.000Z' }, second = { id: 'b', createdAt: first.createdAt },
      third = { id: 'c', createdAt: '2026-10-04T00:00:01.000Z' }, cursor = encodeCapacityPageCursor(second);
    const pages = [{ items: [first, second], page: { limit: 2, hasMore: true, nextCursor: cursor } },
      { items: [third], page: { limit: 2, hasMore: false, nextCursor: null } }];
    const args = ['workdays', 'events', workdayId, '--diagnostics', 'full'], held = structuredClone(pages), input = [...args];
    state.eventPages = structuredClone(pages);
    expect(readCompleteEvidence(args, 'treeseed', 2, 'ACCEPTANCE_MODEL_CLOCK', 'ascending')).toEqual([first, second, third]);
    expect(state.calls.slice(-2)).toEqual([ [...args, '--limit', '2', '--server', 'local', '--team', 'treeseed', '--json'],
      [...args, '--limit', '2', '--cursor', cursor, '--server', 'local', '--team', 'treeseed', '--json'] ]);
    for (const mode of ['duplicate', 'reversed', 'wrong-cursor', 'missing-tail']) {
      const supplied = structuredClone(pages);
      if (mode === 'duplicate') supplied[1]!.items = [second];
      if (mode === 'reversed') supplied[0]!.items = [second, first];
      if (mode === 'wrong-cursor') supplied[0]!.page.nextCursor = encodeCapacityPageCursor(first);
      if (mode === 'missing-tail') supplied.splice(1);
      state.eventPages = structuredClone(supplied); const before = structuredClone(supplied);
      expect(() => readCompleteEvidence(args, 'treeseed', 2, 'ACCEPTANCE_MODEL_CLOCK', 'ascending')).toThrow(); expect(supplied).toEqual(before);
    }
    expect(pages).toEqual(held); expect(args).toEqual(input);
    // Controlled public CLI replies are UNIT inputs, not native API/model proof.
  });
  it('binds every supplied weighted opportunity to the original applied policy without inventing entitlement or accepting fractional shares and unknown phases', () => {
    const item = state.replies.get('assignments list')!.items[0], run = state.replies.get('workdays show')!.run;
    const original = structuredClone([...state.replies]); expect(() => gate('lifecycle')).not.toThrow();
    for (const mode of ['changed-weight', 'missing-policy', 'zero-policy', 'coerced-policy', 'unknown-phase', 'absent-phase', 'fractional-share', 'fractional-available']) {
      state.replies.clear(); for (const [key, value] of structuredClone(original)) state.replies.set(key, value);
      const owner = state.replies.get('assignments list')!.items[0], applied = state.replies.get('workdays show')!.run.parameters.appliedPlan;
      const opportunity = owner.explanation.metadata.allocation.opportunity;
      if (mode === 'changed-weight') { opportunity.weight = 2; opportunity.totalEligibleWeight = 2; }
      if (mode === 'missing-policy') delete applied.policySnapshot;
      if (mode === 'zero-policy') applied.policySnapshot.allocationWeight = 0;
      if (mode === 'coerced-policy') applied.policySnapshot.allocationWeight = '1';
      if (mode === 'unknown-phase') opportunity.phase = 'implementation';
      if (mode === 'absent-phase') delete opportunity.phase;
      if (mode === 'fractional-share') opportunity.shareSeconds = 10.5;
      if (mode === 'fractional-available') opportunity.availableSeconds = 10.5;
      const before = structuredClone([...state.replies]); expect(() => gate('lifecycle'), mode).toThrow(/ACCEPTANCE_ALLOCATION/u);
      expect([...state.replies]).toEqual(before);
    }
    state.replies.clear(); for (const [key, value] of original) state.replies.set(key, value);
    expect(() => gate('lifecycle')).not.toThrow(); expect(item.explanation.metadata.allocation.opportunity.weight).toBe(1);
    expect(run.parameters.appliedPlan.policySnapshot.allocationWeight).toBe(1);
    // Supplied snapshot projection only, not a complete applied Workday or
    // independent history of every eligible competing project/team.
  });
  it('independently reads exact governed review finding bytes from the owning result with omitted or explicit same-publication commit', () => {
    const key = 'library read decisions/requested.mdx';
    const finding = state.replies.get(key)!.result.files[0].frontmatter.findingRefs[0];
    for (const explicit of [false, true]) {
      if (explicit) finding.commit = commit; else delete finding.commit;
      const before = structuredClone([...state.replies]);
      expect(() => gate('revision')).not.toThrow(); expect([...state.replies]).toEqual(before);
      expect(state.calls.some(args => args.slice(0, 2).join(' ') === 'library read'
        && args.includes('notes/requested-feedback.mdx') && args.includes(commit))).toBe(true);
    }
    // Controlled raw bytes and clocks are unit inputs, not live findings or proof
    // that a later Actor actually addressed the substance of a review.
  });
  it('denies missing substituted malformed or unowned native review findings without repairing raw observations or failed history', () => {
    const original = structuredClone([...state.replies]);
    const decisionKey = 'library read decisions/requested.mdx', findingKey = 'library read notes/requested-feedback.mdx';
    for (const mutation of ['absent-refs', 'empty-refs', 'duplicate-refs', 'missing-file', 'moved-ref', 'raw-digest', 'raw-missing',
      'parsed-contradiction', 'body-contradiction', 'id', 'project', 'class', 'subject', 'empty-body', 'before', 'after',
      'reference-id', 'reference-repository', 'reference-revision', 'reference-digest', 'foreign-commit', 'unowned', 'ungranted']) {
      state.replies.clear(); for (const [key, value] of structuredClone(original)) state.replies.set(key, value);
      const decision = state.replies.get(decisionKey)!.result.files[0].frontmatter;
      const reply = state.replies.get(findingKey)!, file = reply.result.files[0], finding = decision.findingRefs[0];
      const review = state.replies.get('assignments list')!.items.find((value: Row) => value.id === 'requested')!;
      if (mutation === 'absent-refs') delete decision.findingRefs;
      if (mutation === 'empty-refs') decision.findingRefs = [];
      if (mutation === 'duplicate-refs') decision.findingRefs.push(structuredClone(finding));
      if (mutation === 'missing-file') reply.result.files = [];
      if (mutation === 'moved-ref') reply.result.resolvedRef = 'd'.repeat(40);
      if (mutation === 'raw-digest') file.content += '\n';
      if (mutation === 'raw-missing') delete file.content;
      if (mutation === 'parsed-contradiction') file.frontmatter.id = 'foreign';
      if (mutation === 'body-contradiction') file.body = 'Different observation';
      if (mutation.startsWith('reference-')) finding[mutation.slice(10)] = mutation === 'reference-revision' ? 2
        : mutation === 'reference-digest' ? `sha256:${'0'.repeat(64)}` : 'foreign';
      if (mutation === 'foreign-commit') finding.commit = 'd'.repeat(40);
      if (mutation === 'unowned') review.assignmentResult.references = review.assignmentResult.references.filter((value: Row) => value.path !== file.path);
      if (mutation === 'ungranted') review.assignmentAttempt.grant.contentWrite = [];
      if (['id', 'project', 'class', 'subject', 'empty-body', 'before', 'after'].includes(mutation)) {
        if (mutation === 'id') file.frontmatter.id = 'foreign';
        if (mutation === 'project') file.frontmatter.projectId = 'foreign';
        if (mutation === 'class') file.frontmatter.classification = 'research';
        if (mutation === 'subject') file.frontmatter.subjectRefs[0].commit = 'd'.repeat(40);
        if (mutation === 'empty-body') file.body = '';
        if (mutation === 'before') file.frontmatter.createdAt = '2026-09-27T00:00:02Z';
        if (mutation === 'after') file.frontmatter.createdAt = '2026-09-27T00:00:05Z';
        file.content = `---\n${stringify(file.frontmatter, { lineWidth: 0 })}---\n\n${file.body}\n`;
        finding.digest = `sha256:${createHash('sha256').update(file.content).digest('hex')}`;
      }
      const before = structuredClone([...state.replies]);
      expect(() => gate('revision'), mutation).toThrow(); expect([...state.replies], mutation).toEqual(before);
    }
    state.replies.clear(); for (const [key, value] of original) state.replies.set(key, value);
    expect(() => gate('revision')).not.toThrow();
  });
  it('requires the genuine request-changes Decision to bind its exact prior Actor candidate assigned independent Reviewer and recorded interval', () => {
    const key = 'library read decisions/requested.mdx';
    const original = structuredClone(state.replies.get(key)!);
    const before = structuredClone([...state.replies]);
    expect(() => gate('revision')).not.toThrow(); expect([...state.replies]).toEqual(before);
    for (const mutate of [
      (value: Row) => { value.result.files = []; },
      (value: Row) => { value.result.resolvedRef = 'd'.repeat(40); },
      (value: Row) => { value.result.files[0].frontmatter.disposition = 'approved'; },
      (value: Row) => { value.result.files[0].frontmatter.subjectRef.commit = 'd'.repeat(40); },
      (value: Row) => { value.result.files[0].frontmatter.subjectRef.repository = 'foreign'; },
      (value: Row) => { value.result.files[0].frontmatter.decidedByRefs = []; },
      (value: Row) => { value.result.files[0].frontmatter.decidedByRefs[0].id = 'foreign-reviewer'; },
      (value: Row) => { value.result.files[0].frontmatter.decidedAt = '2026-09-27T00:00:02Z'; },
      (value: Row) => { value.result.files[0].frontmatter.decidedAt = '2026-09-27T00:00:05Z'; },
    ]) {
      const value = structuredClone(original); mutate(value); state.replies.set(key, value);
      const frozen = structuredClone([...state.replies]);
      expect(() => gate('revision')).toThrow(); expect([...state.replies]).toEqual(frozen);
    }
    state.replies.set(key, original);
    expect(() => gate('revision')).not.toThrow();
  });
  it('retains the exact original request-changes correction and independent approval result chain without substituted or reused identities', () => {
    const items = state.replies.get('assignments list')!.items;
    const original = structuredClone(items);
    for (const mutate of [
      (values: Row[]) => { values.find(value => value.id === 'requested')!.assignmentAttempt.predecessorResultIds = []; },
      (values: Row[]) => { values.find(value => value.id === 'revision')!.assignmentAttempt.predecessorResultIds = ['foreign-result']; },
      (values: Row[]) => { values.find(value => value.id === 'approved-revision')!.assignmentAttempt.predecessorResultIds = []; },
      (values: Row[]) => { const value = values.find(item => item.id === 'revision')!; value.assignmentAttempt.predecessorResultIds.push(value.assignmentAttempt.predecessorResultIds[0]); },
      (values: Row[]) => { values.find(value => value.id === 'requested')!.assignmentResult.assignmentId = 'foreign-attempt'; },
      (values: Row[]) => { values.find(value => value.id === 'requested')!.assignmentResult.status = 'failed'; },
      (values: Row[]) => { values.find(value => value.id === 'requested')!.assignmentResult.id = 'result-revision'; },
      (values: Row[]) => { values.find(value => value.id === 'requested')!.assignmentAttempt.agentClass = 'architect'; },
    ]) {
      const values = structuredClone(original); mutate(values); state.replies.get('assignments list')!.items = values;
      const frozen = structuredClone([...state.replies]);
      expect(() => gate('revision')).toThrow(); expect([...state.replies]).toEqual(frozen);
    }
    state.replies.get('assignments list')!.items = original;
    const frozen = structuredClone([...state.replies]);
    expect(() => gate('revision')).not.toThrow(); expect([...state.replies]).toEqual(frozen);
  });
  it('denies a Git completion without a candidate in its sole immutable repository and optional branch scope', () => {
    const item = state.replies.get('assignments list')!.items.find((value: Row) => value.id === 'actor-1');
    const result = item.assignmentResult, original = structuredClone(result.references), workspace = item.assignmentAttempt.workspace;
    const outcomes: boolean[] = [];
    for (const references of [[{ kind: 'git', repository: 'foreign/repository', commit }],
      [{ kind: 'git', repository: workspace.repository, commit, branch: 'main' }],
      [{ kind: 'git', repository: workspace.repository, commit, branch: 'simulation/foreign' }],
      [{ kind: 'url', url: 'https://example.invalid/read-only-citation' }]]) {
      result.references = references;
      let denied = false; try { gate('results'); } catch { denied = true; } outcomes.push(denied);
    }
    for (const branch of [undefined, workspace.branch]) {
      result.references = [{ kind: 'git', repository: workspace.repository, commit, ...(branch ? { branch } : {}) },
        { kind: 'url', url: 'https://example.invalid/read-only-citation' }];
      const before = structuredClone([...state.replies]);
      expect(() => gate('results')).not.toThrow(); expect([...state.replies]).toEqual(before);
    }
    result.references = original;
    expect(outcomes).toEqual([true, true, true, true]);
  });
  it('denies a returned predecessor sharing the completed retry node revision while retaining advanced revision history', () => {
    const list = state.replies.get('assignments list')!, latest = list.items.find((item: Row) => item.id === 'actor-1');
    const prior = structuredClone(latest);
    Object.assign(prior, { id: 'returned-prior', status: 'returned', completedAt: null,
      returnedAt: '2026-09-27T00:00:00.900Z', createdAt: '2026-09-27T00:00:00.500Z', assignmentResult: null });
    Object.assign(prior.capacityEnvelope.budget.time, { executionStartedAt: prior.createdAt, closeoutStartedAt: prior.returnedAt });
    list.items.push(prior);
    const sameRevision = (() => { try { gate('graph'); return 'ADMITTED'; } catch (error) { return String(error); } })();
    prior.executionNodeRevision = latest.executionNodeRevision - 1;
    prior.assignmentAttempt.nodeRevision = prior.executionNodeRevision;
    const before = structuredClone([...state.replies]);
    expect(() => gate('graph')).not.toThrow(); expect([...state.replies]).toEqual(before);
    expect(sameRevision).toMatch(/ACCEPTANCE_RETRY_REVISION/u);
  });
  it('denies mutually matching but malformed or moving proposal and decision authority in managed graph readback', () => {
    const nodes = state.replies.get('execution graph')!.nodes, original = structuredClone(nodes[0]);
    const assignments = state.replies.get('assignments list')!.items.filter((item: Row) => item.executionNodeId === original.id);
    const mutations = [
      (node: Row) => { node.sourceRef.commit = 'staging'; },
      (node: Row) => { node.sourceRef.digest = 'not-a-digest'; },
      (node: Row) => { node.sourceRef.model = 'question'; },
      (node: Row) => { node.authorityRefs[0].store = 'postgresql'; },
      (node: Row) => { node.authorityRefs[0].commit = 'main'; },
      (node: Row) => { node.authorityRefs[0].model = 'proposal'; },
    ];
    for (const mutate of mutations) {
      nodes[0] = structuredClone(original); mutate(nodes[0]);
      for (const item of assignments) Object.assign(item.assignmentAttempt,
        { sourceRef: structuredClone(nodes[0].sourceRef), authorityRefs: structuredClone(nodes[0].authorityRefs) });
      expect(() => gate('graph')).toThrow('ACCEPTANCE_PAIR');
    }
    nodes[0] = structuredClone(original);
    nodes[0].authorityRefs.push({ store: 'treedx', model: 'agent', id: 'governed-profile', revision: 1,
      digest: `sha256:${'d'.repeat(64)}`, repository: 'sdk-library', commit, path: 'agents/governed-profile.mdx' });
    for (const item of assignments) Object.assign(item.assignmentAttempt,
      { sourceRef: structuredClone(nodes[0].sourceRef), authorityRefs: structuredClone(nodes[0].authorityRefs) });
    expect(() => gate('graph')).not.toThrow();
  });
  it('denies absent malformed or duplicate calibration authority in managed admission readback', () => {
    const item = state.replies.get('assignments list')!.items[0];
    for (const explanation of [undefined, {}, { metadata: { allocation: {} } }]) {
      item.explanation = explanation;
      expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_ALLOCATION');
    }
  });
  it('denies admitted durations that exceed actual receipt constraints or disagree with immutable limits', () => {
    const item = state.replies.get('assignments list')!.items[0];
    item.assignmentAttempt.estimate = { expectedSeconds: 300, maximumSeconds: 600 };
    item.assignmentAttempt.limits = { maximumSeconds: 10 };
    item.capacityEnvelope.requestedSeconds = 10; item.capacityEnvelope.reservedSeconds = 10;
    const receipt = { admitted: true, allocatedSeconds: 10, desiredSeconds: 600, limitingConstraint: 'shared-model',
      calibration: { seconds: 600, multiplier: 2, measurementIds: [] },
      constraints: [{ id: 'shared-model', remainingSeconds: 10 }],
      opportunity: { phase: 'planning', weight: 1, totalEligibleWeight: 1, availableSeconds: 10, shareSeconds: 10,
        committedSeconds: 0, planningCommittedSeconds: 0, remainingSupplySeconds: 10 } };
    for (const mutate of [
      (value: Row) => { value.allocatedSeconds = 11; },
      (value: Row) => { value.constraints = []; },
      (value: Row) => { value.constraints[0].remainingSeconds = '10'; },
      (value: Row) => { value.constraints[0].remainingSeconds = Number.POSITIVE_INFINITY; },
      (value: Row) => { value.admitted = false; },
    ]) {
      const changed = structuredClone(receipt); mutate(changed);
      item.explanation = { metadata: { allocation: changed } };
      expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_ALLOCATION');
    }
  });
  it('requires cold start maximums unchanged estimates and unique bounded calibration sample authority', () => {
    const item = state.replies.get('assignments list')!.items[0];
    item.assignmentAttempt.estimate = { expectedSeconds: 300, maximumSeconds: 600 };
    item.assignmentAttempt.limits = { maximumSeconds: 10 };
    const receipt = { admitted: true, allocatedSeconds: 10, desiredSeconds: 600, calibration: { seconds: 600, multiplier: 2, measurementIds: [] },
      constraints: [{ id: 'shared-model', remainingSeconds: 10 }], opportunity: { phase: 'planning', weight: 1,
        totalEligibleWeight: 1, availableSeconds: 10, shareSeconds: 10, committedSeconds: 0,
        planningCommittedSeconds: 0, remainingSupplySeconds: 10 } };
    for (const mutate of [
      (value: Row) => { value.calibration.multiplier = Number.NaN; },
      (value: Row) => { value.calibration.measurementIds = ['same', 'same']; },
      (value: Row) => { value.calibration.measurementIds = Array.from({ length: 21 }, (_, index) => `sample-${index}`); },
      (value: Row) => { value.calibration.measurementIds = ['']; },
      (value: Row) => { value.calibration.measurementIds = [' ']; },
      (value: Row) => { value.calibration.measurementIds = [' padded-sample ']; },
      (value: Row) => { value.calibration.measurementIds = [null]; },
      (value: Row) => { value.calibration.measurementIds = [1]; },
      (value: Row) => { value.calibration.measurementIds = [false]; },
      (value: Row) => { value.calibration.measurementIds = [{}]; },
      (value: Row) => { value.calibration.measurementIds = [[]]; },
      (value: Row) => { value.desiredSeconds = 500; value.calibration.seconds = 500; value.calibration.multiplier = 5 / 3; },
    ]) {
      const changed = structuredClone(receipt); mutate(changed);
      item.explanation = { metadata: { allocation: changed } };
      expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_ALLOCATION');
    }
  });
});
