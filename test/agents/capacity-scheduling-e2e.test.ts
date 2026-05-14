import { describe, expect, it } from 'vitest';
import { runCapacitySchedulingEndToEndVerification } from '../../src/agents/testing/capacity-scheduling-e2e.ts';

describe('capacity scheduling end-to-end verification harness', () => {
	it('proves classification, admission, routing, learning, planning, interruption, backfill, and hybrid metadata', async () => {
		const result = await runCapacitySchedulingEndToEndVerification();

		expect(result.ok).toBe(true);
		expect(result.taskCount).toBeGreaterThanOrEqual(8);
		expect(result.queuedTaskCount).toBeGreaterThanOrEqual(5);
		expect(result.eventKinds).toEqual(expect.arrayContaining([
			'classified',
			'admission_decided',
			'queued',
			'plan_proposed',
			'plan_materialized',
			'plan_partially_admitted',
			'checkpoint_started',
			'checkpointed',
			'continuation_required',
			'deferred_for_budget',
		]));
		expect(result.admissionOutcomes).toEqual(expect.arrayContaining([
			'admitted',
			'planning_required',
			'deferred',
		]));
		expect(result.routingDecisionCount).toBeGreaterThan(0);
		expect(result.reservationCount).toBeGreaterThan(0);
		expect(result.usageActualCount).toBe(2);
		expect(result.estimateProfileCount).toBeGreaterThan(0);
		expect(result.learnedDraftEstimateCredits).toBe(7);
		expect(result.completedDraftProfileCreditsP90).toBe(7);
		expect(result.interruptedDraftSampleCount).toBe(1);
		expect(result.planning).toMatchObject({
			proposedCount: 3,
			admittedCount: 2,
			deferredCount: 1,
			materializedCount: 2,
		});
		expect(result.backfill).toMatchObject({
			firstAdmittedTaskSignature: 'workflow.dispatch',
			idledWithoutUsefulWork: true,
			predictiveReserveBlocked: true,
		});
		expect(result.checkpoint).toMatchObject({
			state: 'continuation_required',
			partialUsageExcludedFromCompletedCost: true,
		});
		expect(result.hybrid).toMatchObject({
			phaseCount: 3,
			escalationAdmitted: true,
		});
		expect(result.metadata).toMatchObject({
			hasAttentionSnapshot: true,
			hasUtilitySnapshot: true,
			hasPredictiveReserveSnapshot: true,
			hasHybridSnapshot: true,
			hasCandidateScores: true,
		});
	});
});
