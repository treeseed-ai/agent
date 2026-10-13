import { beforeEach, expect, it, vi } from 'vitest';
import { liveAssignmentGraph, liveAssignmentRecord, liveProviderSession, liveRun } from './live-assignment-fixture.ts';
import { reviewedDecision, reviewedRevisionFixture } from '../../kernel/architecture/custody/graph/review-readiness-fixture.ts';
import { contextPredecessor, exactContext } from '../../kernel/architecture/portable/context-fixture.ts';

// Unit-only isolation of already separately covered profile/content boundaries.
// The real configured Kernel/public SDK integration exercises those boundaries.
const state = vi.hoisted(() => ({ item: {} as Record<string, any>, graph: {} as Record<string, any>, run: {} as Record<string, any>, publications: [] as Record<string, any>[], frozen: {} as Record<string, unknown> }));
vi.mock('../../../acceptance/acceptance-cli.ts', async original => ({
	...await original<typeof import('../../../acceptance/acceptance-cli.ts')>(),
	read: (args: string[]) => args[0] === 'assignments' ? structuredClone(state.item)
		: args[0] === 'execution' ? structuredClone(state.graph) : args[0] === 'workdays' ? { run: structuredClone(state.run) }
			: args[0] === 'capacity' ? { items: structuredClone(state.publications), page: { limit: 100, hasMore: false, nextCursor: null } }
			: args[0] === 'library' && args[1] === 'show' ? { project: { id: args[2], slug: 'sdk', teamId: state.item.teamId },
				library: { projectId: args[2], teamId: state.item.teamId, repositoryId: state.item.assignmentAttempt.contextRefs.find((ref: Record<string, unknown>) => ref.store === 'treedx')?.repository } } : {},
}));
vi.mock('../../../acceptance/workday/support/decision-evidence.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/decision-evidence.ts')>(), readGovernedContentFile: () => ({}),
}));
vi.mock('../../../acceptance/workday/support/assignment-authority.ts', async original => ({
	...await original<typeof import('../../../acceptance/workday/support/assignment-authority.ts')>(),
	verifyGovernedProfile: () => undefined, verifyHandlerInspection: () => undefined,
}));
const { inspectLiveAssignmentProfile, verifyLiveAssignmentGraph, verifyLiveProviderRuntime, verifyLiveSimulationWorkspace, verifyLiveSourceContext } = await import('../../../acceptance/workday/support/monitoring/live-assignment-records.ts');

beforeEach(() => {
	state.item = liveAssignmentRecord();
	state.item.assignmentAttempt.requiredCapabilities = ['code-change'];
	state.frozen = Object.fromEntries(state.item.assignmentAttempt.contextRefs.filter((ref: Record<string, any>) => ref.store === 'git').map((ref: Record<string, any>) => [ref.repository, ref.commit]));
	state.graph = liveAssignmentGraph(state.item);
	state.run = liveRun(state.item);
	state.publications = [liveProviderSession(state.item)];
});

it('denies an omitted requested tool even when public assignment views and remaining grant fields agree', () => {
	state.item.assignmentAttempt.effectiveProfile.permissionCeiling.tools.push('verification');
	state.graph = liveAssignmentGraph(state.item);
	const held = structuredClone(state);
	expect(() => inspectLiveAssignmentProfile(state.item, 'team', [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_GRAPH');
	expect(state).toEqual(held);
});

it('denies starting on the frozen base instead of the original consumed Git candidate even when both exact commits remain in context', () => {
	const attempt = state.item.assignmentAttempt, repository = attempt.workspace.repository, candidate = 'f'.repeat(40);
	const result = contextPredecessor(attempt, 'original-result', 'original-attempt', candidate);
	const previous = { id: result.assignmentId, status: 'completed', assignmentResult: result };
	attempt.predecessorResultIds = [result.id];
	attempt.contextRefs.push({ store: 'git', model: 'repository', id: 'consumed-source', repository, commit: candidate });
	attempt.workspace.baseCommit = candidate;
	expect(() => verifyLiveSourceContext(state.item, [previous, state.item], state.frozen)).not.toThrow();
	attempt.workspace.baseCommit = state.frozen[repository]; const before = structuredClone(state);
	expect(() => verifyLiveSourceContext(state.item, [previous, state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_SOURCE_BASE');
	expect(state).toEqual(before);
});

it('denies a self-consistent granted Book when its independent original content read is missing before live admission continues', () => {
	const { ref } = exactContext();
	state.item.assignmentAttempt.contextRefs.push(ref);
	state.item.assignmentAttempt.grant.contentRead.push(ref);
	state.item.assignmentAttempt.effectiveProfile.permissionCeiling.content.read.push('book');
	const before = structuredClone(state);
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_CONTEXT');
	expect(state).toEqual(before);
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
	state.graph = structuredClone(before.graph); expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).not.toThrow();
});

it('denies missing independent graph before accepting a newly issued assignment', () => {
	state.graph = {};
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_GRAPH');
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
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_INTEGRATION_BASE');
});

it('denies a foreign simulation branch before accepting matching assignment views', () => {
	state.item.assignmentAttempt.workspace.branch = 'simulation/foreign-campaign/workday/assignment';
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_WORKSPACE');
});

it('denies writable paths outside the original simulation workspace contract', () => {
	state.item.assignmentAttempt.workspace.writablePaths = ['docs'];
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_WORKSPACE');
});

it('retains exact simulation workspace authority and rejects malformed or substituted branch scope without rewriting observations', () => {
	const original = structuredClone(state);
	verifyLiveSimulationWorkspace(state.item, state.run); expect(state).toEqual(original);
	for (const field of ['branch', 'writablePaths']) for (const value of [undefined, null, '', [], ['docs'], ['.', '.'], 'simulation/foreign']) {
		state.item = structuredClone(original.item); state.item.assignmentAttempt.workspace[field] = value;
		const denied = structuredClone(state.item);
		expect(() => verifyLiveSimulationWorkspace(state.item, state.run)).toThrow(); expect(state.item).toEqual(denied);
	}
	state.item = structuredClone(original.item);
	for (const value of [undefined, '', 'foreign-workday']) {
		const run = { ...state.run, id: value }; expect(() => verifyLiveSimulationWorkspace(state.item, run)).toThrow('ACCEPTANCE_LIVE_WORKSPACE');
	}
	verifyLiveSimulationWorkspace(state.item, state.run); expect(state).toEqual(original);
});

it('retains original provider publication when a later session opens after the observed assignment was issued', () => {
	const original = liveProviderSession(state.item), later = structuredClone(original);
	later.id = 'later-runtime-session'; later.openedAt = new Date(Date.parse(String(original.openedAt)) + 1000).toISOString(); later.refreshedAt = later.openedAt;
	const observations = [later, original], before = structuredClone(observations);
	expect(() => verifyLiveProviderRuntime(state.item, observations)).not.toThrow();
	expect(observations).toEqual(before);
});

it.each(['sourceRef', 'authorityRefs'] as const)('denies self-consistent omission of original exact %s from both grant and context', field => {
	const ref = { store: 'treedx', model: field === 'sourceRef' ? 'proposal' : 'decision', id: 'original-governed-input',
		repository: 'native-library', commit: 'e'.repeat(40), path: field === 'sourceRef' ? 'proposals/original.md' : 'decisions/original.md' };
	if (field === 'sourceRef') state.item.assignmentAttempt.sourceRef = ref;
	else state.item.assignmentAttempt.authorityRefs = [ref];
	const before = structuredClone(state.item);
	expect(() => verifyLiveSourceContext(state.item, [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
	expect(state.item).toEqual(before);
});

it('denies a self-consistent foreign Git base and context against the original frozen source', () => {
	const original = structuredClone(state.item.assignmentAttempt.contextRefs.find((ref: Record<string, any>) => ref.store === 'git'));
	state.item.assignmentAttempt.workspace.baseCommit = 'f'.repeat(40);
	for (const ref of state.item.assignmentAttempt.contextRefs) if (ref.store === 'git') ref.commit = 'f'.repeat(40);
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], { [original.repository]: original.commit }))
		.toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
});

it('requires every frozen source and exact granted content while retaining original context and rejecting unissued commits', () => {
	const original = structuredClone(state), base = Object.values(state.frozen)[0];
	verifyLiveSourceContext(state.item, [state.item], state.frozen); expect(state).toEqual(original);
	for (const frozen of [{}, { 'treeseed-ai/sdk': '' }, { 'treeseed-ai/sdk': 'staging' }, { 'treeseed-ai/sdk': 'f'.repeat(40) }])
		expect(() => verifyLiveSourceContext(state.item, [state.item], frozen)).toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
	for (const commit of [undefined, '', 'staging', 'f'.repeat(40)]) {
		const item = structuredClone(state.item); item.assignmentAttempt.contextRefs[0].commit = commit;
		const before = structuredClone(item); expect(() => verifyLiveSourceContext(item, [item], state.frozen)).toThrow(); expect(item).toEqual(before);
	}
	const extra = structuredClone(state.item);
	extra.assignmentAttempt.contextRefs.push({ ...extra.assignmentAttempt.contextRefs[0], id: 'foreign-source', commit: 'f'.repeat(40) });
	expect(() => verifyLiveSourceContext(extra, [extra], state.frozen)).toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
	const missing = structuredClone(state.item), reference = { store: 'treedx', model: 'proposal', id: 'governed-input', repository: 'native-library', commit: base, path: 'proposals/input.md' };
	missing.assignmentAttempt.grant.contentRead.push(reference);
	expect(() => verifyLiveSourceContext(missing, [missing], state.frozen)).toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
	missing.assignmentAttempt.contextRefs.push(reference);
	expect(() => verifyLiveSourceContext(missing, [missing], state.frozen)).not.toThrow(); expect(state).toEqual(original);
});

it('denies a missing owning allocation receipt before allowing a newly observed assignment to continue', () => {
	delete state.item.explanation.metadata;
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_ALLOCATION_RECEIPT');
});

it('denies a predecessor result absent from the complete owning assignment inventory before campaign progress', () => {
	state.item.assignmentAttempt.predecessorResultIds = ['missing-original-result'];
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_PREDECESSOR_MISSING');
});

it('denies absent independent provider publication rather than trusting the runtime build repeated in assignment views', () => {
	state.publications = [];
	expect(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow(/ACCEPTANCE_(AVAILABILITY|LIVE_RUNTIME)/u);
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
		expect.soft(() => inspectLiveAssignmentProfile(state.item, state.item.teamId, [state.item], state.frozen)).toThrow('ACCEPTANCE_LIVE_GRAPH');
		expect(state).toEqual(before);
	}
});
