import assert from 'node:assert/strict';

export const sdkCampaignWindow = Object.freeze({ durationSeconds: 3600, planningPercent: 100 / 3, planningTurnMaximumSeconds: 180 });

export function sdkProposalText(spec: string): { title: string; request: string; summary: string } {
  const section = spec.split('### 1. SDK — decision-governed workday intent\n')[1]?.split('\n### 2. API')[0];
  assert.ok(section, 'ACCEPTANCE_CAMPAIGN_SPEC: Canonical SDK section required');
  const field = (name: string) => {
    const value = section.split('\n').find(line => line.startsWith(`- ${name}: `))?.slice(name.length + 4).replace(/\*\*/gu, '').trim();
    assert.ok(value, `ACCEPTANCE_CAMPAIGN_SPEC: Canonical ${name} required`); return value;
  };
  return { title: field('Title'), request: field('Request'), summary: field('Summary') };
}

export function freshSdkDraft(template: Record<string, any>, id: string, canonical: { title: string; request: string; summary: string }): Record<string, any> {
	const draft = structuredClone(template);
	assert.equal(draft.status, 'draft', 'ACCEPTANCE_CAMPAIGN_FRESH: Estimate-free draft template required');
	assert.equal(draft.executionPlan?.workItems?.length, 6, 'ACCEPTANCE_CAMPAIGN_OBJECTIVES: Six unchanged SDK work items required');
	const gitRefs = draft.executionPlan.workItems.flatMap((item: Record<string, any>) => item.contextRefs ?? [])
		.filter((ref: Record<string, any>) => ref.store === 'git');
	assert.ok(gitRefs.length && new Set(gitRefs.map((ref: Record<string, any>) => ref.commit)).size === 1,
		'ACCEPTANCE_CAMPAIGN_SOURCE: One exact frozen project source is required');
	assert.ok(/^[a-f0-9]{40}$/u.test(gitRefs[0].commit), 'ACCEPTANCE_CAMPAIGN_SOURCE: Moving source refs prohibited');
	for (const item of draft.executionPlan.workItems) {
		assert.ok(!item.ownerEstimate && !item.reviewerEstimate, 'ACCEPTANCE_CAMPAIGN_FRESH: Reused estimates prohibited');
		if (!item.contextRefs.some((ref: Record<string, any>) => ref.store === 'git')) item.contextRefs.push(structuredClone(gitRefs[0]));
	}
	draft.id = id;
	Object.assign(draft, canonical);
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
	read: () => { status: string; mode: string; planningEndsAt: number; endsAt: number; failedBoundary?: boolean };
	now: () => number; wait: () => Promise<void>; collaboration: () => void;
	verify: () => void; stop: () => void;
}): Promise<void> {
	let planningVerified = false;
	for (;;) {
		const run = input.read();
		assert.equal(run.mode, 'simulation', 'ACCEPTANCE_CAMPAIGN_MODE: No production campaign mutation');
		if (run.status === 'completed') {
			input.collaboration(); input.verify(); return;
		}
		assert.equal(run.status, 'running', 'ACCEPTANCE_CAMPAIGN_TERMINAL: Unsuccessful terminal campaign');
		if (run.failedBoundary) {
			input.stop(); assert.fail('ACCEPTANCE_CAMPAIGN_EXECUTION: Failed attempt or graph boundary; no further metered retries');
		}
		assert.ok(Number.isFinite(run.planningEndsAt) && Number.isFinite(run.endsAt),
			'ACCEPTANCE_CAMPAIGN_TIME: Authoritative deadlines required');
		if (!planningVerified && input.now() >= run.planningEndsAt) {
			try { input.collaboration(); planningVerified = true; }
			catch (failure) {
				if (failure instanceof Error && /^ACCEPTANCE_(CHAT_ROLES|PLANNING_ROLE_TURNS|PLANNING_CYCLES|ESTIMATE_ROLES):/u.test(failure.message)) input.stop();
				throw failure;
			}
		}
		if (input.now() > run.endsAt + 600_000) {
			input.stop(); assert.fail('ACCEPTANCE_CAMPAIGN_TIMEOUT: Settlement did not complete within bounded closeout');
		}
		await input.wait();
	}
}
