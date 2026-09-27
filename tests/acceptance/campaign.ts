import assert from 'node:assert/strict';

export function freshSdkDraft(template: Record<string, any>, id: string): Record<string, any> {
	const draft = structuredClone(template);
	assert.equal(draft.status, 'draft', 'ACCEPTANCE_CAMPAIGN_FRESH: Estimate-free draft template required');
	assert.equal(draft.executionPlan?.workItems?.length, 6, 'ACCEPTANCE_CAMPAIGN_OBJECTIVES: Six unchanged SDK work items required');
	const gitRefs = draft.executionPlan.workItems.flatMap((item: Record<string, any>) => item.contextRefs ?? [])
		.filter((ref: Record<string, any>) => ref.store === 'git');
	assert.ok(gitRefs.length && new Set(gitRefs.map((ref: Record<string, any>) => ref.commit)).size === 1,
		'ACCEPTANCE_CAMPAIGN_SOURCE: One exact frozen project source is required');
	for (const item of draft.executionPlan.workItems) {
		assert.ok(!item.ownerEstimate && !item.reviewerEstimate, 'ACCEPTANCE_CAMPAIGN_FRESH: Reused estimates prohibited');
		if (!item.contextRefs.some((ref: Record<string, any>) => ref.store === 'git')) item.contextRefs.push(structuredClone(gitRefs[0]));
	}
	draft.id = id;
	draft.title = 'Select accepted decisions in portable workday intent — SDK golden';
	draft.contentProvenance.contentPath = `proposals/governance/${id}.mdx`;
	return draft;
}

/** Conservative serial cold-start demand, including addressed communication on the shared harness. */
export function requirePlanningWindow(durationSeconds: number, planningPercent: number,
	turnMaximumSeconds: number, participants: number, estimators: number): void {
	for (const value of [durationSeconds, planningPercent, turnMaximumSeconds, participants, estimators])
		assert.ok(Number.isFinite(value) && value > 0, 'ACCEPTANCE_CAMPAIGN_INPUT: Positive allocation inputs required');
	assert.ok(planningPercent <= 100 && Number.isInteger(participants) && Number.isInteger(estimators),
		'ACCEPTANCE_CAMPAIGN_INPUT: Invalid planning allocation');
	const required = (participants * 3 + estimators) * turnMaximumSeconds; // two planning turns plus chat
	assert.ok(durationSeconds * planningPercent / 100 >= required,
		'ACCEPTANCE_CAMPAIGN_WINDOW: Planning window cannot fit the conservative shared-harness turn demand');
}

export async function monitorCampaign(input: {
	read: () => { status: string; mode: string; planningEndsAt: number; endsAt: number };
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
