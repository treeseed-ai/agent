import { beforeEach, expect, it, vi } from 'vitest';
import { liveAssignmentGraph, liveAssignmentRecord } from './live-assignment-fixture.ts';

// Unit-only isolation of already separately covered profile/content boundaries.
// The real configured Kernel/public SDK integration exercises those boundaries.
const state = vi.hoisted(() => ({ item: {} as Record<string, any>, graph: {} as Record<string, any> }));
vi.mock('../../../acceptance/acceptance-cli.ts', async original => ({
	...await original<typeof import('../../../acceptance/acceptance-cli.ts')>(),
	read: (args: string[]) => args[0] === 'assignments' ? structuredClone(state.item)
		: args[0] === 'execution' ? structuredClone(state.graph) : {},
}));
vi.mock('../../../acceptance/workday/support/decision-evidence.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/decision-evidence.ts')>(), readGovernedContentFile: () => ({}),
}));
vi.mock('../../../acceptance/workday/support/assignment-authority.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/assignment-authority.ts')>(),
	verifyGovernedProfile: () => undefined, verifyHandlerInspection: () => undefined,
}));
const { inspectLiveAssignmentProfile, verifyLiveAssignmentGraph } = await import('../../../acceptance/workday/support/monitoring/live-assignment-records.ts');

beforeEach(() => {
	state.item = liveAssignmentRecord();
	state.item.assignmentAttempt.requiredCapabilities = ['code-change'];
	state.graph = liveAssignmentGraph(state.item);
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
	state.graph = structuredClone(before.graph); expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId)).not.toThrow();
});

it('denies missing independent graph before accepting a newly issued assignment', () => {
	state.graph = {};
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId)).toThrow('ACCEPTANCE_LIVE_GRAPH');
});

it('denies a missing owning allocation receipt before allowing a newly observed assignment to continue', () => {
	delete state.item.explanation.metadata;
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId)).toThrow('ACCEPTANCE_ALLOCATION_RECEIPT');
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
		expect.soft(() => inspectLiveAssignmentProfile(state.item, state.item.teamId)).toThrow('ACCEPTANCE_LIVE_GRAPH');
		expect(state).toEqual(before);
	}
});
