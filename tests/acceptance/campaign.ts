import assert from 'node:assert/strict';

export const sdkCampaignWindow = Object.freeze({ durationSeconds: 3600, planningPercent: 100 / 3, planningTurnMaximumSeconds: 180 });

const sdkWorkItems = [
  ['research-context', 'Researcher', 'researcher', 'treedx'],
  ['architecture-contract', 'Architect', 'architect', 'treedx'],
  ['tests-first', 'Tester', 'tester', 'git'],
  ['implement-change', 'Engineer', 'engineer', 'git'],
  ['document-change', 'Technical Writer', 'technical-writer', 'git'],
  ['simulate-release', 'Releaser', 'releaser', 'git'],
] as const;

type SdkProposalContract = { title: string; request: string; summary: string; workItems: Array<{
  id: string; agentClass: string; workspace: string; objective: string; acceptanceCriteria: string;
}>; architectureBook: { id: string; path: string; title: string } };

export function sdkProposalText(spec: string): SdkProposalContract {
  const section = spec.split('### 1. SDK — decision-governed workday intent\n')[1]?.split('\n### 2. API')[0];
  assert.ok(section, 'ACCEPTANCE_CAMPAIGN_SPEC: Canonical SDK section required');
  const field = (name: string) => {
    const value = section.split('\n').find(line => line.startsWith(`- ${name}: `))?.slice(name.length + 4).replace(/\*\*/gu, '').trim();
    assert.ok(value, `ACCEPTANCE_CAMPAIGN_SPEC: Canonical ${name} required`); return value;
  };
  const bookField = field('Architecture Book');
  const book = /^`([a-z0-9-]+)` at `(books\/[a-z0-9/-]+\.md)` in the pinned SDK library commit\./u.exec(bookField);
  assert.ok(book, 'ACCEPTANCE_CAMPAIGN_SPEC: Exact pinned SDK Architecture Book required');
  const bookTitle = /Its published title is ([^.]+)\./u.exec(bookField)?.[1];
  assert.ok(bookTitle, 'ACCEPTANCE_CAMPAIGN_SPEC: Published Book title required');
  const deliverableSection = section.split('Each Actor is reviewed against its own deliverable: ')[1]
    ?.split(/\. The (?:proposal-wide contract|integrated-candidate) gates/u);
  assert.ok(deliverableSection?.length === 2 && deliverableSection[0],
    'ACCEPTANCE_CAMPAIGN_SPEC: Complete Actor-specific review boundary required');
  const deliverables = deliverableSection[0];
  const fixedGraph = spec.split('### Fixed work-item graph\n')[1]?.split('\n### ')[0];
  assert.ok(fixedGraph?.includes('`dependsOn` is reserved for proposal-specific domain dependencies'),
    'ACCEPTANCE_CAMPAIGN_SPEC: Standing workflow dependencies must stay outside the proposal');
  const workItems = sdkWorkItems.map(([id, role, agentClass, workspace], index) => {
    const row = section.split('\n').find(line => line.startsWith(`| ${role} |`));
    const objective = row?.split('|')[2]?.trim();
    const marker = index === 0 ? `${role} ` : `; ${role} `;
    const start = deliverables.indexOf(marker);
    const nextRole = sdkWorkItems[index + 1]?.[1];
    const next = nextRole ? deliverables.indexOf(`; ${nextRole} `, start + marker.length) : -1;
    const criterion = start < 0 || (nextRole && next < 0) ? ''
      : deliverables.slice(start + (index === 0 ? 0 : 2), next < 0 ? undefined : next).trim();
    assert.ok(objective && criterion, `ACCEPTANCE_CAMPAIGN_SPEC: ${role} objective and review criterion required`);
		if (role === 'Architect') assert.ok(objective.includes(book[2]!) && criterion.includes(book[2]!),
			'ACCEPTANCE_CAMPAIGN_BOOK: Architect objective and review must name the pinned Book path');
    assert.ok(fixedGraph.includes(`| \`${id}\` | ${role} | \`${workspace}\` | none | 2 |`),
      `ACCEPTANCE_CAMPAIGN_SPEC: ${role} fixed graph row required`);
    return { id, agentClass, workspace, objective, acceptanceCriteria: criterion };
  });
  return { title: field('Title'), request: field('Request'), summary: field('Summary'),
    architectureBook: { id: book[1]!, path: book[2]!, title: bookTitle }, workItems };
}

export function freshSdkDraft(template: Record<string, any>, id: string, canonical: SdkProposalContract,
	bookRepositoryId: string, bookExact: { revision: number; digest: string }): Record<string, any> {
	assert.match(bookRepositoryId, /^repo_[a-zA-Z0-9_-]+$/u,
		'ACCEPTANCE_CAMPAIGN_BOOK: Resolved TreeDX repository identity required');
	assert.ok(Number.isInteger(bookExact.revision) && bookExact.revision > 0
		&& /^sha256:[a-f0-9]{64}$/u.test(bookExact.digest), 'ACCEPTANCE_CAMPAIGN_BOOK: Exact Book revision and digest required');
	const draft = structuredClone(template);
	assert.equal(draft.status, 'draft', 'ACCEPTANCE_CAMPAIGN_FRESH: Estimate-free draft template required');
	assert.equal(draft.executionPlan?.workItems?.length, 6, 'ACCEPTANCE_CAMPAIGN_OBJECTIVES: Six unchanged SDK work items required');
	const gitRefs = draft.executionPlan.workItems.flatMap((item: Record<string, any>) => item.contextRefs ?? [])
		.filter((ref: Record<string, any>) => ref.store === 'git');
	assert.ok(gitRefs.length && new Set(gitRefs.map((ref: Record<string, any>) => ref.commit)).size === 1,
		'ACCEPTANCE_CAMPAIGN_SOURCE: One exact frozen project source is required');
	assert.ok(/^[a-f0-9]{40}$/u.test(gitRefs[0].commit), 'ACCEPTANCE_CAMPAIGN_SOURCE: Moving source refs prohibited');
	for (const [index, item] of draft.executionPlan.workItems.entries()) {
		const required = canonical.workItems[index];
		assert.ok(required && item.id === required.id && item.agentClass === required.agentClass && item.workspace === required.workspace &&
			item.maximumReviewCycles === 2 && item.activity === 'acting' && item.review === 'required',
			'ACCEPTANCE_CAMPAIGN_OBJECTIVES: Template structure differs from the fixed graph');
		assert.ok(!item.ownerEstimate && !item.reviewerEstimate, 'ACCEPTANCE_CAMPAIGN_FRESH: Reused estimates prohibited');
		item.objective = required.objective;
		item.acceptanceCriteria = [required.acceptanceCriteria];
		item.dependsOn = [];
		if (item.workspace === 'treedx' && item.requestedPermissions?.content?.write?.includes('knowledge')) {
			const library = item.contextRefs.find((reference: Record<string, any>) => reference.store === 'treedx'
				&& reference.model === 'repository' && reference.repository && /^[a-f0-9]{40}$/u.test(reference.commit));
			assert.ok(library && !item.contextRefs.some((reference: Record<string, any>) => reference.model === 'book'),
				'ACCEPTANCE_CAMPAIGN_BOOK: One pinned library repository and no stale Book authority required');
			item.contextRefs.push({ store: 'treedx', model: 'book', id: canonical.architectureBook.id,
				path: canonical.architectureBook.path, repository: bookRepositoryId, commit: library.commit,
				revision: bookExact.revision, digest: bookExact.digest });
		}
		if (!item.contextRefs.some((ref: Record<string, any>) => ref.store === 'git')) item.contextRefs.push(structuredClone(gitRefs[0]));
	}
	draft.id = id;
	draft.title = canonical.title;
	draft.request = canonical.request;
	draft.summary = canonical.summary;
	draft.contentProvenance.contentPath = `proposals/governance/${id}.mdx`;
	return draft;
}

/** Validate the debug window; the real allocator admits work, not a sum of turn ceilings. */
export function requirePlanningWindow(durationSeconds: number, planningPercent: number,
	turnMaximumSeconds: number): void {
	for (const value of [durationSeconds, planningPercent, turnMaximumSeconds])
		assert.ok(Number.isFinite(value) && value > 0, 'ACCEPTANCE_CAMPAIGN_INPUT: Positive allocation inputs required');
	assert.ok(durationSeconds <= 3600 && planningPercent < 100 && Number.isInteger(durationSeconds) && Number.isInteger(turnMaximumSeconds),
		'ACCEPTANCE_CAMPAIGN_INPUT: Invalid planning allocation');
	const planningSeconds = durationSeconds * planningPercent / 100;
	assert.ok(Math.abs(planningSeconds - 1200) < 0.000001 && turnMaximumSeconds <= planningSeconds,
		'ACCEPTANCE_CAMPAIGN_WINDOW: Initial debugging requires twenty minutes planning within at most one hour');
}

export async function monitorCampaign(input: {
	admitDiscussion?: () => void;
	admittedSimulation?: boolean;
	read: () => { status: string; mode: string; planningEndsAt: number; endsAt: number;
		failedBoundary?: 'assignment_failed' | 'assignment_returned' | 'assignment_expired' |
			'graph_failed' | 'graph_returned' | 'graph_expired' };
	now: () => number; wait: () => Promise<void>; collaboration: () => void;
	verify: () => void; stop: () => void;
}): Promise<void> {
	let planningVerified = false;
	const incompleteCollaboration = (failure: unknown) => failure instanceof Error
		&& /^ACCEPTANCE_(CHAT_ROLES|PLANNING_ROLE_TURNS|PLANNING_CYCLES|ESTIMATE_ROLES):/u.test(failure.message);
	let observedStatus = input.admittedSimulation ? 'running' : '', observedMode = input.admittedSimulation ? 'simulation' : '';
	try {
	input.admitDiscussion?.();
	for (;;) {
		const run = input.read();
		observedStatus = run.status; observedMode = run.mode;
		assert.equal(run.mode, 'simulation', 'ACCEPTANCE_CAMPAIGN_MODE: No production campaign mutation');
		if (run.status === 'completed') {
			input.collaboration();
			input.verify(); return;
		}
		assert.equal(run.status, 'running', 'ACCEPTANCE_CAMPAIGN_TERMINAL: Unsuccessful terminal campaign');
		if (run.failedBoundary) {
			assert.fail(`ACCEPTANCE_CAMPAIGN_${run.failedBoundary.toUpperCase()}: Failed boundary; no further metered retries`);
		}
		assert.ok(Number.isFinite(run.planningEndsAt) && Number.isFinite(run.endsAt),
			'ACCEPTANCE_CAMPAIGN_TIME: Authoritative deadlines required');
		try { input.collaboration(); planningVerified = true; }
		catch (failure) {
			// Initial incomplete participation may continue, but an earlier pass is
			// never a receipt for later rounds or changed contribution authority.
			if (planningVerified || !incompleteCollaboration(failure)) throw failure;
		}
		if (input.now() > run.endsAt + 600_000) {
			assert.fail('ACCEPTANCE_CAMPAIGN_TIMEOUT: Settlement did not complete within bounded closeout');
		}
		await input.wait();
	}
	} catch (failure) {
		// A failed verifier must not strand an otherwise live simulation. Only the
		// already-observed simulation workday may be stopped; never mutate a run
		// whose mode was not proven or whose status is already terminal.
		if (observedStatus === 'running' && observedMode === 'simulation') {
			try { input.stop(); }
			catch (stopFailure) {
				// The control plane may terminalize the same run while the stop request
				// is in flight. Preserve the original acceptance failure in that case.
				let current: ReturnType<typeof input.read> | undefined;
				try { current = input.read(); } catch { /* Retain both failures below. */ }
				if (current?.mode === 'simulation' && current.status !== 'running') throw failure;
				throw new AggregateError([failure, stopFailure], 'ACCEPTANCE_CAMPAIGN_STOP_FAILED: Failed boundary and supported stop both failed');
			}
		}
		throw failure;
	}
}
