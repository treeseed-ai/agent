import {verifyPlanningWindow} from './workday/support/monitoring/assignment-allocation.ts';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import type { GraphRevision } from '@treeseed/sdk/agent-capacity';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyObservedCampaignFailure, monitorCampaign, openSdkCampaignDiscussion, requirePlanningWindow, retainCampaignWorkdayStart, retainCampaignPlanReview, requireCampaignSimulation, requireFreshSdkSegment } from './campaign.ts';
import { verifyFreezeIntegrity } from './freeze-integrity.ts';
import { read, row } from './acceptance-cli.ts';
import { verifyGolden } from './sdk-runtime-golden.test.ts';
import { prepareSdkCampaign, verifySdkExternalState } from './prepare-campaign.ts';
import { observeLiveGraphRevisions } from './workday/support/monitoring/live-graph-revisions.ts';
import { observeCampaign, retainCampaignEventHistory, verifyAssignmentTransitionHistory, verifyNodeTransitionHistory, verifyAccountingTransitionHistory, verifyWorkdayLifecycleTransitionHistory } from './workday/support/campaign-observation.ts';
import { readCompleteEvidence } from './workday/support/evidence-pages.ts';
import { observeLiveAssignmentRecords, inspectLiveAssignmentProfile } from './workday/support/monitoring/live-assignment-records.ts';

type Row = Record<string, any>;
test('Frozen SDK campaign drives planning acting review and terminal golden gates', { timeout: 36_000_000 }, async () => {
 try {
	const path = process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;
	assert.ok(path, 'ACCEPTANCE_FREEZE_REQUIRED: Explicit immutable campaign freeze required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	if (!existsSync(path) && process.env.TREESEED_ACCEPTANCE_DRAFT_PATH)
		await prepareSdkCampaign(process.env.TREESEED_ACCEPTANCE_DRAFT_PATH, path, team);
	const freeze = JSON.parse(readFileSync(path, 'utf8')) as Row;
	verifyFreezeIntegrity(freeze, readFileSync);
	const body = freeze.request?.body as Row, allocation = body?.allocation as Row;
	requireCampaignSimulation(freeze, path, text => { retainCampaignPlanReview(text, path, freeze); console.error(text); });
	requireFreshSdkSegment(freeze);
	assert.equal(body?.projects?.length, 1, 'ACCEPTANCE_CAMPAIGN_PROJECT: Individual SDK campaign only');
	assert.equal(body?.projects[0], '8cbfb810-6da5-4da2-9ae9-cad53101253f', 'ACCEPTANCE_CAMPAIGN_PROJECT: Exact seeded SDK identity required');
	assert.deepEqual(body.proposalIds, [freeze.proposal?.id], 'ACCEPTANCE_CAMPAIGN_PROPOSAL: Exact frozen proposal required');
	assert.equal(freeze.proposal.estimates, 0, 'ACCEPTANCE_CAMPAIGN_FRESH: No reused estimates');
	assert.equal(body.durationSeconds, 3600);
	assert.equal(allocation?.planningPercent, 100 / 3);
	assert.equal(allocation?.allocationWeight, 1);
	assert.equal(allocation?.planningTurnMaximumSeconds, 180);
	requirePlanningWindow(body.durationSeconds, allocation.planningPercent, allocation.planningTurnMaximumSeconds);
	// Current complete external authority must pass before any metered admission.
	await verifySdkExternalState(freeze);
	// API validates first admission expiry and replays the exact cached start after expiry.
	const originalGraph=structuredClone(read(['execution','graph','show'],team));
	console.log(JSON.stringify({observedAt:new Date().toISOString(),preAdmissionGraph:originalGraph}));
	const started = read(['workdays', 'start', '--preflight', freeze.preflight.id, '--digest', freeze.preflight.preflightDigest,
		'--yes', '--idempotency-key', `golden-start:${freeze.preflight.id}`], team);
	const workdayId = started.workdayId;
	assert.ok(typeof workdayId === 'string' && /^workday-[a-f0-9-]+$/u.test(workdayId), 'ACCEPTANCE_CAMPAIGN_ID: Supported start omitted exact run');
	const stop = () => { read(['workdays', 'stop', workdayId, '--yes', '--reason', 'Automated golden boundary failed',
		'--idempotency-key', `golden-stop:${workdayId}`], team); };
	let externallyApproved = false;
	const observedEvents = new Map<string, Record<string, unknown>>();
 const recordEvent=(event:Record<string,unknown>)=>console.log(JSON.stringify({workdayId,observedAt:new Date().toISOString(),event}));
	const observedAssignments = new Map<string, Record<string, unknown>>();
	const observedGraphRevisions = new Map<number, GraphRevision>();
	let currentRun: Record<string, unknown> | undefined;
	await monitorCampaign({ admittedSimulation: true, reportPlanReview: text => { retainCampaignPlanReview(text,path,freeze); console.error(text); }, admitDiscussion: () => {
		retainCampaignWorkdayStart(started, path, freeze);
		return openSdkCampaignDiscussion(freeze.proposal.id, workdayId,
		(channel, request, key) => read(['send', channel, request.message, '--proposal', request.proposalId!,
			'--workday', request.parentWorkdayId!, '--no-wait', '--idempotency-key', key], team, false, 240_000)); }, read: () => {
		const observed = read(['workdays', 'show', workdayId], team);
		const snapshot = observeCampaign(observed, workdayId, observedEvents, (cursor, limit) =>
			read(['workdays', 'events', 'list', workdayId, '--limit', String(limit), '--cursor', cursor], team),recordEvent);
		const current = snapshot.run as Row, failedBoundary = snapshot.failedBoundary;
		currentRun = current;
		return { status: current.status, mode: current.executionMode, failedBoundary,
			planningEndsAt: Date.parse(current.startedAt) + current.parameters.durationSeconds * current.parameters.planningPercent * 10,
			endsAt: Date.parse(current.parameters.appliedPlan.endsAt) };
	}, inspect: async () => {
		assert.ok(currentRun, 'ACCEPTANCE_LIVE_ASSIGNMENT: Original observed workday required');
		requireFreshSdkSegment(freeze,currentRun);
  const inspectionEndsAt=Date.now()+120_000;
  const accounting=()=>({usage:body.projects.flatMap((project:string)=>readCompleteEvidence(['capacity','usage','--project',project,'--workday',workdayId],team,100,'ACCEPTANCE_ACCOUNTING_USAGE')),ledger:body.projects.flatMap((project:string)=>readCompleteEvidence(['capacity','ledger','--project',project,'--workday',workdayId],team,100,'ACCEPTANCE_ACCOUNTING_LEDGER'))});
		await observeLiveGraphRevisions(String(currentRun.teamId), () => read(['execution', 'graph', 'show'], team),
			cursor => read(['execution', 'graph', 'watch', '--cursor', cursor], team), observedGraphRevisions,
			(revision, graphHead) => console.log(JSON.stringify({ workdayId, observedAt: new Date().toISOString(), graphRevision: revision, graphHead })), {baseline:originalGraph,proposalId:String(freeze.proposal.id),projectId:String(body.projects[0]),workdayId});
  let assignments=readCompleteEvidence(['assignments','list','--workday',workdayId],team,50,'ACCEPTANCE_LIVE_ASSIGNMENT');
  const seen=new Set(observedEvents.keys());let complete=false;
  for(let round=0;round<40;round++){
   assert.ok(Date.now()<=inspectionEndsAt,'ACCEPTANCE_LIVE_ASSIGNMENT: Original inspection bound elapsed');
   const heldGraph=read(['execution','graph','show'],team),heldAccounting=accounting();
   const events=readCompleteEvidence(['workdays','events','list',workdayId],team,100,'ACCEPTANCE_OBSERVATION','ascending');
   retainCampaignEventHistory(events,currentRun,observedEvents,recordEvent);verifyAssignmentTransitionHistory(currentRun,assignments,events);
   const known=new Map(assignments.map(item=>[String(item.id),item])),refresh=new Set<string>();
   for(const event of events)if(typeof event.assignmentId==='string'&&(!known.has(event.assignmentId)||(!seen.has(String(event.id))&&typeof event.eventType==='string'&&event.eventType.startsWith('assignment.'))))refresh.add(event.assignmentId);
   for(const event of events)seen.add(String(event.id));
   if(!refresh.size){
    const freshGraph=read(['execution','graph','show'],team),freshAccounting=accounting();if(!isDeepStrictEqual(heldGraph,freshGraph)||!isDeepStrictEqual(heldAccounting,freshAccounting))continue;
    verifyWorkdayLifecycleTransitionHistory(currentRun,events);
    verifyAccountingTransitionHistory(currentRun,assignments,heldAccounting.usage,heldAccounting.ledger,events);
    verifyNodeTransitionHistory(currentRun,heldGraph,events);complete=true;break;
   }
   for(const id of refresh){const next=read(['assignments','show',id],team);assert.equal(next.id,id,'ACCEPTANCE_LIVE_ASSIGNMENT: Foreign concurrent observation');const prior=known.get(id);
    if(prior){assert.deepEqual(next.assignmentAttempt,prior.assignmentAttempt,'ACCEPTANCE_LIVE_ASSIGNMENT: Concurrent issued authority changed');assert.ok(Number.isSafeInteger(next.stateVersion)&&Number(next.stateVersion)>=Number(prior.stateVersion),'ACCEPTANCE_LIVE_ASSIGNMENT: Concurrent owning version regressed');}
    known.set(id,next);
   }
   assignments=[...known.values()]; // Preserve original public list rows; re-read history after fresh roots.
  }
  assert.ok(complete,'ACCEPTANCE_LIVE_ASSIGNMENT: Complete concurrent transition inventory not reached');
		const inspectedRun=currentRun;
		observeLiveAssignmentRecords(inspectedRun, assignments, observedAssignments, item => { verifyPlanningWindow(item,inspectedRun); inspectLiveAssignmentProfile(item, team, assignments, { 'treeseed-ai/sdk': row(freeze.sourceHeads).sdk }); });
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
		verify: async () => { for (const gate of ['lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter'] as const) verifyGolden(gate);
			await verifySdkExternalState(freeze); } });
 } catch(failure) { throw classifyObservedCampaignFailure(failure); }
});
