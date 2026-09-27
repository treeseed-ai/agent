import assert from 'node:assert/strict';

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
