import { beforeEach, vi } from 'vitest';

export type Row = Record<string, any>;
const state = vi.hoisted(() => ({ cases: new Map<string, () => void>(), replies: new Map<string, Row>(), failure: undefined as Error | undefined, timeout: 0, args: [] as string[] }));
export { state };
vi.mock('node:test', () => ({ default: (name: string, _options: unknown, run: () => void) => state.cases.set(name, run) }));
vi.mock('node:child_process', () => ({ execFileSync: (_command: string, args: string[], options: { timeout: number }) => {
	state.timeout = options.timeout;
	state.args = args;
	if (state.failure) throw state.failure;
	const key = args.slice(0, 2).join(' ');
	const result = state.replies.get(key === 'library read' && args[3]?.startsWith('decisions/') ? `${key} ${args[3]}` : key);
	if (!result) throw new Error(`Unexpected acceptance read: ${key}`);
	return JSON.stringify({ ok: true, result });
} }));
await import('../../acceptance/sdk-runtime-golden.test.ts');
export const { read } = await import('../../acceptance/acceptance-cli.ts');

export const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
export const workdayId = 'workday-test';
export const commit = 'a'.repeat(40);
export const gate = (name: string) => state.cases.get(`Golden runtime ${name} evidence satisfies its acceptance boundary`)!();
export function assignment(id: string, activity: string, agentClass: string, workItemId = '', createdAt = '2026-09-27T00:00:01Z', completedAt = '2026-09-27T00:00:02Z'): Row {
	return { id, workDayId: workdayId, projectId: 'sdk', decisionId: 'decision-1', status: 'completed', leaseToken: null,
		createdAt, completedAt, assignmentAttempt: { agentClass, workItemId, effectiveProfile: { activity },
			estimate: { expectedSeconds: 300, maximumSeconds: 600 }, limits: { maximumSeconds: 10 } },
		capacityEnvelope: { requestedSeconds: 10, reservedSeconds: 10, budget: { time: { executionStartedAt: createdAt, closeoutStartedAt: completedAt } } },
		explanation: { metadata: { allocation: { admitted: true, allocatedSeconds: 10, desiredSeconds: 600, limitingConstraint: 'shared-model',
			calibration: { seconds: 600, multiplier: 2, measurementIds: [] }, constraints: [{ id: 'shared-model', remainingSeconds: 10 }],
			opportunity: { phase: 'planning', weight: 1, totalEligibleWeight: 1, shareSeconds: 10, availableSeconds: 10,
				remainingSupplySeconds: 10, committedSeconds: 0, planningCommittedSeconds: 0 } } } },
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
	const reportRef = { kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', path: 'notes/report.mdx', commit };
	const reporter = assignment('closeout-report', 'reporting', 'reporter', '', '2026-09-27T00:00:09Z', '2026-09-27T00:00:10Z');
	reporter.assignmentAttempt.sourceRef = { store: 'postgresql', model: 'workday', id: workdayId };
	reporter.assignmentResult.references = [structuredClone(reportRef)];
	items.push(reporter);
	state.replies.set('workdays show', { run: { status: 'completed', executionMode: 'simulation', startedAt: '2026-09-27T00:00:00Z',
		completedAt: '2026-09-27T00:01:00Z', parameters: { durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
			appliedPlan: { planningRounds: [{ state: 'complete' }, { state: 'complete' }] } },
		state: 'ended', endedAt: '2026-09-27T00:01:00Z', reportRef } });
	state.replies.set('assignments list', { items, page: { hasMore: false } });
	const nodes = Array.from({ length: 6 }, (_, index) => ['actor', 'reviewer'].map(pairRole => ({
		id: `${pairRole}-${index}`, projectId: 'sdk', workdayId, pairRole, workItemId: `work-${index}`, nodeRevision: 2, status: 'completed',
		sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 8, digest: `sha256:${'b'.repeat(64)}`,
			repository: 'sdk-library', commit, path: 'proposals/proposal.mdx' },
		authorityRefs: [{ store: 'treedx', model: 'decision', id: 'decision-1', revision: 1, digest: `sha256:${'c'.repeat(64)}`,
			repository: 'sdk-library', commit, path: 'decisions/decision-1.mdx' }] }))).flat();
	for (const node of nodes) for (const item of items.filter(item => item.assignmentAttempt.workItemId === node.workItemId
		&& item.assignmentAttempt.effectiveProfile.activity === (node.pairRole === 'actor' ? 'acting' : 'reviewing'))) {
		item.executionNodeId = node.id; item.executionNodeRevision = node.nodeRevision;
		Object.assign(item.assignmentAttempt, { nodeId: node.id, nodeRevision: node.nodeRevision, workdayId,
			sourceRef: structuredClone(node.sourceRef), authorityRefs: structuredClone(node.authorityRefs) });
	}
	state.replies.set('execution graph', { nodes });
	for (const item of items.filter(item => item.assignmentAttempt.effectiveProfile.activity === 'reviewing')) {
		const profileRef = { store: 'treedx', model: 'agent', id: 'configured-auditor', revision: 1, digest: `sha256:${'e'.repeat(64)}` };
		item.assignmentAttempt.effectiveProfile.profileRef = structuredClone(profileRef);
		const path = `decisions/${item.id}.mdx`;
		item.assignmentResult.references = [{ kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', commit, path }];
		state.replies.set(`library read ${path}`, { result: { resolvedRef: commit, files: [{ path, frontmatter: {
			schemaVersion: 'treeseed.decision/v1', id: item.id, projectId: 'sdk', decisionClass: 'work-review', decisionMethod: 'authority',
			subjectRef: { store: 'git', model: 'source', id: 'candidate', repository: 'sdk', commit },
			disposition: item.lifecycleOutput.activityCompletion.reviewDisposition, rationale: 'Synthetic independent review input, not live acceptance.',
			authorityRefs: [structuredClone(nodes[0]!.sourceRef)], decidedByRefs: [profileRef], decidedAt: item.completedAt } }] } });
	}
	state.replies.set('library read decisions/decision-1.mdx', { result: { resolvedRef: commit, files: [{ path: 'decisions/decision-1.mdx', frontmatter: {
		schemaVersion: 'treeseed.decision/v1', id: 'decision-1', projectId: 'sdk', decisionClass: 'proposal', decisionMethod: 'authority',
		subjectRef: structuredClone(nodes[0]!.sourceRef), disposition: 'approved', rationale: 'Synthetic complete Decision input, not live evidence.',
		authorityRefs: [structuredClone(nodes[0]!.sourceRef)], decidedByRefs: [{ store: 'treedx', model: 'agent', id: 'external-operator', revision: 1, digest: `sha256:${'d'.repeat(64)}` }],
		decidedAt: '2026-09-26T23:59:00Z' } }] } });
	state.replies.set('capacity usage', { items: items.map(item => ({ id: `${item.id}:aggregate`, assignmentId: item.id,
		metadata: { settlementKey: item.id } })), page: { hasMore: false } });
	state.replies.set('library read', { result: { resolvedRef: commit, files: [{ path: reportRef.path, body: `${workdayId} actor-0`, frontmatter: {
		schemaVersion: 'treeseed.note/v1', classification: 'workday-report', projectId: 'sdk', subjectRefs: [structuredClone(reporter.assignmentAttempt.sourceRef)] } }] } });
});
