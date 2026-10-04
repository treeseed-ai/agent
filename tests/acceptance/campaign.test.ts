import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { monitorCampaign, requirePlanningWindow } from './campaign.ts';
import { verifyFreezeIntegrity } from './freeze-integrity.ts';
import { read } from './acceptance-cli.ts';
import { verifyGolden } from './sdk-runtime-golden.test.ts';
import { prepareSdkCampaign, verifySdkExternalState } from './prepare-campaign.ts';
import { observeCampaign } from './workday/support/campaign-observation.ts';

type Row = Record<string, any>;
test('Frozen SDK campaign drives planning acting review and terminal golden gates', { timeout: 36_000_000 }, async () => {
	const path = process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;
	assert.ok(path, 'ACCEPTANCE_FREEZE_REQUIRED: Explicit immutable campaign freeze required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	if (!existsSync(path) && process.env.TREESEED_ACCEPTANCE_DRAFT_PATH)
		prepareSdkCampaign(process.env.TREESEED_ACCEPTANCE_DRAFT_PATH, path, team);
	const freeze = JSON.parse(readFileSync(path, 'utf8')) as Row;
	verifyFreezeIntegrity(freeze, readFileSync);
	const body = freeze.request?.body as Row, allocation = body?.allocation as Row;
	assert.equal(body?.executionMode, 'simulation', 'ACCEPTANCE_CAMPAIGN_MODE: Simulation only');
	assert.equal(body?.projects?.length, 1, 'ACCEPTANCE_CAMPAIGN_PROJECT: Individual SDK campaign only');
	assert.equal(body?.projects[0], '8cbfb810-6da5-4da2-9ae9-cad53101253f', 'ACCEPTANCE_CAMPAIGN_PROJECT: Exact seeded SDK identity required');
	assert.deepEqual(body.proposalIds, [freeze.proposal?.id], 'ACCEPTANCE_CAMPAIGN_PROPOSAL: Exact frozen proposal required');
	assert.equal(freeze.proposal.estimates, 0, 'ACCEPTANCE_CAMPAIGN_FRESH: No reused estimates');
	assert.equal(body.durationSeconds, 3600);
	assert.equal(allocation?.planningPercent, 100 / 3);
	assert.equal(allocation?.allocationWeight, 1);
	assert.equal(allocation?.planningTurnMaximumSeconds, 180);
	requirePlanningWindow(body.durationSeconds, allocation.planningPercent, allocation.planningTurnMaximumSeconds);
	// API validates first admission expiry and replays the exact cached start after expiry.
	const started = read(['workdays', 'start', '--preflight', freeze.preflight.id, '--digest', freeze.preflight.preflightDigest,
		'--yes', '--idempotency-key', `golden-start:${freeze.preflight.id}`], team);
	const run = { id: started.workdayId };
	assert.ok(typeof run.id === 'string' && /^workday-[a-f0-9-]+$/u.test(run.id), 'ACCEPTANCE_CAMPAIGN_ID: Supported start omitted exact run');
	const workdayId = run.id;
	process.env.TREESEED_ACCEPTANCE_WORKDAY_ID = workdayId;
	const stop = () => { read(['workdays', 'stop', workdayId, '--yes', '--reason', 'Automated golden boundary failed',
		'--idempotency-key', `golden-stop:${workdayId}`], team); };
	const mentions = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter']
		.map(role => `@sdk/${role}`).join(' ');
	let externallyApproved = false;
	const observedEvents = new Map<string, Record<string, unknown>>();
	await monitorCampaign({ admittedSimulation: true, admitDiscussion: () => { read(['send', `sdk-golden-${workdayId}`, `${mentions} Discuss the exact frozen proposal, identify your role and dependencies, and publish useful planning contributions. Do not implement during planning.`,
		'--proposal', freeze.proposal.id, '--workday', workdayId, '--no-wait', '--idempotency-key', `golden-discussion:${workdayId}`], team, false, 240_000); }, read: () => {
		const observed = read(['workdays', 'show', workdayId], team);
		const snapshot = observeCampaign(observed, workdayId, observedEvents);
		const current = snapshot.run as Row, failedBoundary = snapshot.failedBoundary;
		return { status: current.status, mode: current.executionMode, failedBoundary,
			planningEndsAt: Date.parse(current.startedAt) + current.parameters.durationSeconds * current.parameters.planningPercent * 10,
			endsAt: Date.parse(current.parameters.appliedPlan.endsAt) };
	}, now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 30_000)), stop,
		collaboration: () => {
			verifyGolden('collaboration');
			// Observe every new boundary, but never repeat the external governance
			// mutation just because another polling interval or round completed.
			if (externallyApproved) return;
			const project = body.projects[0] as string;
			const proposal = read(['proposals', 'show', freeze.proposal.id, '--server', 'local', '--project', project], team, true);
			const version = Number(proposal.activeVersion);
			assert.ok(Number.isInteger(version) && version > 0,
				'ACCEPTANCE_PROPOSAL_VERSION: External approval requires exact current version');
			const approval = read(['proposals', 'evaluate', freeze.proposal.id, '--server', 'local', '--project', project,
				'--if-match', String(version), '--input', fileURLToPath(new URL('./proposal-approval.json', import.meta.url)),
				'--idempotency-key', `golden-approval:${workdayId}`], team, true);
			assert.equal(approval.status, 'accepted', 'ACCEPTANCE_EXTERNAL_APPROVAL: Proposal was not accepted');
			assert.ok(typeof approval.decisionId === 'string' && approval.decisionId,
				'ACCEPTANCE_EXACT_DECISION: External approval did not create an exact decision');
			externallyApproved = true;
		},
		verify: () => { for (const gate of ['lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter'] as const) verifyGolden(gate);
			verifySdkExternalState(freeze); } });
});
