import { beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { sdkCampaignChatQuestion } from '../../../acceptance/campaign.ts';

export type Row = Record<string, any>;
const state = vi.hoisted(() => ({ cases: new Map<string, () => void>(), replies: new Map<string, Row>(), assignmentPages: undefined as Row[] | undefined, usagePages: undefined as Row[] | undefined, eventPages: undefined as Row[] | undefined, failure: undefined as Error | undefined, workspaceFailure: undefined as Error | undefined, timeout: 0, args: [] as string[], calls: [] as string[][] }));
export { state };
vi.mock('node:test', () => ({ default: (name: string, _options: unknown, run: () => void) => state.cases.set(name, run) }));
vi.mock('node:child_process', () => ({ execFileSync: (_command: string, args: string[], options: { timeout: number }) => {
	state.timeout = options.timeout;
	state.args = args;
	state.calls.push([...args]);
	if (state.failure) throw state.failure;
	const key = args.slice(0, 2).join(' ');
	if (key === 'projects treedx' && state.workspaceFailure) throw state.workspaceFailure;
	const result = key === 'projects treedx' ? state.replies.get(`workspace ${args[4]}`)
		: key === 'assignments list' && state.assignmentPages ? state.assignmentPages.shift()
		: key === 'capacity usage' && state.usagePages ? state.usagePages.shift()
		: key === 'workdays events' && state.eventPages ? state.eventPages.shift()
		: state.replies.get(args.slice(0, 5).join(' ')) ?? state.replies.get(`${key} ${args[2]} ${args[3]}`) ?? state.replies.get(`${key} ${args[3]}`) ?? state.replies.get(key);
	if (!result) throw new Error(`Unexpected acceptance read: ${key}`);
	// The actual repository sorts its read model; do not reorder the mutable oracle inputs.
	const presented = (key === 'assignments list' || key === 'capacity ledger' || (key === 'capacity usage' && !state.usagePages)) ? { ...result, items: [...result.items].sort((a, b) =>
		Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)) } : result;
	return JSON.stringify({ ok: true, result: presented });
} }));
await import('../../../acceptance/sdk-runtime-golden.test.ts');
export const { read } = await import('../../../acceptance/acceptance-cli.ts');

export const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
export const workdayId = 'workday-11111111-1111-4111-8111-111111111111';
export const commit = 'a'.repeat(40);
export const gate = (name: string) => state.cases.get(`Golden runtime ${name} evidence satisfies its acceptance boundary`)!();
export function retainProposalDecisionBytes(): void {
	const observed = state.replies.get('library read decisions/decision-1.mdx')!.result;
	const file = observed.files[0];
	file.content = `---\n${stringify(file.frontmatter, { lineWidth: 0 })}---\n`;
	Object.assign(observed, { ok: true, repoId: 'sdk-library' });
	const digest = `sha256:${createHash('sha256').update(file.content).digest('hex')}`;
	const update = (value: unknown): void => {
		if (!value || typeof value !== 'object') return;
		const record = value as Row;
		if (record.model === 'decision' && record.id === 'decision-1') record.digest = digest;
		for (const child of Object.values(record)) update(child);
	};
	for (const value of state.replies.values()) update(value);
}
export function usageMeasurement(item: Row): Row {
	// Scoped measurement assertion input, NOT actual usage or a canonical UsageSettlement.
	return { id: `${item.id}:aggregate`, assignmentId: item.id, projectId: item.projectId, workDayId: workdayId,
		idempotencyKey: `usage-${item.id}`, assignmentAttempt: item.assignmentAttempt.attempt, accountingMode: 'aggregate', usageDimension: 'aggregate',
		activeSeconds: 1, elapsedSeconds: 1, nativeUsage: { activeSeconds: 1 }, createdAt: item.completedAt,
		metadata: { settlementKey: item.id } };
}
export function assignment(id: string, activity: string, agentClass: string, workItemId = '', createdAt = '2026-09-27T00:00:01Z', completedAt = '2026-09-27T00:00:02Z'): Row {
	// Complete grant/workspace assertion input, not a real compiled profile or admission receipt.
	const git = activity === 'acting', tools = git ? ['source.read', 'source.write', 'verification'] : ['source.read', 'verification', 'discussion'];
	const writable = { store: 'treedx', model: 'decision', id: activity === 'reviewing' ? id : `decision-${id}`, repository: 'sdk-library', commit,
		path: `decisions/${id}.mdx` };
	return { id, workDayId: workdayId, projectId: 'sdk', decisionId: 'decision-1', status: 'completed', leaseToken: null, attemptCount: 1,
		...(activity === 'chat' ? { lanePurpose: 'communication' } : {}),
		leaseState: 'released', leaseExpiresAt: null, leaseRenewedAt: null, runnerId: null,
		createdAt, completedAt, assignmentAttempt: { attempt: 1, agentClass, workItemId, createdAt, acceptanceCriteria: ['Verify the original controlled work item '+workItemId+'.'],
			deadline: new Date(Date.parse(createdAt) + 10_000).toISOString(), effectiveProfile: { activity,
			profileRef: { store: 'treedx', model: 'agent', id: `configured-${agentClass}`, repository: 'sdk-library', commit,
				path: `agents/${agentClass}.yaml` }, handler: git ? 'actor' : activity === 'reporting' ? 'reporter' : 'writer',
			handlerOrigin: 'agent-package', prompt: { system: 'Synthetic governed task instructions for assertion testing only.' },
			permissionCeiling: { content: { read: ['proposal', 'decision'], write: git ? [] : ['decision'] }, tools: [...tools] } },
			grant: { contentRead: [], contentWrite: git ? [] : [writable], sourceRead: ['sdk'], sourceWrite: git ? ['sdk'] : [], tools: [...tools] },
			contextRefs: [{ store: 'git', model: 'repository', id: 'sdk', repository: 'sdk', commit }], workspace: git ? { mode: 'git', repository: 'sdk', baseCommit: commit, branch: `simulation/fixture/${id}`, writablePaths: ['src'] }
				: { mode: 'treedx', repository: 'sdk-library', baseCommit: commit, workspaceId: `workspace-${id}`, writablePaths: [writable.path] },
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
	state.assignmentPages = undefined;
	state.failure = undefined;
	state.workspaceFailure = undefined;
	state.usagePages = undefined;
	state.eventPages = undefined;
	state.calls = [];
	const items: Row[] = classes.flatMap(agentClass => [assignment(`chat-${agentClass}`, 'chat', agentClass),
		assignment(`planning-1-${agentClass}`, 'planning', agentClass), assignment(`planning-2-${agentClass}`, 'planning', agentClass)]);
	const discussionPath = `discussions/sdk-golden-${workdayId}.mdx`, discussionFrontmatter = {
		schemaVersion: 'treeseed.discussion/v1', id: `sdk-golden-${workdayId}`, projectId: 'sdk', teamId: 'team-1', status: 'open',
		subjectRef: { store: 'postgresql', model: 'project', id: 'sdk' }, participantClasses: [], title: 'SDK probes', createdAt: '2026-09-27T00:00:00.500Z' };
	const discussionBody = '# SDK probes\n', discussionContent = `---\n${stringify(discussionFrontmatter, { lineWidth: 0 })}---\n${discussionBody}`;
	const discussionDigest = `sha256:${createHash('sha256').update(discussionContent).digest('hex')}`;
	state.replies.set(`library read ${discussionPath}`, { result: { ok: true, repoId: 'sdk-library', resolvedRef: commit,
		files: [{ path: discussionPath, content: discussionContent, body: discussionBody, frontmatter: discussionFrontmatter }] } });
	// Exact-message UNIT oracle only; these bytes are not a real discussion or model receipt.
	for (const item of items.filter(value => value.assignmentAttempt.effectiveProfile.activity === 'chat')) {
		const role = item.assignmentAttempt.agentClass, channel = `sdk-golden-${workdayId}`, path = `discussion-messages/${channel}/${role}.mdx`;
		const source = { store: 'treedx', model: 'discussion', id: `invocation-${item.id}`, repository: 'sdk-library', commit, path, digest: `sha256:${'d'.repeat(64)}` };
		const proposal = { store: 'treedx', model: 'proposal', id: 'proposal', repository: 'sdk-library', commit,
			path: 'proposals/proposal.mdx', revision: 8, digest: `sha256:${'b'.repeat(64)}` };
		item.invocationId = source.id; item.teamId = 'team-1';
  item.assignmentResult.summary=JSON.stringify({agentClass:role,proposalId:proposal.id,proposalCommit:proposal.commit});item.assignmentResult.verification=[];
		Object.assign(item.assignmentAttempt, { sourceRef: source, workdayId, teamId: 'team-1', projectId: item.projectId,
			contextRefs: [...item.assignmentAttempt.contextRefs, structuredClone(source), structuredClone(proposal)] });
		item.assignmentAttempt.grant.contentRead = [structuredClone(source), structuredClone(proposal)];
		item.assignmentAttempt.effectiveProfile.permissionCeiling.content.read.push('discussion');
		const body = sdkCampaignChatQuestion(role), frontmatter = { schemaVersion: 'treeseed.discussion-message/v1', id: `message-${item.id}`,
			discussionRef: { store: 'treedx', model: 'discussion', id: channel, path: discussionPath, revision: 1, digest: discussionDigest },
			authorRef: { store: 'postgresql', model: 'user', id: 'unit-operator' }, authorType: 'user', discussionId: channel,
			mentionedAgents: [role], recipientIds: [role], fileRefs: [], parentWorkdayId: workdayId, createdAt: '2026-09-27T00:00:00.500Z',
			contextRefs: [{ kind: 'proposal', id: proposal.id, projectId: item.projectId, immutableRef: commit, path: proposal.path, digest: proposal.digest }] };
		const content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`;
		state.replies.set(`library read ${path}`, { result: { ok: true, repoId: 'sdk-library', resolvedRef: commit, files: [{ path, content, body: `\n${body}\n`, frontmatter }] } });
	}
	items.push(...classes.slice(0, 7).map(agentClass => assignment(`estimate-${agentClass}`, 'estimating', agentClass)));
	for (let index = 0; index < 6; index++) {
		items.push(assignment(`actor-${index}`, 'acting', classes[index]!, `work-${index}`));
		items.push(assignment(`review-${index}`, 'reviewing', 'reviewer', `work-${index}`, '2026-09-27T00:00:03Z', '2026-09-27T00:00:04Z'));
	}
	const requested = assignment('requested', 'reviewing', 'reviewer', 'work-0', '2026-09-27T00:00:03Z', '2026-09-27T00:00:04Z');
	requested.lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
	items.push(requested, assignment('revision', 'acting', 'architect', 'work-0', '2026-09-27T00:00:05Z', '2026-09-27T00:00:06Z'),
		assignment('approved-revision', 'reviewing', 'reviewer', 'work-0', '2026-09-27T00:00:07Z', '2026-09-27T00:00:08Z'));
	// Frozen predecessor assertion inputs, not actual admission or native results.
	for (const item of items) item.assignmentAttempt.predecessorResultIds = [];
	requested.assignmentAttempt.predecessorResultIds = ['result-actor-0'];
	items.find(item => item.id === 'revision')!.assignmentAttempt.predecessorResultIds = ['result-requested'];
	items.find(item => item.id === 'approved-revision')!.assignmentAttempt.predecessorResultIds = ['result-revision'];
	const reportRef = { kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', path: 'notes/report.mdx', commit };
	const reporter = assignment('closeout-report', 'reporting', 'reporter', '', '2026-09-27T00:00:09Z', '2026-09-27T00:00:10Z');
	reporter.assignmentAttempt.sourceRef = { store: 'postgresql', model: 'workday', id: workdayId };
	reporter.assignmentResult.references = [structuredClone(reportRef)];
	items.push(reporter);
	// Supplied official workspace-read results, not actual remote resource receipts.
	for (const item of items) if (item.assignmentAttempt.workspace.mode === 'treedx') {
		const workspace = item.assignmentAttempt.workspace;
		state.replies.set(`workspace ${workspace.workspaceId}`, { result: { workspaceId: workspace.workspaceId,
			repoId: workspace.repository, status: 'closed' }, receipt: { projectId: item.projectId } });
	}
	state.replies.set('workdays events', { items: [{ id: 'supplied-workday-event', eventIndex: 0, runId: workdayId,
		teamId: 'team-1', assignmentId: null, eventType: 'workday.started', createdAt: '2026-09-27T00:00:00Z', context: {} }],
		page: { limit: 100, hasMore: false, nextCursor: null } });
	state.replies.set('workdays show', { run: { id: workdayId, teamId: 'team-1', status: 'completed', executionMode: 'simulation', startedAt: '2026-09-27T00:00:00Z',
		completedAt: '2026-09-27T00:01:00Z', parameters: { proposalIds: ['proposal'], durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
			appliedPlan: { policySnapshot: { allocationWeight: 1 }, planningRounds: [{ state: 'complete' }, { state: 'complete' }] } },
		state: 'ended', endedAt: '2026-09-27T00:01:00Z', reportRef } });
	state.replies.set('assignments list', { items, page: { limit: 50, hasMore: false, nextCursor: null } });
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
		if (item.id === 'requested') {
			// Supplied canonical finding bytes only, not a real Writer publication.
			const findingPath = 'notes/requested-feedback.mdx', body = 'A supplied review finding requiring a real correction.';
			const decision = state.replies.get(`library read ${path}`)!.result.files[0].frontmatter;
			const frontmatter = { schemaVersion: 'treeseed.note/v1', id: 'requested-feedback', projectId: 'sdk', classification: 'feedback',
				subjectRefs: [structuredClone(decision.subjectRef)], createdAt: item.completedAt };
			const content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`;
			const target = { store: 'treedx', model: 'note', id: frontmatter.id, repository: 'sdk-library', commit, path: findingPath };
			const { commit: _baseCommit, ...finding } = target;
			decision.findingRefs = [{ ...finding, revision: 1, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` }];
			item.assignmentAttempt.grant.contentWrite.push(target);
			item.assignmentAttempt.workspace.writablePaths.push(findingPath);
			item.assignmentAttempt.effectiveProfile.permissionCeiling.content.write.push('note');
			item.assignmentResult.references.push({ kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', commit, path: findingPath });
			state.replies.set(`library read ${findingPath}`, { result: { resolvedRef: commit, files: [{ path: findingPath, content, body, frontmatter }] } });
		}
	}
	state.replies.set('library read decisions/decision-1.mdx', { result: { resolvedRef: commit, files: [{ path: 'decisions/decision-1.mdx', frontmatter: {
		schemaVersion: 'treeseed.decision/v1', id: 'decision-1', projectId: 'sdk', decisionClass: 'proposal', decisionMethod: 'authority',
		subjectRef: structuredClone(nodes[0]!.sourceRef), disposition: 'approved', rationale: 'Synthetic complete Decision input, not live evidence.',
		authorityRefs: [structuredClone(nodes[0]!.sourceRef)], decidedByRefs: [{ store: 'postgresql', model: 'user', id: 'fixture-external-operator' }],
		decidedAt: '2026-09-26T23:59:00Z' } }] } });
	retainProposalDecisionBytes();
	for (const reply of state.replies.values()) for (const file of reply.result?.files ?? [])
		if (file.frontmatter?.decisionClass === 'work-review')
			file.content = `---\n${stringify(file.frontmatter, { lineWidth: 0 })}---\n`;
	state.replies.set('capacity usage', { items: items.map(usageMeasurement),
		page: { limit: 100, hasMore: false, nextCursor: null } });
	state.replies.set('library read', { result: { resolvedRef: commit, files: [{ path: reportRef.path, body: `${workdayId} ${items.map(item => item.id).join(' ')}`, frontmatter: {
		schemaVersion: 'treeseed.note/v1', id: 'bounded-report', classification: 'workday-report', projectId: 'sdk',
		createdAt: reporter.completedAt, subjectRefs: [structuredClone(reporter.assignmentAttempt.sourceRef)] } }] } });
	// Complete planning oracle input only; these mocked reads are NOT published live evidence.
	const rounds = state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds;
	const source = { store: 'treedx', model: 'proposal', id: 'proposal', repository: 'sdk-library', commit,
		path: 'proposals/proposal.mdx', revision: 8, digest: `sha256:${'b'.repeat(64)}` };
	for (const [index, round] of rounds.entries()) {
		const selected = items.filter(item => item.id.startsWith(`planning-${index + 1}-`));
		const previous = index ? items.filter(item => item.id.startsWith(`planning-${index}-`)) : [];
		Object.assign(round, { round: index + 1, assignmentIds: selected.map(item => item.id),
			startedAt: index ? '2026-09-27T00:00:03Z' : '2026-09-27T00:00:01Z',
			completedAt: index ? '2026-09-27T00:00:04Z' : '2026-09-27T00:00:02Z' });
		for (const item of selected) {
			item.executionNodeId = item.id; item.executionNodeRevision = 1;
			item.createdAt = round.startedAt; item.completedAt = round.completedAt;
			Object.assign(item.assignmentAttempt, { nodeId: item.id, nodeRevision: 1, sourceRef: structuredClone(source),
				predecessorResultIds: previous.map(value => value.assignmentResult.id) });
			const path = `notes/${item.id}.mdx`, id = `note-${item.id}`;
			const output = { store: 'treedx', model: 'note', id, repository: 'sdk-library', commit, path };
			const context = [source, ...previous.map(value => ({ store: 'treedx', model: 'note', id: `note-${value.id}`,
				...value.assignmentResult.references[0], kind: undefined, projectId: undefined }))]
				.map(value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)));
			item.assignmentAttempt.contextRefs = [...structuredClone(context), { store: 'git', model: 'repository', id: 'sdk', repository: 'sdk', commit }];
			item.assignmentAttempt.grant.contentRead = structuredClone(context);
			item.assignmentAttempt.grant.contentWrite = [output];
			item.assignmentAttempt.workspace.writablePaths = [path];
			item.assignmentAttempt.effectiveProfile.permissionCeiling.content = { read: ['proposal', 'note'], write: ['note'] };
			const body = previous.map(value => `- ${value.assignmentResult.id}: Incorporated the ${value.assignmentAttempt.agentClass} contribution.`)
				.concat([`Scoped ${item.assignmentAttempt.agentClass} recommendation; unchanged recommendation unless stated here.`]).join('\n');
			Object.assign(item.assignmentResult, { summary: body, completedAt: item.completedAt,
				references: [{ kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', commit, path }] });
			item.capacityEnvelope.budget.time.executionStartedAt = item.createdAt;
			item.capacityEnvelope.budget.time.closeoutStartedAt = item.completedAt;
			state.replies.set(`library read ${path}`, { result: { resolvedRef: commit, files: [{ path, body, frontmatter: {
				schemaVersion: 'treeseed.note/v1', id, projectId: 'sdk', classification: 'general',
				subjectRefs: [structuredClone(source)], body, createdAt: item.completedAt } }] } });
		}
	}
	// Ordinary product UNIT read-back only; these are controlled bytes, not native publication receipts.
	for (const item of items.filter(value => value.assignmentAttempt.effectiveProfile.activity === 'estimating')) {
		const target = item.assignmentAttempt.grant.contentWrite[0];
		item.assignmentResult.references = [{ kind: 'treedx', projectId: item.projectId, repository: target.repository, commit, path: target.path }];
		state.replies.set(`library read ${target.path}`, { result: { resolvedRef: commit, files: [{ path: target.path,
			content: `Controlled unit product for ${item.id}.\n`, frontmatter: {}, body: `Controlled unit product for ${item.id}.` }] } });
	}
	for (const [key, value] of state.replies) if (key.startsWith('library read') && value.result?.files) {
		Object.assign(value.result, { ok: true, repoId: 'sdk-library' });
		for (const file of value.result.files) if (file.content === undefined)
			file.content = `---\n${stringify(file.frontmatter, { lineWidth: 0 })}---\n\n${file.body ?? 'Controlled unit product.'}\n`;
	}
	// Frozen closeout authority is supplied test input, not actual SQL history.
	const predecessors = items.filter(item => item.id !== reporter.id).map(item => structuredClone(item.assignmentResult));
	const settlements = items.filter(item => item.id !== reporter.id).map(item => ({ schemaVersion: 'treeseed.usage-settlement/v1',
		id: `settlement-${item.id}`, idempotencyKey: `settlement-${item.id}`, assignmentId: item.id,
		reservationId: `reservation-${item.id}`, workdayId, teamId: 'team-1', projectId: item.projectId,
		agentClass: item.assignmentAttempt.agentClass, providerId: 'supplied-provider', actualSeconds: 1,
		nativeUsage: { activeSeconds: 1 }, settledAt: item.completedAt }));
	state.replies.set('capacity ledger', { items: settlements.map(value => ({ id: value.id, createdAt: value.settledAt,
		phase: 'task_completed_actual_settlement', assignmentId: value.assignmentId, usageSettlement: value })),
		page: { limit: 100, hasMore: false, nextCursor: null } });
	const evidence = { teamId: 'team-1', workdayId, nodes: structuredClone(nodes), edges: [],
		attempts: items.filter(item => item.id !== reporter.id).map(item => ({ id: item.id, status: item.status, assignment_result_json: JSON.stringify(item.assignmentResult) })),
		reservations: [], usage: structuredClone(state.replies.get('capacity usage')!.items), settlements };
	reporter.assignmentAttempt.predecessorResultIds = predecessors.map(item => item.id);
	reporter.workspaceContext = { predecessorResults: predecessors, authorizedContext: [{ ref: structuredClone(reporter.assignmentAttempt.sourceRef),
		mediaType: 'application/json', digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(evidence)).digest('hex')}`, value: evidence }] };
	state.replies.get('library read')!.result.files[0].body = `\`\`\`json\n${JSON.stringify({ classification: 'workday-report', workdayId,
		assignmentId: reporter.id, workday: evidence, predecessorResults: predecessors }, null, 2)}\n\`\`\``;
});
