import { beforeEach, expect, it, vi } from 'vitest';
import { liveAssignmentGraph, liveAssignmentRecord, liveProviderSession, liveRun } from './live-assignment-fixture.ts';
import { reviewedDecision, reviewedRevisionFixture } from '../../kernel/architecture/custody/graph/review-readiness-fixture.ts';

// Unit-only isolation of already separately covered profile/content boundaries.
// The real configured Kernel/public SDK integration exercises those boundaries.
const state = vi.hoisted(() => ({ item: {} as Record<string, any>, graph: {} as Record<string, any>, run: {} as Record<string, any>, publications: [] as Record<string, any>[] }));
vi.mock('../../../acceptance/acceptance-cli.ts', async original => ({
	...await original<typeof import('../../../acceptance/acceptance-cli.ts')>(),
	read: (args: string[]) => args[0] === 'assignments' ? structuredClone(state.item)
		: args[0] === 'execution' ? structuredClone(state.graph) : args[0] === 'workdays' ? { run: structuredClone(state.run) }
			: args[0] === 'capacity' ? { items: structuredClone(state.publications), page: { limit: 100, hasMore: false, nextCursor: null } } : {},
}));
vi.mock('../../../acceptance/workday/support/decision-evidence.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/decision-evidence.ts')>(), readGovernedContentFile: () => ({}),
}));
vi.mock('../../../acceptance/workday/support/assignment-authority.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/assignment-authority.ts')>(),
	verifyGovernedProfile: () => undefined, verifyHandlerInspection: () => undefined,
}));
const { inspectLiveAssignmentProfile, verifyLiveAssignmentGraph, verifyLiveProviderRuntime } = await import('../../../acceptance/workday/support/monitoring/live-assignment-records.ts');

beforeEach(() => {
	state.item = liveAssignmentRecord();
	state.item.assignmentAttempt.requiredCapabilities = ['code-change'];
	state.graph = liveAssignmentGraph(state.item);
	state.run = liveRun(state.item);
	state.publications = [liveProviderSession(state.item)];
});

it('accepts exact independent graph authority without rewriting source observations and denies every substituted issued field', () => {
	const before = structuredClone(state);
	verifyLiveAssignmentGraph(state.item, state.graph); expect(state).toEqual(before);
	for (const field of ['teamId', 'projectId', 'nodeRevision', 'agentClass', 'workItemId', 'sourceRef', 'authorityRefs',
		'estimate', 'requiredCapabilities', 'acceptanceCriteria', 'workspace', 'kind', 'workdayId', 'graphRevisionCreated', 'graphRevisionUpdated']) {
		for (const value of [undefined, null, '', 'foreign-authority', 0, [], {}]) {
			if (value === undefined && (field === 'workdayId' || before.graph.nodes[0][field] === undefined)) continue;
			state.graph = structuredClone(before.graph); state.graph.nodes[0][field] = value;
			const denied = structuredClone(state);
			expect.soft(() => verifyLiveAssignmentGraph(state.item, state.graph), `${field}/${String(value)}`).toThrow();
			expect(state).toEqual(denied);
		}
	}
	state.graph = structuredClone(before.graph); state.graph.nodes.push(structuredClone(state.graph.nodes[0]));
	expect(() => verifyLiveAssignmentGraph(state.item, state.graph)).toThrow('ACCEPTANCE_LIVE_GRAPH');
	state.graph = structuredClone(before.graph); state.graph.nodes[0].sourceRef.id = ' proposal-with-whitespace ';
	expect(() => verifyLiveAssignmentGraph(state.item, state.graph)).toThrow('ACCEPTANCE_LIVE_GRAPH');
	state.graph = structuredClone(before.graph); delete state.graph.nodes[0].workdayId;
	expect(() => verifyLiveAssignmentGraph(state.item, state.graph)).not.toThrow(); // Shared governed nodes may omit a run binding.
	state.graph = structuredClone(before.graph); expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).not.toThrow();
});

it('denies missing independent graph before accepting a newly issued assignment', () => {
	state.graph = {};
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow('ACCEPTANCE_LIVE_GRAPH');
});

it('retains a legitimate earlier completed attempt when independently verified request-changes history advances its graph node', () => {
	const f = reviewedRevisionFixture(), review = f.assignments[1]!, decision = reviewedDecision(f);
	decision.disposition = 'request-changes';
	const before = structuredClone(f), decisions = new Map([[review.id, decision]]);
	expect(() => verifyLiveAssignmentGraph(f.assignments[0]!, f.graph, f.assignments, decisions)).not.toThrow();
	expect(f).toEqual(before);
	expect(() => verifyLiveAssignmentGraph(f.assignments[0]!, f.graph, f.assignments, new Map())).toThrow('ACCEPTANCE_LIVE_GRAPH');
	for (const change of [
		(value: Record<string, any>) => { value.disposition = 'approved'; },
		(value: Record<string, any>) => { value.subjectRef.commit = 'f'.repeat(40); },
		(value: Record<string, any>) => { value.authorityRefs = []; },
		(value: Record<string, any>) => { value.decidedByRefs = []; },
		(value: Record<string, any>) => { value.decidedAt = 'invalid'; },
	]) {
		const changed = structuredClone(decision); change(changed); const retained = structuredClone(changed);
		expect(() => verifyLiveAssignmentGraph(f.assignments[0]!, f.graph, f.assignments, new Map([[review.id, changed]]))).toThrow();
		expect(changed).toEqual(retained); expect(f).toEqual(before);
	}
	const skipped = structuredClone(f.graph); skipped.nodes[0]!.nodeRevision++;
	expect(() => verifyLiveAssignmentGraph(f.assignments[0]!, skipped, f.assignments, decisions)).toThrow('ACCEPTANCE_LIVE_GRAPH');
	expect(() => verifyLiveAssignmentGraph(f.assignments[0]!, f.graph, f.assignments, decisions)).not.toThrow();
});

it('denies a Git workspace base absent from original exact context before accepting matching assignment views', () => {
	state.item.assignmentAttempt.workspace.baseCommit = 'f'.repeat(40);
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow('ACCEPTANCE_INTEGRATION_BASE');
});

it('denies a missing owning allocation receipt before allowing a newly observed assignment to continue', () => {
	delete state.item.explanation.metadata;
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow('ACCEPTANCE_ALLOCATION_RECEIPT');
});

it('denies a predecessor result absent from the complete owning assignment inventory before campaign progress', () => {
	state.item.assignmentAttempt.predecessorResultIds = ['missing-original-result'];
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow('ACCEPTANCE_PREDECESSOR_MISSING');
});

it('denies absent independent provider publication rather than trusting the runtime build repeated in assignment views', () => {
	state.publications = [];
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow(/ACCEPTANCE_(AVAILABILITY|LIVE_RUNTIME)/u);
});

it('requires the exact independently published provider adapter build model and canonical limits while retaining unrelated histories', () => {
	const original = structuredClone(state.publications), item = structuredClone(state.item);
	verifyLiveProviderRuntime(item, original); expect(state.publications).toEqual(original);
	for (const change of [
		(value: Record<string, any>) => { value.providerId = 'foreign-provider'; },
		(value: Record<string, any>) => { value.teamId = 'foreign-team'; },
		(value: Record<string, any>) => { value.status = 'expired'; },
		(value: Record<string, any>) => { value.sequence = 0; },
		(value: Record<string, any>) => { value.openedAt = 'invalid'; },
		(value: Record<string, any>) => { value.openedAt = new Date(Date.parse(item.assignmentAttempt.createdAt) + 1).toISOString(); },
		(value: Record<string, any>) => { value.refreshedAt = 'invalid'; },
		(value: Record<string, any>) => { value.snapshot = {}; },
		(value: Record<string, any>) => { value.snapshot.adapters = []; },
		(value: Record<string, any>) => { value.snapshot.adapters.push(structuredClone(value.snapshot.adapters[0])); },
		(value: Record<string, any>) => { value.snapshot.adapters[0].id = 'foreign-adapter'; },
		(value: Record<string, any>) => { value.snapshot.adapters[0].runtimeBuild = `sha256:${'f'.repeat(64)}`; },
		(value: Record<string, any>) => { value.snapshot.adapters[0].nativeLimits = {}; },
		(value: Record<string, any>) => { value.snapshot.adapters[0].nativeLimits.modelConfigurationId = 'foreign-model'; },
	]) {
		const values = structuredClone(original); change(values[0]!); const before = structuredClone(values);
		expect(() => verifyLiveProviderRuntime(item, values)).toThrow('ACCEPTANCE_LIVE_RUNTIME'); expect(values).toEqual(before);
	}
	const unrelated = { ...original[0], id: 'unrelated-session', providerId: 'unrelated-provider' };
	const values = [unrelated, ...structuredClone(original)], before = structuredClone(values);
	verifyLiveProviderRuntime(item, values); expect(values).toEqual(before); expect(state.item).toEqual(item);
});

it('denies foreign source estimate node and graph revisions rather than accepting internally matching public assignment views', () => {
	const original = structuredClone(state.graph);
	for (const change of [
		() => { state.graph.teamId = 'foreign-team'; },
		() => { state.graph.revision = 0; },
		() => { state.graph.nodes = []; },
		() => { state.graph.nodes[0].nodeRevision++; },
		() => { state.graph.nodes[0].sourceRef.id = 'foreign-proposal'; },
		() => { state.graph.nodes[0].estimate.maximumSeconds++; },
	]) {
		state.graph = structuredClone(original); change();
		const before = structuredClone(state);
		expect.soft(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item])).toThrow('ACCEPTANCE_LIVE_GRAPH');
		expect(state).toEqual(before);
	}
});
