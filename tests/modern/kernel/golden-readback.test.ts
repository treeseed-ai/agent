import { describe, expect, it, vi } from 'vitest';
import { state, gate, read, assignment, classes, workdayId, commit, type Row } from './golden-readback-fixture.ts';

describe('golden read-back assertion regressions (fixtures are not live acceptance)', () => {
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
      (value: Row) => { value.desiredSeconds = 500; value.calibration.seconds = 500; value.calibration.multiplier = 5 / 3; },
    ]) {
      const changed = structuredClone(receipt); mutate(changed);
      item.explanation = { metadata: { allocation: changed } };
      expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_ALLOCATION');
    }
  });
  it('rejects moved missing or foreign report readback even when its body names the workday', () => {
    const observed = state.replies.get('library read')!.result;
    for (const mutate of [
      (value: Row) => { value.resolvedRef = 'staging'; },
      (value: Row) => { value.resolvedRef = 'b'.repeat(40); },
      (value: Row) => { value.files[0].path = 'notes/another.mdx'; },
      (value: Row) => { value.files.push(structuredClone(value.files[0])); },
      (value: Row) => { value.files = []; },
    ]) {
      const changed = structuredClone(observed); mutate(changed);
      state.replies.get('library read')!.result = changed;
      expect(() => gate('reporter')).toThrow();
    }
  });
  it('requires the single canonical workday report reference and rejects the retired plural map', () => {
    const run = state.replies.get('workdays show')!.run;
    const reference = structuredClone(run.reportRef);
    run.reportRefs = { sdk: { kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', path: 'notes/report.mdx', commit } };
    delete run.reportRef;
    expect(() => gate('reporter')).toThrow();
    run.reportRef = reference;
    expect(() => gate('reporter')).toThrow();
  });
  it('requires exactly one completed reporting assignment before accepting report readback', () => {
    const items = state.replies.get('assignments list')!.items;
    state.replies.get('assignments list')!.items = items.filter((item: Row) => item.assignmentAttempt.effectiveProfile.activity !== 'reporting');
    expect(() => gate('reporter')).toThrow();
    const reporter = items.find((item: Row) => item.assignmentAttempt.effectiveProfile.activity === 'reporting');
    state.replies.get('assignments list')!.items = [...items, { ...structuredClone(reporter), id: 'duplicate-closeout' }];
    expect(() => gate('reporter')).toThrow();
  });
  it('rejects a report note whose canonical classification or workday subject authority is missing', () => {
    const file = state.replies.get('library read')!.result.files[0];
    delete file.frontmatter;
    expect(() => gate('reporter')).toThrow();
    for (const frontmatter of [
      { schemaVersion: 'treeseed.note/v1', classification: 'other', projectId: 'sdk', subjectRefs: [] },
      { schemaVersion: 'treeseed.note/v1', classification: 'workday-report', projectId: 'other', subjectRefs: [] },
      { schemaVersion: 'treeseed.note/v1', classification: 'workday-report', projectId: 'sdk', subjectRefs: [{ store: 'postgresql', model: 'workday', id: 'another-workday' }] },
    ]) { file.frontmatter = frontmatter; expect(() => gate('reporter')).toThrow(); }
  });
  it('binds closeout report output completion teardown and chronology to the exact authoritative workday', () => {
    const items = state.replies.get('assignments list')!.items;
    const index = items.findIndex((item: Row) => item.assignmentAttempt.effectiveProfile.activity === 'reporting');
    const original = structuredClone(items[index]);
    for (const mutate of [
      (item: Row) => { item.assignmentResult.assignmentId = 'other-assignment'; },
      (item: Row) => { item.assignmentResult.references[0].commit = 'b'.repeat(40); },
      (item: Row) => { item.assignmentResult.references.push(structuredClone(item.assignmentResult.references[0])); },
      (item: Row) => { item.status = 'failed'; },
      (item: Row) => { item.leaseToken = 'live'; },
      (item: Row) => { item.lifecycleOutput.teardown.verified = false; },
      (item: Row) => { item.completedAt = '2026-09-27T00:01:01Z'; },
      (item: Row) => { item.assignmentAttempt.sourceRef.id = 'other-workday'; },
    ]) {
      items[index] = structuredClone(original); mutate(items[index]);
      expect(() => gate('reporter')).toThrow();
    }
    items[index] = original;
    expect(() => gate('reporter')).not.toThrow();
  });
  it('rejects any change to the exact five-slot campaign policy rather than accepting larger allowances', () => {
    const parameters = state.replies.get('workdays show')!.run.parameters;
    for (const key of ['maximumConcurrency', 'communicationConcurrency']) {
      parameters[key] = 6;
      expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_CONCURRENCY_POLICY');
      parameters[key] = 5;
    }
  });
  it('requires the exact configured chat and estimating contributors rather than only their counts', () => {
    const items = state.replies.get('assignments list')!.items;
    for (const activity of ['chat', 'estimating']) {
      const selected = items.find((item: Row) => item.assignmentAttempt.effectiveProfile.activity === activity);
      const original = selected.assignmentAttempt.agentClass;
      selected.assignmentAttempt.agentClass = 'unselected-agent';
      expect(() => gate('collaboration')).toThrow();
      selected.assignmentAttempt.agentClass = original;
    }
  });
  it('requires every canonical clock field and successful first and final authoritative tools', () => {
    const result = state.replies.get('assignments list')!.items[0].assignmentResult;
    const canonical = { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
      firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
      lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true };
    for (const key of Object.keys(canonical)) {
      const incomplete: Row = { ...canonical }; delete incomplete[key];
      result.timingAwareness = incomplete;
      expect(() => gate('results')).toThrow();
    }
    for (const [key, value] of Object.entries({ schemaVersion: 'retired/v1', requiredChecks: 3, firstTool: 'other-tool',
      lastTool: 'other-tool', firstToolSucceeded: false, lastToolSucceeded: false })) {
      result.timingAwareness = { ...canonical, [key]: value };
      expect(() => gate('results')).toThrow();
    }
  });
  it('denies nonfinite measured usage instead of accepting a coerced positive value', () => {
    const native = state.replies.get('assignments list')!.items[0].assignmentResult.usage.native;
    for (const value of ['1', Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      native.activeSeconds = value;
      expect(() => gate('results')).toThrow();
    }
  });
  it('denies malformed exact output references and results bound to another assignment', () => {
    const item = state.replies.get('assignments list')!.items[0];
    const result = item.assignmentResult;
    for (const reference of [{ kind: 'git', commit }, { kind: 'git', repository: 'sdk', commit: 'staging' },
      { kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', path: 'notes/result.mdx' },
      { kind: 'url', url: 'not-a-url' }, { kind: 'invented', commit }]) {
      result.references = [reference];
      expect(() => gate('results')).toThrow();
    }
    result.references = [{ kind: 'git', repository: 'sdk', commit }];
    result.assignmentId = 'another-assignment';
    expect(() => gate('results')).toThrow();
  });
  it('requires latest immutable completion custody even when a graph node claims completed', () => {
    const nodes = state.replies.get('execution graph')!.nodes;
    const retained = structuredClone(nodes[0]);
    for (const mutate of [
      (node: Row) => { node.nodeRevision = 3; },
      (node: Row) => { node.workItemId = 'other-work'; },
      (node: Row) => { node.sourceRef.revision = 9; },
      (node: Row) => { node.authorityRefs[0].id = 'other-decision'; },
      (node: Row) => { delete node.sourceRef; },
    ]) {
      nodes[0] = structuredClone(retained); mutate(nodes[0]);
      expect(() => gate('graph')).toThrow();
    }
    nodes[0] = retained;
    expect(() => gate('graph')).not.toThrow();
  });
	it('rejects serial execution even when five slots were configured', () => {
		for (const [index, item] of state.replies.get('assignments list')!.items.entries()) {
			item.capacityEnvelope.budget.time.executionStartedAt = new Date(index * 1000).toISOString();
			item.capacityEnvelope.budget.time.closeoutStartedAt = new Date((index + 1) * 1000).toISOString();
			item.completedAt = new Date((index + 1) * 1000).toISOString();
		}
		expect(() => gate('lifecycle')).toThrow('ACCEPTANCE_CONCURRENCY_OVERLAP');
	});
	it('bounds CLI infrastructure waits and retains only safe failure classifications', () => {
		state.failure = Object.assign(new Error('secret-must-not-leak'), { code: 'ETIMEDOUT' });
		expect(() => read(['workdays', 'show'], 'treeseed')).toThrow('ACCEPTANCE_CLI_COMMAND: workdays.show ETIMEDOUT');
		expect(state.timeout).toBe(120000);
		state.failure = new Error('secret-must-not-leak');
		expect(() => read(['workdays', 'show'], 'treeseed')).toThrow('ACCEPTANCE_CLI_COMMAND: workdays.show COMMAND_FAILED');
		state.failure = Object.assign(new Error('secret-must-not-leak'), {
			stdout: JSON.stringify({ ok: false, error: { code: 'identity_authentication_failed', message: 'secret-must-not-leak' } }),
		});
		expect(() => read(['workdays', 'show'], 'treeseed')).toThrow('ACCEPTANCE_CLI_COMMAND: workdays.show identity_authentication_failed');
	});
	it('uses the proposal command contract without a team option', () => {
		state.replies.set('proposals show', { readiness: { unresolvedBlockerCount: 0 } });
		const result = read(['proposals', 'show', 'proposal-1', '--server', 'local', '--project', 'sdk'], 'treeseed', true);
		expect(result.readiness).toEqual({ unresolvedBlockerCount: 0 });
		expect(state.args).toEqual(['proposals', 'show', 'proposal-1', '--server', 'local', '--project', 'sdk', '--json']);
	});
	it('keeps seven normal read-back gates separate from stopped-run evidence', () => {
		expect(state.cases.size).toBe(8);
		for (const name of ['lifecycle', 'collaboration', 'graph', 'revision', 'results', 'settlement', 'reporter']) expect(() => gate(name)).not.toThrow();
	});
	it('requires native Reporter closure without relaxing accounting or exposing raw assertion payloads', () => {
		const reporter = assignment('native-reporter', 'reporting', 'reporter');
		state.replies.get('assignments list')!.items.push(reporter);
		state.replies.get('capacity usage')!.items.push({ id: `${reporter.id}:aggregate`, assignmentId: reporter.id,
			metadata: { settlementKey: reporter.id } });
		delete reporter.lifecycleOutput.teardown;
		expect(() => gate('settlement')).toThrow('ACCEPTANCE_SETTLEMENT_TEARDOWN:');
		reporter.lifecycleOutput.teardown = { verified: true };
		expect(() => gate('settlement')).not.toThrow();
		state.replies.get('capacity usage')!.items.pop();
		expect(() => gate('settlement')).toThrow('ACCEPTANCE_SETTLEMENT_COUNT:');
	});
	it('does not accept a stop acknowledgement without terminal leases teardown and settlement', () => {
		const stopped = state.cases.get('Stopped simulation retains terminal leases teardown and exactly-once settlement')!;
		expect(stopped).toThrow('ACCEPTANCE_STOP_TERMINAL');
		state.replies.get('workdays show')!.run.status = 'cancelled';
		expect(stopped).not.toThrow();
		const item = state.replies.get('assignments list')!.items[0];
		item.leaseToken = 'synthetic-live-lease';
		expect(stopped).toThrow('ACCEPTANCE_STOP_LEASE');
		item.leaseToken = null;
		item.lifecycleOutput.teardown.verified = false;
		expect(stopped).toThrow('ACCEPTANCE_STOP_TEARDOWN');
		item.lifecycleOutput.teardown.verified = true;
		state.replies.get('capacity usage')!.items.shift();
		expect(stopped).toThrow('Exactly one actual settlement');
	});
	it('verifies failed-only stopped runs without accepting empty or unsettled attempts', () => {
		const stopped = state.cases.get('Stopped simulation retains terminal leases teardown and exactly-once settlement')!;
		state.replies.get('workdays show')!.run.status = 'failed';
		const items = state.replies.get('assignments list')!.items;
		for (const item of items) item.status = 'failed';
		expect(stopped).not.toThrow();
		expect(() => gate('results')).toThrow('No completed assignment evidence');
		state.replies.get('capacity usage')!.items.shift();
		expect(stopped).toThrow('Exactly one actual settlement');
		state.replies.get('assignments list')!.items = [];
		expect(stopped).toThrow('No real assignment evidence');
	});
	it('rejects missing workday identity and contradictory mode in every gate', () => {
		vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
		for (const run of state.cases.values()) expect(run).toThrow('Explicit real workday ID');
		vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', workdayId);
		state.replies.get('workdays show')!.run.executionMode = 'production';
		for (const run of state.cases.values()) expect(run).toThrow();
	});
	it('rejects a terminal run containing failed assignments', () => {
		state.replies.get('assignments list')!.items[0].status = 'failed';
		expect(() => gate('lifecycle')).toThrow('Normal golden');
	});
	it('accepts only authoritative planning phase cancellation with terminal custody', () => {
		const item = state.replies.get('assignments list')!.items[0];
		item.status = 'cancelled'; item.lifecycleCode = 'planning_boundary_cancelled';
		item.assignmentAttempt.effectiveProfile.activity = 'planning'; item.failedAt = '2026-09-27T00:20:02Z';
		item.capacityEnvelope.budget.time.authorityDeadlineAt = '2026-09-27T00:20:00Z';
		item.capacityEnvelope.budget.time.executionDeadlineAt = '2026-09-27T00:20:00Z';
		item.lifecycleOutput.performance = { disposition: 'cancelled' };
		expect(() => gate('lifecycle')).not.toThrow();
		expect(() => gate('settlement')).not.toThrow();
		const mutations = [
			(value: Row) => { value.assignmentAttempt.effectiveProfile.activity = 'acting'; },
			(value: Row) => { value.lifecycleCode = 'assignment_cancelled'; },
			(value: Row) => { value.capacityEnvelope.budget.time.executionDeadlineAt = '2026-09-27T00:19:59Z'; },
			(value: Row) => { value.failedAt = '2026-09-27T00:19:59Z'; },
			(value: Row) => { value.capacityEnvelope.budget.time.authorityDeadlineAt = 'invalid'; },
			(value: Row) => { value.lifecycleOutput.performance.disposition = 'deadline_exhausted'; },
			(value: Row) => { value.lifecycleOutput.teardown.verified = false; },
			(value: Row) => { value.leaseToken = 'live'; },
		];
		for (const mutate of mutations) {
			const invalid = structuredClone(item); mutate(invalid);
			state.replies.get('assignments list')!.items[0] = invalid;
			expect(() => gate('lifecycle')).toThrow();
			expect(() => gate('settlement')).toThrow();
		}
	});
	it('settles cancelled planning attempts exactly once without accepting missing or duplicate consumption', () => {
		const item = state.replies.get('assignments list')!.items[0];
		item.status = 'cancelled'; item.lifecycleCode = 'planning_boundary_cancelled';
		item.assignmentAttempt.effectiveProfile.activity = 'estimating'; item.failedAt = '2026-09-27T00:20:00Z';
		item.capacityEnvelope.budget.time.authorityDeadlineAt = '2026-09-27T00:20:00Z';
		item.capacityEnvelope.budget.time.preparationDeadlineAt = '2026-09-27T00:20:00Z';
		item.lifecycleOutput.performance = { disposition: 'cancelled' };
		expect(() => gate('settlement')).not.toThrow();
		const usage = state.replies.get('capacity usage')!.items;
		const cancelled = usage.shift();
		expect(() => gate('settlement')).toThrow('Exactly one actual settlement');
		usage.push(cancelled, { ...cancelled, id: 'duplicate-cancelled:aggregate' });
		expect(() => gate('settlement')).toThrow('Exactly one actual settlement');
	});
	it('does not confuse repeated single-role planning with collaborative cycles', () => {
		for (const item of state.replies.get('assignments list')!.items) if (item.assignmentAttempt.effectiveProfile.activity === 'planning') item.assignmentAttempt.agentClass = 'architect';
		expect(() => gate('collaboration')).toThrow('Two planning turns required for researcher');
	});
	it('rejects stale round completion despite sixteen planning assignments', () => {
		state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds[1].state = 'active';
		expect(() => gate('collaboration')).toThrow('Two completed graph planning cycles');
	});
	it('rejects incomplete generated pairs and absent real revision', () => {
		const removed = state.replies.get('execution graph')!.nodes.pop();
		expect(() => gate('graph')).toThrow();
		state.replies.get('execution graph')!.nodes.push(removed);
		state.replies.get('assignments list')!.items = state.replies.get('assignments list')!.items.filter((item: Row) => item.id !== 'revision');
		expect(() => gate('revision')).toThrow('later real Actor revision');
	});
	it('proves retired terminal pairs from exact immutable completion custody, not stale status alone', () => {
		const items = state.replies.get('assignments list')!.items;
		const nodes = state.replies.get('execution graph')!.nodes;
		for (const [index, node] of nodes.entries()) {
			const workItemId = `work-${Math.floor(index / 2)}`;
			const activity = node.pairRole === 'actor' ? 'acting' : 'reviewing';
			for (const item of items.filter((item: Row) => item.assignmentAttempt.workItemId === workItemId
				&& item.assignmentAttempt.effectiveProfile.activity === activity)) {
				item.executionNodeId = node.id; item.executionNodeRevision = 2;
				Object.assign(item.assignmentAttempt, { nodeId: node.id, nodeRevision: 2, workdayId, sourceRef: structuredClone(node.sourceRef),
					authorityRefs: structuredClone(node.authorityRefs) });
				item.assignmentResult.assignmentId = item.id;
			}
			Object.assign(node, { status: 'stale', nodeRevision: 3, workItemId });
		}
		expect(() => gate('graph')).not.toThrow();
		expect(() => gate('revision')).not.toThrow();
		const retained = structuredClone(nodes[0]);
		for (const mutation of [
			(value: Row) => { value.nodeRevision = 2; },
			(value: Row) => { value.sourceRef.revision = 9; },
			(value: Row) => { value.authorityRefs[0].id = 'other-decision'; },
			(value: Row) => { value.status = 'blocked'; },
		]) {
			nodes[0] = structuredClone(retained); mutation(nodes[0]);
			expect(() => gate('graph')).toThrow();
		}
		nodes[0] = retained;
		const revision = items.find((item: Row) => item.id === 'revision');
		for (const mutation of [
			(value: Row) => { value.status = 'failed'; },
			(value: Row) => { value.assignmentResult.assignmentId = 'other-assignment'; },
			(value: Row) => { value.assignmentAttempt.nodeId = 'other-node'; },
			(value: Row) => { value.assignmentAttempt.workdayId = 'other-workday'; },
		]) {
			const saved = structuredClone(revision); mutation(revision);
			expect(() => gate('graph')).toThrow(); Object.assign(revision, saved);
		}
		items.find((item: Row) => item.id === 'approved-revision').lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
		expect(() => gate('graph')).toThrow();
	});
	it('rejects zero usage, missing clocks and unverified teardown', () => {
		const item = state.replies.get('assignments list')!.items[0];
		item.assignmentResult.usage.native.activeSeconds = 0;
		expect(() => gate('results')).toThrow('Measured active usage');
		item.assignmentResult.usage.native.activeSeconds = 1;
		item.assignmentResult.timingAwareness.completedChecks = 1;
		expect(() => gate('results')).toThrow();
		item.assignmentResult.timingAwareness.completedChecks = 2;
		item.lifecycleOutput.teardown.verified = false;
		expect(() => gate('results')).toThrow();
	});
	it('permits intermediate time checks without weakening first/final compliance', () => {
		const timing = state.replies.get('assignments list')!.items[0].assignmentResult.timingAwareness;
		timing.completedChecks = 4;
		expect(() => gate('results')).not.toThrow();
		timing.finalToolCompliant = false;
		expect(() => gate('results')).toThrow();
	});
	it('rejects missing or duplicate settlements', () => {
		const usage = state.replies.get('capacity usage')!.items;
		const first = usage.shift();
		expect(() => gate('settlement')).toThrow('Exactly one actual settlement');
		usage.push(first, { ...first, id: 'duplicate:aggregate' });
		expect(() => gate('settlement')).toThrow('Exactly one actual settlement');
	});
	it('rejects missing Reporter refs and unrelated report contents', () => {
		state.replies.get('library read')!.result.files[0].body = 'An unrelated report';
		expect(() => gate('reporter')).toThrow('this exact workday');
		delete state.replies.get('workdays show')!.run.reportRef;
		expect(() => gate('reporter')).toThrow('one exact report');
	});
});
