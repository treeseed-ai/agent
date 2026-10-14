import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assignmentAttemptSchema, assignmentResultSchema, capabilityAccountingLimitsSchema, executionNodeSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { simulationSourceBranch } from '@treeseed/sdk/capacity-provider/sandbox';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import { verifyAssignmentAuthority, verifyGitInputContext, verifyGovernedProfile, verifyHandlerInspection } from '../assignment-authority.ts';
import { readGovernedContentFile, readWorkReviewDecision, verifyWorkReview } from '../decision-evidence.ts';
import { verifyAppliedWorkdayCustody, verifyDerivedWorkdayModes } from '../campaign-observation.ts';
import { verifyGraphProvenance, verifyPredecessorCustody } from '../evidence-pages.ts';
import { verifyAllocation } from './assignment-allocation.ts';
import { availabilityHistory } from './provider-history.ts';
import { inspectAssignmentContext } from './assignment-context.ts';

const issuedAuthority = ({ status: _status, startedAt: _started, finishedAt: _finished, ...value }: Row) => value;

/** Compare the issued build/model with original owning provider publication. */
export function verifyLiveProviderRuntime(item: Row, publications: readonly Row[]): void {
	const code = 'ACCEPTANCE_LIVE_RUNTIME', attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	const owners = publications.filter(value => value.providerId === attempt.provider.providerId && value.teamId === attempt.teamId
			&& Date.parse(String(value.openedAt)) <= Date.parse(attempt.createdAt))
		.sort((a, b) => Date.parse(String(b.openedAt)) - Date.parse(String(a.openedAt)) || String(b.id).localeCompare(String(a.id)));
	const latest = owners[0];
	assert.ok(latest && ['open', 'closed'].includes(String(latest.status)) && Number.isSafeInteger(latest.sequence) && Number(latest.sequence) >= 1,
		`${code}: Complete independently observed provider publication required`);
	const opened = Date.parse(String(latest.openedAt)), refreshed = Date.parse(String(latest.refreshedAt));
	assert.ok(Number.isFinite(opened) && Number.isFinite(refreshed) && opened <= Date.parse(attempt.createdAt) && refreshed >= opened,
		`${code}: Original publication clocks do not cover the issued provider`);
	const snapshot = row(latest.snapshot);
	assert.ok(Array.isArray(snapshot.adapters) && snapshot.adapters.length > 0, `${code}: Original executable adapter inventory required`);
	const adapters = snapshot.adapters.map(row);
	assert.ok(adapters.every(value => typeof value.id === 'string' && value.id) && new Set(adapters.map(value => value.id)).size === adapters.length,
		`${code}: Unique executable adapter identities required`);
	const selected = adapters.filter(value => value.id === attempt.provider.executionProviderId);
	assert.equal(selected.length, 1, `${code}: Exact original execution provider required`);
	assert.equal(selected[0]!.runtimeBuild, attempt.provider.runtimeBuild, `${code}: Issued build differs from independent provider publication`);
	const limits = capabilityAccountingLimitsSchema.safeParse(selected[0]!.nativeLimits);
	assert.ok(limits.success, `${code}: Original model/capability limits required`);
	assert.deepEqual(limits.data, selected[0]!.nativeLimits, `${code}: Original limits must not be normalized`);
	assert.equal(limits.data.modelConfigurationId, attempt.provider.modelConfigurationId, `${code}: Foreign model configuration`);
}

/** A matching list/show pair cannot establish independent graph authority. */
export function verifyLiveAssignmentGraph(item: Row, graph: Row, items: readonly Row[] = [item], decisions: ReadonlyMap<string, Row> = new Map()): void {
	const code = 'ACCEPTANCE_LIVE_GRAPH', attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	assert.equal(graph.teamId, attempt.teamId, `${code}: Foreign graph`);
	assert.ok(Number.isSafeInteger(graph.revision) && Number(graph.revision) >= attempt.graphRevision,
		`${code}: Original issued graph revision is missing or in the future`);
	assert.ok(Array.isArray(graph.nodes), `${code}: Complete owning graph required`);
	const matches = graph.nodes.filter((node: Row) => node?.id === attempt.nodeId);
	assert.equal(matches.length, 1, `${code}: Unique independent owning node required`);
	const parsed = executionNodeSchema.safeParse(matches[0]);
	assert.ok(parsed.success, `${code}: Canonical independent owning node required`);
	const node = parsed.data;
	assert.deepEqual(node, matches[0], `${code}: Original graph node must not be normalized`);
	assert.ok(node.requestedPermissions, `${code}: Original authored permission request required`);
	assert.deepEqual([...attempt.grant.tools].sort(), [...node.requestedPermissions.tools].sort(),
		`${code}: Exact authored tool grant required; omitted tools are not complete authority`);
	for (const field of ['teamId', 'projectId', 'agentClass', 'workItemId', 'sourceRef', 'authorityRefs',
		'estimate', 'requiredCapabilities', 'acceptanceCriteria'] as const)
		assert.deepEqual(node[field], attempt[field], `${code}: Issued ${field} differs from independent graph`);
	if (node.workdayId !== undefined) assert.equal(node.workdayId, attempt.workdayId, `${code}: Foreign node workday`);
	assert.equal(node.kind, attempt.effectiveProfile.activity === 'chat' ? 'communication' : attempt.effectiveProfile.activity,
		`${code}: Activity differs from graph authority`);
	assert.equal(node.workspace, attempt.workspace.mode, `${code}: Workspace differs from graph authority`);
	assert.ok(node.graphRevisionCreated <= attempt.graphRevision && node.graphRevisionUpdated <= Number(graph.revision),
		`${code}: Node does not belong to the original issued graph history`);
	verifyGraphProvenance(graph);
	assert.ok(node.nodeRevision >= attempt.nodeRevision, `${code}: Graph cannot precede issued node revision`);
	if (node.nodeRevision === attempt.nodeRevision) return;
	// An older result can first appear after its real paired review advanced the
	// node. Only original independently read classed Decisions explain that gap.
	const pairs = (graph.edges as Row[]).filter(edge => edge.provenance === 'review-pair' && edge.graphRevisionRemoved === undefined
		&& (node.pairRole === 'actor' ? edge.fromNodeId === node.id : node.pairRole === 'reviewer' && edge.toNodeId === node.id));
	assert.equal(pairs.length, 1, `${code}: Original pair required for advanced node history`);
	const pair = pairs[0]!, revisions = new Set<number>();
	for (const review of items) {
		const issued = assignmentAttemptSchema.parse(review.assignmentAttempt);
		if (issued.nodeId !== pair.toNodeId || issued.workdayId !== attempt.workdayId || issued.projectId !== attempt.projectId
			|| issued.teamId !== attempt.teamId || issued.nodeRevision < attempt.nodeRevision || issued.nodeRevision >= node.nodeRevision
			|| Date.parse(String(review.completedAt)) < Date.parse(attempt.createdAt)
			|| row(row(review.lifecycleOutput).activityCompletion).reviewDisposition !== 'request-changes') continue;
		assert.equal(review.status, 'completed', `${code}: Unfinished review cannot advance authority`);
		assert.deepEqual(issued.sourceRef, attempt.sourceRef, `${code}: Foreign revision authority`);
		const actors = items.filter(value => row(value.assignmentAttempt).nodeId === pair.fromNodeId
			&& issued.predecessorResultIds.includes(String(row(value.assignmentResult).id)));
		assert.equal(actors.length, 1, `${code}: Original exact reviewed Actor required`);
		const decision = decisions.get(String(review.id)); assert.ok(decision, `${code}: Original governed revision Decision required`);
		verifyWorkReview(review, actors[0]!, decision, 'request-changes');
		assert.ok(!revisions.has(issued.nodeRevision), `${code}: Duplicate revision authority`); revisions.add(issued.nodeRevision);
	}
	assert.equal(attempt.nodeRevision + revisions.size, node.nodeRevision, `${code}: Every advanced revision needs independent original authority`);
}

/** Existing simulation branch derivation and owning API whole-checkout scope. */
export function verifyLiveSimulationWorkspace(item: Row, run: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), code = 'ACCEPTANCE_LIVE_WORKSPACE';
	assert.equal(run.executionMode, 'simulation', `${code}: Original simulation authority required`);
	if (attempt.workspace.mode !== 'git') return;
	assert.ok(typeof run.id === 'string' && run.id === attempt.workdayId, `${code}: Exact owning workday required`);
	assert.equal(attempt.workspace.branch, simulationSourceBranch(String(row(run.parameters).acceptanceCampaignId || 'local'), run.id, attempt.id),
		`${code}: Exact campaign/workday/assignment branch required`);
	assert.deepEqual(attempt.workspace.writablePaths, ['.'], `${code}: Exact original simulation checkout write scope required`);
}

/** Compare source context with frozen bases and original consumed results. */
export function verifyLiveSourceContext(item: Row, items: readonly Row[], frozenBases: Readonly<Record<string, unknown>>, graph?: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), code = 'ACCEPTANCE_LIVE_SOURCE_CONTEXT';
	assert.ok(frozenBases && typeof frozenBases === 'object' && !Array.isArray(frozenBases), `${code}: Original frozen source inventory required`);
	const predecessors = items.filter(value => attempt.predecessorResultIds.includes(String(row(value.assignmentResult).id)))
		.flatMap(value => assignmentResultSchema.parse(value.assignmentResult).references);
	for (const repository of attempt.grant.sourceRead) {
		const base = frozenBases[repository]; assert.ok(typeof base === 'string' && /^[a-f0-9]{40}$/u.test(base), `${code}: Exact frozen repository base required`);
		const refs = attempt.contextRefs.filter(ref => ref.store === 'git' && ref.repository === repository);
		assert.ok(refs.some(ref => ref.commit === base), `${code}: Original frozen source omitted`);
		const consumed = predecessors.filter((ref): ref is Extract<typeof ref, { kind: 'git' }> => ref.kind === 'git' && ref.repository === repository);
		const allowed = new Set([base, ...consumed.map(ref => ref.commit)]);
		assert.ok(refs.every(ref => ref.commit && allowed.has(ref.commit)), `${code}: Unissued foreign source context`);
		for (const ref of consumed) assert.ok(refs.some(value => value.commit === ref.commit), `${code}: Original consumed source omitted`);
	}
	for (const reference of [attempt.sourceRef, ...attempt.authorityRefs]) {
		if (!reference.repository || !reference.commit || reference.store !== 'treedx' || !reference.path) continue;
		assert.ok(attempt.contextRefs.some(ref => isDeepStrictEqual(ref, reference)), `${code}: Original governing context omitted`);
		assert.ok(attempt.grant.contentRead.some(ref => isDeepStrictEqual(ref, reference)), `${code}: Original governing content grant omitted`);
	}
	for (const reference of attempt.grant.contentRead)
		assert.ok(attempt.contextRefs.some(ref => isDeepStrictEqual(ref, reference)), `${code}: Original exact granted content omitted`);
	verifyGitInputContext(item, predecessors);
	verifyLiveWorkspaceBase(item, items, frozenBases, graph);
}

/** An allowed context commit is not necessarily the correct execution base. */
export function verifyLiveWorkspaceBase(item: Row, items: readonly Row[], frozenBases: Readonly<Record<string, unknown>>, graph?: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), code = 'ACCEPTANCE_LIVE_SOURCE_BASE';
	if (attempt.workspace.mode !== 'git') return;
	const repository = attempt.workspace.repository, frozen = frozenBases[repository];
	assert.ok(typeof frozen === 'string' && /^[a-f0-9]{40}$/u.test(frozen), `${code}: Original frozen base required`);
	const consumed = items.filter(value => attempt.predecessorResultIds.includes(String(row(value.assignmentResult).id)))
		.map(value => ({ item: value, result: assignmentResultSchema.parse(value.assignmentResult) }))
		.map(value => ({ ...value, commits: [...new Set(value.result.references.flatMap(ref => ref.kind === 'git' && ref.repository === repository ? [ref.commit] : []))] }))
		.filter(value => value.commits.length > 0);
	const commits = [...new Set(consumed.flatMap(value => value.commits))];
	let expected: string = commits[0] ?? frozen;
	if (commits.length > 1 && attempt.effectiveProfile.activity === 'acting' && attempt.grant.tools.includes('release')) expected = frozen;
	else if (commits.length > 1) {
		assert.ok(consumed.every(value => value.commits.length === 1), `${code}: Ambiguous original source result`);
		const entries = new Map(consumed.map(value => [value.result.id, { ...value, attempt: assignmentAttemptSchema.parse(value.item.assignmentAttempt) }]));
		assert.equal(entries.size, consumed.length, `${code}: Duplicate source result authority`);
		const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
			assert.ok(!visiting.has(id), `${code}: Cyclic source result lineage`); visiting.add(id);
			const found = new Set<string>();
			for (const predecessor of entries.get(id)!.attempt.predecessorResultIds) {
				if (!entries.has(predecessor)) continue;
				found.add(predecessor); for (const earlier of ancestors(predecessor, visiting)) found.add(earlier);
			}
			visiting.delete(id); return found;
		};
		const lineage = [...entries.values()].map(value => ({ ...value, ancestors: ancestors(value.result.id) }));
		const terminal = lineage.filter(value => value.ancestors.size === entries.size - 1);
		assert.ok(terminal.length <= 1, `${code}: Ambiguous terminal source lineage`);
		if (terminal.length === 1) expected = terminal[0]!.commits[0]!;
		else {
			// A revised Actor may also retain its own older candidate. The original
			// immediate reviewed predecessor, rather than that older candidate, is base.
			assert.ok(graph && graph.teamId === attempt.teamId && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
				&& attempt.nodeRevision > 1 && attempt.effectiveProfile.activity === 'acting', `${code}: Independent revised graph authority required`);
			const nodes = (graph.nodes as Row[]).map(value => executionNodeSchema.parse(value));
			const selected = nodes.filter(node => node.id === attempt.nodeId);
			assert.ok(selected.length === 1 && selected[0]!.pairRole === 'actor', `${code}: Original revised Actor required`);
			const edges = (graph.edges as Row[]).filter(edge => Number(edge.graphRevisionCreated) <= attempt.graphRevision
				&& (edge.graphRevisionRemoved === undefined || Number(edge.graphRevisionRemoved) > attempt.graphRevision));
			const direct = new Set<string>();
			for (const edge of edges.filter(value => value.toNodeId === attempt.nodeId)) {
				const source = nodes.find(node => node.id === edge.fromNodeId); assert.ok(source, `${code}: Original predecessor node required`);
				if (source.kind === 'condition') continue;
				direct.add(source.id);
				if (source.pairRole === 'reviewer') {
					const pairs = edges.filter(value => value.toNodeId === source.id && value.provenance === 'review-pair');
					assert.equal(pairs.length, 1, `${code}: Original immediate reviewed Actor required`); direct.add(String(pairs[0]!.fromNodeId));
				}
			}
			const candidates = [...new Set(lineage.filter(value => direct.has(value.attempt.nodeId)).flatMap(value => value.commits))];
			assert.equal(candidates.length, 1, `${code}: One exact original immediate predecessor base required`); expected = candidates[0]!;
		}
	}
	assert.equal(attempt.workspace.baseCommit, expected, `${code}: Workspace does not start on the original required source`);
}

export function inspectLiveAssignmentProfile(item: Row, team: string, items: readonly Row[], frozenBases: Readonly<Record<string, unknown>>): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
	const shown = read(['assignments', 'show', attempt.id], team);
	assert.ok(validateProviderAssignment(shown).ok, 'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public record is malformed');
	assert.deepEqual(issuedAuthority(row(shown.assignmentAttempt)), issuedAuthority(attempt),
		'ACCEPTANCE_LIVE_ASSIGNMENT: Independent public view changed issued authority');
	const graph = read(['execution', 'graph', 'show'], team);
	assert.ok(Array.isArray(items) && items.some(value => value.id === attempt.id), 'ACCEPTANCE_LIVE_ASSIGNMENT: Complete original assignment inventory required');
	const decisions = new Map<string, Row>(), content = new Map<string, Row>();
	if (Array.isArray(graph.nodes) && graph.nodes.some(value => row(value).id === attempt.nodeId && Number(row(value).nodeRevision) > attempt.nodeRevision)) {
		for (const review of items) if (review.status === 'completed' && row(review.assignmentAttempt).workdayId === attempt.workdayId
			&& isDeepStrictEqual(row(review.assignmentAttempt).sourceRef, attempt.sourceRef)
			&& row(row(review.lifecycleOutput).activityCompletion).reviewDisposition === 'request-changes')
			decisions.set(String(review.id), readWorkReviewDecision(review, team, content));
	}
	verifyLiveAssignmentGraph(item, graph, items, decisions);
	verifyPredecessorCustody([...items], graph);
	verifyLiveSourceContext(item, items, frozenBases, graph);
	const run = row(read(['workdays', 'show', attempt.workdayId], team).run);
	assert.equal(run.id, attempt.workdayId, 'ACCEPTANCE_LIVE_ASSIGNMENT: Foreign owning workday');
	assert.equal(run.teamId, attempt.teamId, 'ACCEPTANCE_LIVE_ASSIGNMENT: Foreign owning team');
	verifyAppliedWorkdayCustody(run);
	verifyLiveSimulationWorkspace(item, run);
	verifyAllocation(shown, run);
	verifyLiveProviderRuntime(item, availabilityHistory(team));
	verifyGovernedProfile(item, readGovernedContentFile(profile.profileRef, attempt.projectId, team, new Map(), 'ACCEPTANCE_LIVE_PROFILE'), graph);
	inspectAssignmentContext(item, team);
	const catalog = read(['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local'], team, true);
	const selected = read(['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local'], team, true);
	verifyHandlerInspection(item, catalog, selected);
	verifyLiveAssignmentGraph(item, read(['execution', 'graph', 'show'], team), items, decisions);
}

/** Observe the existing canonical records before campaign progress. This is
 * record/profile/grant custody. Public graph inspection is mandatory for each
 * new record; provider completeness remains a separate owning observation. */
export function observeLiveAssignmentRecords(run: Row, items: readonly Row[], retained: Map<string, Row>, inspect: (item: Row) => void): void {
	const label = 'ACCEPTANCE_LIVE_ASSIGNMENT';
	assert.ok(typeof run.id === 'string' && run.id && typeof run.teamId === 'string' && run.teamId, `${label}: Exact workday and team required`);
	assert.equal(run.executionMode, 'simulation', `${label}: Workday is the sole mode authority`);
	const plan = verifyAppliedWorkdayCustody(run), workdayEnd = Date.parse(plan.endsAt);
	const started = Date.parse(String(run.startedAt)), projects = row(run.parameters).scheduledProjectIds;
	assert.ok(Number.isFinite(started) && Array.isArray(projects) && projects.length > 0
		&& projects.every(value => typeof value === 'string' && value) && new Set(projects).size === projects.length,
		`${label}: Original start and complete admitted project selection required`);
	const observed = new Map<string, Row>(), pending: Row[] = [];
	verifyDerivedWorkdayModes(run, items);
	for (const item of items) {
		assert.ok(validateProviderAssignment(item).ok, `${label}: Complete unchanged canonical public record required`);
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.ok(!observed.has(attempt.id), `${label}: Duplicate attempt identity`);
		assert.equal(attempt.workdayId, run.id, `${label}: Foreign workday`);
		assert.equal(attempt.teamId, run.teamId, `${label}: Foreign team`);
		assert.ok(projects.includes(attempt.projectId), `${label}: Unselected project`);
		const created = Date.parse(attempt.createdAt), deadline = Date.parse(attempt.deadline);
		assert.ok(created >= started && deadline > created, `${label}: Original admission clock required`);
		assert.ok(deadline <= workdayEnd, `${label}: Original workday deadline cannot be extended`);
		const executionStart = attempt.startedAt === undefined ? created : Date.parse(attempt.startedAt);
		assert.ok(executionStart >= created && (attempt.finishedAt === undefined || Date.parse(attempt.finishedAt) >= executionStart),
			`${label}: Original lifecycle clock order required`);
		// Late failed closeout remains observed truth; this does not move or
		// extend the original execution deadline or permit campaign progress.
		verifyAssignmentAuthority(item);
		const previous = retained.get(attempt.id);
		if (previous) {
			// API alone advances these lifecycle fields. Every issued authority
			// field, including estimates, limits, runtime and deadline, is fixed.
			assert.deepEqual(issuedAuthority(attempt), issuedAuthority(previous), `${label}: Issued authority changed`);
			const active = ['created', 'leased', 'running'], prior = active.indexOf(String(previous.status)), next = active.indexOf(attempt.status);
			assert.ok(prior < 0 ? attempt.status === previous.status : next < 0 || next >= prior,
				`${label}: Lifecycle status regressed or changed terminal disposition`);
			for (const field of ['startedAt', 'finishedAt']) if (previous[field] !== undefined)
				assert.equal(attempt[field as 'startedAt' | 'finishedAt'], previous[field], `${label}: Original lifecycle clock changed`);
		} else pending.push(item);
		observed.set(attempt.id, structuredClone(attempt));
	}
	for (const id of retained.keys()) assert.ok(observed.has(id), `${label}: Previously observed attempt disappeared`);
	// A denied later record or public inspection must preserve the entire prior
	// observation. Do not repair inputs or cache a partly verified new batch.
	for (const item of pending) inspect(item);
	for (const [id, attempt] of observed) retained.set(id, attempt);
}
export function phaseBoundaryCancelled(item: Row, run: Row): boolean {
	const parameters = row(run.parameters), time = row(row(row(item.capacityEnvelope).budget).time);
	const boundary = Date.parse(normalText(run.startedAt)) + Number(parameters.durationSeconds) * Number(parameters.planningPercent) * 10;
	return Number.isFinite(boundary) && item.status === 'cancelled' && item.lifecycleCode === 'planning_boundary_cancelled'
		&& ['planning','estimating'].includes(normalText(row(row(item.assignmentAttempt).effectiveProfile).activity))
		&& Date.parse(normalText(time.authorityDeadlineAt)) === boundary
		&& Date.parse(normalText(time.executionDeadlineAt ?? time.preparationDeadlineAt)) === boundary
		&& Date.parse(normalText(item.failedAt)) >= boundary
		&& row(row(item.lifecycleOutput).performance).disposition === 'cancelled';
}

const normalText = (value: unknown): string => typeof value === 'string' ? value : '';

/** Normal completion cannot conceal duplicate issuance or unexplained revisions.
 * Read original classed review Decisions independently; never infer authority
 * from a node counter, a completed status, or an accepted later candidate. */
export function verifyNormalAttemptRevisions(items: readonly Row[], graph: Row, decisions: ReadonlyMap<string, Row>, run: Row): void {
	const label='ACCEPTANCE_NORMAL_REVISIONS';
	assert.ok(items.length>0 && Array.isArray(graph.nodes) && Array.isArray(graph.edges),label);
	const groups=new Map<string, Array<{item: Row; attempt: ReturnType<typeof assignmentAttemptSchema.parse>}>>();
	assert.equal(new Set(items.map(item=>item.id)).size,items.length,label);
	for(const item of items) {
		const attempt=assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(item.id,attempt.id,label); assert.equal(attempt.workdayId,run.id,label); assert.equal(attempt.teamId,graph.teamId,label);
		assert.ok(item.status==='completed'||phaseBoundaryCancelled(item,run),label+': Normal terminal status or original planning handoff required');
		const matches=(graph.nodes as Row[]).filter(node=>node.id===attempt.nodeId); assert.equal(matches.length,1,label+': Independent owning node required');
		assert.equal(matches[0]!.projectId,attempt.projectId,label);
		const group=groups.get(attempt.nodeId)??[]; group.push({item,attempt}); groups.set(attempt.nodeId,group);
	}
	for(const[nodeId,group]of groups) {
		group.sort((a,b)=>a.attempt.nodeRevision-b.attempt.nodeRevision);
		const node=(graph.nodes as Row[]).find(node=>node.id===nodeId)!;
		for(const[index,current]of group.entries()) {
			assert.equal(current.attempt.nodeRevision,index+1,label+': Every original revision must appear exactly once from issuance');
			if(index===0)continue;
			const previous=group[index-1]!, pairEdges=(graph.edges as Row[]).filter(edge=>edge.provenance==='review-pair'
				&& (node.pairRole==='actor'?edge.fromNodeId===nodeId:node.pairRole==='reviewer'&&edge.toNodeId===nodeId)
				&& Number(edge.graphRevisionCreated)<=current.attempt.graphRevision
				&& (edge.graphRevisionRemoved===undefined||Number(edge.graphRevisionRemoved)>previous.attempt.graphRevision));
			assert.equal(pairEdges.length,1,label+': Only original paired review can explain another normal revision');
			const pair=pairEdges[0]!, reviews=items.filter(value=>row(value.assignmentAttempt).nodeId===pair.toNodeId
				&& row(value.assignmentAttempt).nodeRevision===previous.attempt.nodeRevision);
			assert.equal(reviews.length,1,label); const review=reviews[0]!, issued=assignmentAttemptSchema.parse(review.assignmentAttempt);
			const actors=items.filter(value=>row(value.assignmentAttempt).nodeId===pair.fromNodeId
				&& row(value.assignmentAttempt).nodeRevision===previous.attempt.nodeRevision
				&& issued.predecessorResultIds.includes(String(row(value.assignmentResult).id)));
			assert.equal(actors.length,1,label); const decision=decisions.get(String(review.id)); assert.ok(decision,label+': Original request-changes Decision required');
			verifyWorkReview(review,actors[0]!,decision,'request-changes');
			assert.ok(Number.isFinite(Date.parse(String(review.completedAt)))&&Date.parse(String(review.completedAt))<=Date.parse(current.attempt.createdAt),label+': Review must finish before revised issuance');
		}
		const last=group.at(-1)!.attempt.nodeRevision;
		assert.ok(node.nodeRevision===last||(run.status==='completed'&&node.status==='stale'&&node.nodeRevision===last+1),label+': Unexplained unissued node revision');
	}
}

