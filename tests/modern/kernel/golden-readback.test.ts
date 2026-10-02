import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const state = vi.hoisted(() => ({ cases: new Map<string, () => void>(), replies: new Map<string, Row>(), failure: undefined as Error | undefined, timeout: 0, args: [] as string[] }));
vi.mock('node:test', () => ({ default: (name: string, _options: unknown, run: () => void) => state.cases.set(name, run) }));
vi.mock('node:child_process', () => ({ execFileSync: (_command: string, args: string[], options: { timeout: number }) => {
	state.timeout = options.timeout;
	state.args = args;
	if (state.failure) throw state.failure;
	const key = args.slice(0, 2).join(' ');
	const result = state.replies.get(key);
	if (!result) throw new Error(`Unexpected acceptance read: ${key}`);
	return JSON.stringify({ ok: true, result });
} }));
await import('../../acceptance/sdk-runtime-golden.test.ts');
const { read } = await import('../../acceptance/acceptance-cli.ts');

const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
const workdayId = 'workday-test';
const commit = 'a'.repeat(40);
const gate = (name: string) => state.cases.get(`Golden runtime ${name} evidence satisfies its acceptance boundary`)!();
function assignment(id: string, activity: string, agentClass: string, workItemId = '', createdAt = '2026-09-27T00:00:01Z', completedAt = '2026-09-27T00:00:02Z'): Row {
	return { id, workDayId: workdayId, projectId: 'sdk', decisionId: 'decision-test', status: 'completed', leaseToken: null,
		createdAt, completedAt, assignmentAttempt: { agentClass, workItemId, effectiveProfile: { activity } },
		capacityEnvelope: { budget: { time: { executionStartedAt: createdAt, closeoutStartedAt: completedAt } } },
		assignmentResult: { schemaVersion: 'treeseed.assignment-result/v1', id: `result-${id}`, assignmentId: id,
			status: 'completed', summary: 'Synthetic assertion input, not live acceptance evidence.', verification: [], diagnostics: [], completedAt,
			timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastTool: 'treedx:treeseed_time_status',
				lastToolSucceeded: true, firstToolCompliant: true, finalToolCompliant: true },
			usage: { elapsedSeconds: 1, native: { activeSeconds: 1 } }, references: [{ kind: 'git', repository: 'sdk', commit }] },
		lifecycleOutput: { teardown: { verified: true }, activityCompletion: { reviewDisposition: 'approved' } } };
}
beforeEach(() => {
	vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', workdayId);
	state.replies.clear();
	state.failure = undefined;
	const items: Row[] = classes.flatMap(agentClass => [assignment(`chat-${agentClass}`, 'chat', agentClass),
		assignment(`planning-1-${agentClass}`, 'planning', agentClass), assignment(`planning-2-${agentClass}`, 'planning', agentClass)]);
	items.push(...classes.slice(0, 7).map(agentClass => assignment(`estimate-${agentClass}`, 'estimating', agentClass)));
	for (let index = 0; index < 6; index++) {
		items.push(assignment(`actor-${index}`, 'acting', classes[index]!, `work-${index}`));
		items.push(assignment(`review-${index}`, 'reviewing', 'reviewer', `work-${index}`, '2026-09-27T00:00:03Z', '2026-09-27T00:00:04Z'));
	}
	const requested = assignment('requested', 'reviewing', 'reviewer', 'work-0', '2026-09-27T00:00:03Z', '2026-09-27T00:00:04Z');
	requested.lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
	items.push(requested, assignment('revision', 'acting', 'architect', 'work-0', '2026-09-27T00:00:05Z', '2026-09-27T00:00:06Z'),
		assignment('approved-revision', 'reviewing', 'reviewer', 'work-0', '2026-09-27T00:00:07Z', '2026-09-27T00:00:08Z'));
	state.replies.set('workdays show', { run: { status: 'completed', executionMode: 'simulation', startedAt: '2026-09-27T00:00:00Z',
		completedAt: '2026-09-27T00:01:00Z', parameters: { durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
			appliedPlan: { planningRounds: [{ state: 'complete' }, { state: 'complete' }] } },
		reportRefs: { sdk: { projectId: 'sdk', path: 'notes/report.mdx', commit } } } });
	state.replies.set('assignments list', { items, page: { hasMore: false } });
	const nodes = Array.from({ length: 6 }, (_, index) => ['actor', 'reviewer'].map(pairRole => ({
		id: `${pairRole}-${index}`, workdayId, pairRole, workItemId: `work-${index}`, nodeRevision: 2, status: 'completed',
		sourceRef: { id: 'proposal', revision: 8 }, authorityRefs: [{ model: 'decision', id: 'decision-1' }] }))).flat();
	for (const node of nodes) for (const item of items.filter(item => item.assignmentAttempt.workItemId === node.workItemId
		&& item.assignmentAttempt.effectiveProfile.activity === (node.pairRole === 'actor' ? 'acting' : 'reviewing'))) {
		item.executionNodeId = node.id; item.executionNodeRevision = node.nodeRevision;
		Object.assign(item.assignmentAttempt, { nodeId: node.id, nodeRevision: node.nodeRevision, workdayId,
			sourceRef: structuredClone(node.sourceRef), authorityRefs: structuredClone(node.authorityRefs) });
	}
	state.replies.set('execution graph', { nodes });
	state.replies.set('capacity usage', { items: items.map(item => ({ id: `${item.id}:aggregate`, assignmentId: item.id,
		metadata: { settlementKey: item.id } })), page: { hasMore: false } });
	state.replies.set('library read', { result: { files: [{ body: `${workdayId} actor-0` }] } });
});

describe('golden read-back assertion regressions (fixtures are not live acceptance)', () => {
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
				Object.assign(item.assignmentAttempt, { nodeId: node.id, nodeRevision: 2, workdayId, sourceRef: { id: 'proposal', revision: 8 },
					authorityRefs: [{ model: 'decision', id: 'decision-1' }] });
				item.assignmentResult.assignmentId = item.id;
			}
			Object.assign(node, { status: 'stale', nodeRevision: 3, workItemId, sourceRef: { id: 'proposal', revision: 8 },
				authorityRefs: [{ model: 'decision', id: 'decision-1' }] });
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
		state.replies.get('workdays show')!.run.reportRefs = {};
		expect(() => gate('reporter')).toThrow('one exact report');
	});
});
