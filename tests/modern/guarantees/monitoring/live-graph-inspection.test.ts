import { beforeEach, expect, it, vi } from 'vitest';
import { liveAssignmentRecord } from './live-assignment-fixture.ts';

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
const { inspectLiveAssignmentProfile } = await import('../../../acceptance/workday/support/monitoring/live-assignment-records.ts');

beforeEach(() => {
	state.item = liveAssignmentRecord();
	const attempt = state.item.assignmentAttempt;
	state.graph = { teamId: attempt.teamId, revision: attempt.graphRevision, nodes: [{
		id: attempt.nodeId, teamId: attempt.teamId, projectId: attempt.projectId, nodeRevision: attempt.nodeRevision,
		sourceRef: structuredClone(attempt.sourceRef), estimate: structuredClone(attempt.estimate),
	}], edges: [] };
});

it('denies missing independent graph before accepting a newly issued assignment', () => {
	state.graph = {};
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId)).toThrow('ACCEPTANCE_LIVE_GRAPH');
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
