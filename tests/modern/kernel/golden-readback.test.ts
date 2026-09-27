import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const state = vi.hoisted(() => ({ cases: new Map<string, () => void>(), replies: new Map<string, Row>(), failure: undefined as Error | undefined, timeout: 0 }));
vi.mock('node:test', () => ({ default: (name: string, _options: unknown, run: () => void) => state.cases.set(name, run) }));
vi.mock('node:child_process', () => ({ execFileSync: (_command: string, args: string[], options: { timeout: number }) => {
	state.timeout = options.timeout;
	if (state.failure) throw state.failure;
	const key = args.slice(0, 2).join(' ');
	const result = state.replies.get(key);
	if (!result) throw new Error(`Unexpected acceptance read: ${key}`);
	return JSON.stringify({ ok: true, result });
} }));
const { read } = await import('../../acceptance/sdk-runtime-golden.test.ts');

const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
const workdayId = 'workday-test';
const commit = 'a'.repeat(40);
const gate = (name: string) => state.cases.get(`Golden runtime ${name} evidence satisfies its acceptance boundary`)!();
function assignment(id: string, activity: string, agentClass: string, workItemId = '', createdAt = '2026-09-27T00:00:01Z', completedAt = '2026-09-27T00:00:02Z'): Row {
	return { id, workDayId: workdayId, projectId: 'sdk', decisionId: 'decision-test', status: 'completed', leaseToken: null,
		createdAt, completedAt, assignmentAttempt: { agentClass, workItemId, effectiveProfile: { activity } },
		capacityEnvelope: { budget: { time: { executionStartedAt: createdAt, closeoutStartedAt: completedAt } } },
		assignmentResult: { status: 'completed', timingAwareness: { completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true },
			usage: { native: { activeSeconds: 1 } }, references: [{ kind: 'git', commit }] },
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
		items.push(assignment(`review-${index}`, 'reviewing', 'reviewer', `work-${index}`));
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
	state.replies.set('execution graph', { nodes: Array.from({ length: 6 }, (_, index) => ['actor', 'reviewer'].map(pairRole => ({
		id: `${pairRole}-${index}`, workdayId, pairRole, status: 'completed' }))).flat() });
	state.replies.set('capacity usage', { items: items.map(item => ({ id: `${item.id}:aggregate`, assignmentId: item.id,
		metadata: { settlementKey: item.id } })), page: { hasMore: false } });
	state.replies.set('library read', { result: { files: [{ body: `${workdayId} actor-0` }] } });
});

describe('golden read-back assertion regressions (fixtures are not live acceptance)', () => {
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
		expect(() => read(['workdays', 'show'], 'treeseed')).toThrow('ACCEPTANCE_CLI_COMMAND: ETIMEDOUT');
		expect(state.timeout).toBe(120000);
		state.failure = new Error('secret-must-not-leak');
		expect(() => read(['workdays', 'show'], 'treeseed')).toThrow('ACCEPTANCE_CLI_COMMAND: COMMAND_FAILED');
	});
	it('keeps seven normal read-back gates separate from stopped-run evidence', () => {
		expect(state.cases.size).toBe(8);
		for (const name of ['lifecycle', 'collaboration', 'graph', 'revision', 'results', 'settlement', 'reporter']) expect(() => gate(name)).not.toThrow();
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
		state.replies.get('workdays show')!.run.status = 'cancelled';
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
	it('does not confuse repeated single-role planning with collaborative cycles', () => {
		for (const item of state.replies.get('assignments list')!.items) if (item.assignmentAttempt.effectiveProfile.activity === 'planning') item.assignmentAttempt.agentClass = 'architect';
		expect(() => gate('collaboration')).toThrow('Two planning turns required for researcher');
	});
	it('rejects stale round completion despite sixteen planning assignments', () => {
		state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds[1].state = 'active';
		expect(() => gate('collaboration')).toThrow('Two completed graph planning cycles');
	});
	it('rejects incomplete generated pairs and absent real revision', () => {
		state.replies.get('execution graph')!.nodes.pop();
		expect(() => gate('graph')).toThrow();
		state.replies.get('execution graph')!.nodes.push({ workdayId, pairRole: 'reviewer', status: 'completed' });
		state.replies.get('assignments list')!.items = state.replies.get('assignments list')!.items.filter((item: Row) => item.id !== 'revision');
		expect(() => gate('revision')).toThrow('later real Actor revision');
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
