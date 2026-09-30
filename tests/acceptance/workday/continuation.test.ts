import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { read, row, type Row } from '../acceptance-cli.ts';
import { monitorCampaign, requirePlanningWindow } from '../campaign.ts';
import { verifyRuntimeClosure } from '../freeze-integrity.ts';
import { readWorkdayAssignments, verifyGolden } from '../sdk-runtime-golden.test.ts';
import { acceptanceReceiptDirectory, captureSdkExternalState, requireSdkCampaignSupply, verifySdkExternalState } from '../prepare-campaign.ts';

const activity = (item: Row) => row(row(item.assignmentAttempt).effectiveProfile).activity;
const itemId = (item: Row) => row(item.assignmentAttempt).workItemId;

export const continuationPlanKey = (parentId: string) => `continuation-plan:${parentId}:${randomUUID()}`;

/** A focused real continuation gate, not a fresh or complete SDK golden pass. */
test('Settled SDK work continues the exact approved candidate through release review and Reporter', { timeout: 4_200_000 }, async () => {
	const parentId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	const freezePath = process.env.TREESEED_ACCEPTANCE_FREEZE_PATH ?? '';
	assert.match(parentId, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_CONTINUATION_PARENT: Explicit parent required');
	assert.ok(freezePath, 'ACCEPTANCE_FREEZE_REQUIRED: Original immutable freeze required');
	const originalBytes = readFileSync(freezePath);
	const original = JSON.parse(originalBytes.toString()) as Row;
	// Historical receipt loss remains a failed golden boundary. This focused new
	// segment proves live accepted authority and captures its own external baseline.
	verifyRuntimeClosure(row(original.host), row(original.guest));
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	verifyGolden('stopped'); // Stop acknowledgement alone is not settlement evidence.
	const parent = row(read(['workdays', 'show', parentId], team).run);
	const parameters = row(parent.parameters);
	const assignments = readWorkdayAssignments(parentId, String(parent.startedAt), team);
	const authority = continuationAuthority(assignments);
	assert.equal(row(authority.sourceRef).id, row(original.proposal).id, 'ACCEPTANCE_CONTINUATION_SOURCE: Parent differs from original proposal');
	const projects = parameters.scheduledProjectIds;
	assert.deepEqual(projects, ['8cbfb810-6da5-4da2-9ae9-cad53101253f']);
	assert.equal(parameters.durationSeconds, 3600);
	assert.equal(parameters.planningPercent, 100 / 3);
	assert.ok(Number(parameters.maximumConcurrency) >= 5 && Number(parameters.communicationConcurrency) >= 5);
	requirePlanningWindow(Number(parameters.durationSeconds), Number(parameters.planningPercent), Number(parameters.planningTurnMaximumSeconds));
	const host = read(['dev', 'host', 'status'], team, true);
	verifyRuntimeClosure(host, { digest: host.guestImageDigest });
	const supply = read(['providers', 'status', String(parent.capacityProviderId)], team);
	requireSdkCampaignSupply(supply, 3600, 100 / 3, new Date().toISOString());
	const args = ['workdays', 'plan', '--profile', String(parameters.policyId), '--projects', (projects as string[]).join(','),
		'--decision', authority.decisionId, '--continue-from', parentId, '--duration', String(parameters.durationSeconds),
		'--execution-mode', 'simulation', '--planning-percent', String(parameters.planningPercent),
		'--allocation-weight', String(parameters.allocationWeight), '--planning-turn-maximum-seconds', String(parameters.planningTurnMaximumSeconds),
		'--project-percentages', JSON.stringify(parameters.projectPercentages), '--agent-class-percentages', JSON.stringify(parameters.agentClassPercentages)];
	const request = read([...args, '--plan'], team);
	// A new verification invocation is a new workday segment, not a replay of
	// a cancelled preflight. CLI retries inside this invocation retain one key.
	const preflight = read([...args, '--idempotency-key', continuationPlanKey(parentId)], team);
	const childFreeze = `${freezePath}.continuation-${String(preflight.id)}.json`;
	const artifacts = acceptanceReceiptDirectory(childFreeze);
	const receipts: Record<string, string> = { [freezePath]: `sha256:${createHash('sha256').update(originalBytes).digest('hex')}` };
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform, 'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	captureSdkExternalState(platform, (name, bytes) => { const path = join(artifacts, name); writeFileSync(path, bytes);
		receipts[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; });
	const frozen = { createdAt: new Date().toISOString(), request, preflight, host, guest: { digest: host.guestImageDigest },
		providerSupply: supply, parent, authority, receipts };
	writeFileSync(childFreeze, JSON.stringify(frozen, null, 2), { flag: 'wx' });
	const started = read(['workdays', 'start', '--preflight', String(preflight.id), '--digest', String(preflight.preflightDigest),
		'--yes', '--idempotency-key', `continuation-start:${preflight.id}`], team);
	const workdayId = String(started.workdayId ?? '');
	assert.match(workdayId, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_CONTINUATION_ID: Supported admission required');
	process.env.TREESEED_ACCEPTANCE_WORKDAY_ID = workdayId;
	await monitorCampaign({ admittedSimulation: true, now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 30_000)),
		collaboration: () => {}, // Approval and estimates are retained, never recreated or fabricated.
		stop: () => { read(['workdays', 'stop', workdayId, '--yes', '--reason', 'Automated continuation boundary failed',
			'--idempotency-key', `continuation-stop:${workdayId}`], team); },
		read: () => {
			const observed = read(['workdays', 'show', workdayId], team), run = row(observed.run), policy = row(run.parameters);
			assert.equal(run.id, workdayId);
			assert.equal(policy.continueFromWorkdayId, parentId, 'ACCEPTANCE_CONTINUATION_PARENT: Read-back changed lineage');
			const counts = row(observed.scheduling).assignments as Row[];
			const failed = counts?.some(item => ['failed','returned','expired'].includes(String(item.status)) && Number(item.count) > 0);
			return { status: String(run.status), mode: String(run.executionMode), failedBoundary: failed ? 'assignment_failed' : undefined,
				planningEndsAt: Date.parse(String(run.startedAt)) + Number(policy.durationSeconds) * Number(policy.planningPercent) * 10,
				endsAt: Date.parse(String(row(policy.appliedPlan).endsAt)) };
		}, verify: () => {
			const run = row(read(['workdays', 'show', workdayId], team).run);
			const current = readWorkdayAssignments(workdayId, String(run.startedAt), team);
			verifyContinuationResults(current, authority);
			for (const gate of ['results','settlement','reporter'] as const) verifyGolden(gate);
			verifySdkExternalState(frozen);
		} });
});

export function continuationAuthority(assignments: Row[]): { decisionId: string; sourceRef: unknown; authorityRefs: unknown; candidate: string } {
	const actors = assignments.filter(item => item.status === 'completed' && activity(item) === 'acting');
	assert.deepEqual(new Set(actors.map(itemId)), new Set(['research-context','architecture-contract','tests-first','implement-change','document-change']),
		'ACCEPTANCE_CONTINUATION_FRONTIER: Five useful Actor outputs must precede release');
	const decisions = [...new Set(actors.map(item => String(item.decisionId)))];
	assert.equal(decisions.length, 1, 'ACCEPTANCE_CONTINUATION_DECISION: One exact accepted decision required');
	assert.ok(decisions[0] && decisions[0] !== 'null' && decisions[0] !== 'undefined');
	const writer = actors.filter(item => itemId(item) === 'document-change').sort((a,b) => String(a.completedAt).localeCompare(String(b.completedAt))).at(-1)!;
	assert.ok(assignments.some(item => item.status === 'completed' && activity(item) === 'reviewing' && itemId(item) === 'document-change'
		&& row(row(item.lifecycleOutput).activityCompletion).reviewDisposition === 'approved' && String(item.createdAt) > String(writer.completedAt)),
		'ACCEPTANCE_CONTINUATION_REVIEW: Latest candidate requires its own approval');
	const refs = row(writer.assignmentResult).references as Row[];
	const candidate = String(refs?.find(ref => ref.kind === 'git' && ref.repository === 'treeseed-ai/sdk')?.commit ?? '');
	assert.match(candidate, /^[a-f0-9]{40}$/u, 'ACCEPTANCE_CONTINUATION_CANDIDATE: Exact approved Git candidate required');
	const attempt = row(writer.assignmentAttempt);
	return { decisionId: decisions[0]!, sourceRef: attempt.sourceRef, authorityRefs: attempt.authorityRefs, candidate };
}

export function verifyContinuationResults(assignments: Row[], authority: ReturnType<typeof continuationAuthority>): void {
	const actors = assignments.filter(item => activity(item) === 'acting');
	assert.equal(actors.length, 1, 'ACCEPTANCE_CONTINUATION_REPLAY: Completed Actors must not be executed again');
	const actor = actors[0]!;
	assert.equal(itemId(actor), 'simulate-release');
	assert.equal(actor.status, 'completed');
	assert.equal(actor.decisionId, authority.decisionId);
	const attempt = row(actor.assignmentAttempt);
	assert.deepEqual(attempt.sourceRef, authority.sourceRef, 'ACCEPTANCE_CONTINUATION_SOURCE: Proposal revision changed');
	assert.deepEqual(attempt.authorityRefs, authority.authorityRefs, 'ACCEPTANCE_CONTINUATION_DECISION: Decision authority changed');
	assert.equal(row(attempt.workspace).baseCommit, authority.candidate, 'ACCEPTANCE_CONTINUATION_CANDIDATE: Approved predecessor lost');
	assert.ok(assignments.some(item => item.status === 'completed' && activity(item) === 'reviewing' && itemId(item) === 'simulate-release'
		&& item.decisionId === authority.decisionId && row(row(item.lifecycleOutput).activityCompletion).reviewDisposition === 'approved'),
		'ACCEPTANCE_CONTINUATION_RELEASE_REVIEW: Releaser requires a genuine paired approval');
}
